/**
 * `phm node work --node <id> --session <n>`: pull the job the router assigned
 * this session and, when it is a `codex-file` job this runner can execute, run
 * it under the job's lease — heartbeating the node session and renewing the
 * claim on an interval — then complete it with the pack's result reference.
 * The first production caller of the contract `codex-file` pack: credentials
 * never leave this machine (codex runs under the local login in a fresh
 * scratch directory) and jobs carry secret NAMES only, which this runner
 * cannot supply, so a job naming secrets is declined back to pending.
 *
 * A job `work` cannot run — another pack, a missing/invalid embedded task, or
 * required secret names — is released with `--decline`: the decline bars only
 * this session, so the next pull takes the next routed job instead of
 * re-claiming the same unrunnable one, and a rejoin clears it. That is the
 * documented "a pack the node cannot run" release, not a permanent ban.
 *
 * One job per call; run the command again for the next. Standalone registry
 * only — a pool Mac's jobs live on the primary and run through
 * `phm node worker`/`run-once`.
 */
import type { DriveNodes, JobClaim, NodesStore } from '../core/drive/nodes/index.js';
import type { NodeAuth } from '../core/drive/nodes/state.js';
import { CODEX_FILE_PACK, runCodexFilePack, type CodexFileDeps, type CodexFileReply } from '../core/drive/nodes/codex-pack.js';
import { validNodeTask } from '../core/drive/nodes/task.js';
import { UsageError } from '../core/drive/nodes/commands.js';
import { pullIdleMessage } from './node-fleet.js';
import { probeLocalAuth } from '../core/drive/nodes/auth-probe.js';

export interface NodeWorkDeps {
  /** Test seam: an existing DriveNodes (e.g. over a MemoryStore with short TTLs). */
  drive?: DriveNodes;
  store?: NodesStore;
  now?: () => number;
  /** gh login probe forwarded to the pull path; defaults to the local check. */
  probeAuth?: () => NodeAuth;
  /** Test seam for the pack itself; defaults to runCodexFilePack. */
  runPack?: (request: { jobId: string; task: string }, deps?: CodexFileDeps) => Promise<CodexFileReply>;
  /** Test seam forwarded to the pack (home, spawn, resolveBinary, timeoutMs). */
  packDeps?: CodexFileDeps;
  /** Session+claim+leader keepalive cadence; the leader lease is the shortest at 10 s. */
  keepaliveMs?: number;
  /** External stop (tests); SIGINT/SIGTERM abort the run in production. */
  signal?: AbortSignal;
  log?: (line: string) => void;
  error?: (line: string) => void;
}

// The binding lease is the leader's 10 s TTL: a claim's leaderToken must match
// the live leader at every renew/complete, and the leader only extends while
// a heartbeat lands before it lapses. 5 s leaves a full tick of margin.
const KEEPALIVE_MS = 5_000;

/** `work` takes only the pull flags plus --json; anything else is refused. */
function parseWorkFlags(args: string[]): { nodeId: string; session: number; json: boolean } {
  const fail = (message: string): never => { throw new UsageError('usage', message, 'Run: phm node work --help'); };
  const flags = new Map<string, string>();
  let json = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--json') {
      if (json) fail('A flag was given twice.');
      json = true;
      continue;
    }
    const eq = arg.indexOf('=');
    const name = eq === -1 ? arg : arg.slice(0, eq);
    if (name !== '--node' && name !== '--session') fail(`That flag is not supported by 'phm node work'.`);
    if (flags.has(name)) fail('A flag was given twice.');
    const value = eq === -1 ? args[++i] : arg.slice(eq + 1);
    if (value === undefined || (eq === -1 && value.startsWith('--'))) fail(`${name} needs a value.`);
    flags.set(name, value);
  }
  const nodeId = flags.get('--node') ?? fail('--node is required.');
  const sessionRaw = flags.get('--session') ?? fail('--session is required.');
  if (!/^\d{1,15}$/.test(sessionRaw)) fail('--session must be a non-negative integer.');
  return { nodeId, session: Number(sessionRaw), json };
}

/** Lease flags for the release/complete calls runNodeFleet parses; `decline`
 * adds the boolean flag the release verb reads (bar this session from the job). */
function leaseFlags(claim: JobClaim, extra: Record<string, string> = {}): Map<string, string> {
  return new Map([['--job', claim.jobId], ['--node', claim.nodeId], ['--session', String(claim.session)],
    ['--token', String(claim.token)], ['--leader-token', String(claim.leaderToken)], ...Object.entries(extra)]);
}

const PACK_ERROR_FIX: Record<string, string> = {
  'binary-unavailable': 'The codex CLI was not found on this machine — install it and sign in (`codex login`), or rejoin without the codex cap.',
  'scratch-unavailable': 'The per-job scratch directory under ~/.ashlr-runs could not be created — check that it is writable and private.',
  'codex-spawn-failed': 'The codex process could not be started — check the codex install and try again.',
  'codex-timeout': 'The codex run hit its time limit or was stopped — the job is pending again for another attempt.',
  'codex-exit-nonzero': 'codex exited non-zero — the job is pending again; inspect the task or codex login and retry.',
  'result-write-failed': 'The result artifact under ~/.ashlr-runs/node-results could not be written — check that it is writable and private.',
  'invalid-request': 'The job failed validation — report this; the store should never hold an invalid embedded task.',
  'receipt-mismatch': 'The codex binary changed mid-run — retry the job.',
};

export async function cmdNodeWork(args: string[], deps: NodeWorkDeps = {}): Promise<number> {
  const log = deps.log ?? ((line: string) => console.log(line));
  const errorOut = deps.error ?? ((line: string) => console.error(line));
  const json = args.includes('--json');
  let parsed: { nodeId: string; session: number };
  try {
    parsed = parseWorkFlags(args);
  } catch (error) {
    const message = error instanceof UsageError ? error.message : 'Invalid arguments.';
    const fix = error instanceof UsageError ? error.fix : 'Run: phm node work --help';
    if (json) log(JSON.stringify({ schemaVersion: 1, command: 'work', error: { code: 'usage', message, fix } }));
    else errorOut(`${message} Fix: ${fix}`);
    return 2;
  }
  const { nodeId, session } = parsed;
  const emit = (body: Record<string, unknown>, text: string, code: number): number => {
    if (json) log(JSON.stringify({ schemaVersion: 1, command: 'work', ...body }));
    else if (code === 0) log(text);
    else errorOut(text);
    return code;
  };
  try {
    const { hasNodePool } = await import('./node-pool.js');
    if (hasNodePool()) {
      if (json) log(JSON.stringify({ schemaVersion: 1, command: 'work', error: { code: 'usage',
        message: 'work runs codex-file jobs on the standalone registry; this Mac is in a node pool.',
        fix: 'Pool jobs run through the worker: phm node worker --runner /absolute/host-owned-runner --json' } }));
      else errorOut('work runs codex-file jobs on the standalone registry; this Mac is in a node pool — pool jobs run through phm node worker/run-once.');
      return 2;
    }
    let drive = deps.drive;
    if (!drive) {
      const [{ DriveNodes, LocalNodesStore }, { ashlrHome }, { canonicalPath, privateDirectory }, { join }] = await Promise.all([
        import('../core/drive/nodes/index.js'), import('../core/cloud/store.js'), import('../core/universe/artifacts.js'), import('node:path')]);
      const store: NodesStore = deps.store ?? { transaction: fn => new LocalNodesStore(privateDirectory(canonicalPath(join(ashlrHome(), 'nodes')))).transaction(fn) };
      drive = new DriveNodes(store, deps.now ? { now: deps.now } : {});
    }
    const nodes = drive;
    const { runNodeFleet } = await import('../core/drive/nodes/commands.js');
    const probeAuth = deps.probeAuth ?? probeLocalAuth;
    // The pull path owns stale-session and empty-route diagnostics; work only
    // continues when it returns a claim.
    const pulled = runNodeFleet('pull', new Map([['--node', nodeId], ['--session', String(session)]]), nodes, probeAuth, { rejoinWatch: true });
    if (pulled['pulled'] !== true) {
      return emit({ ...pulled }, pullIdleMessage(pulled), 0);
    }
    const claim = pulled['claim'] as JobClaim;
    const job = pulled['job'] as { pack?: string; secrets?: string[]; task?: unknown };
    /** Hand the claim back. `decline` bars this session from the job so the
     * next pull takes the next routed job instead of re-claiming this one;
     * a rejoin clears it. Release failure means the lease is already dead —
     * the report stays honest either way. */
    const release = (flags: Record<string, string>, body: Record<string, unknown>, text: string): number => {
      try { runNodeFleet('release', leaseFlags(claim, flags), nodes, probeAuth, { rejoinWatch: true }); }
      catch { /* the lease may already be fenced; the job is not ours to release */ }
      return emit(body, text, 0);
    };
    if (job.pack !== CODEX_FILE_PACK || !validNodeTask(job.task)) {
      const pack = typeof job.pack === 'string' ? job.pack : 'unknown';
      return release({ '--decline': '' }, { worked: false, reason: 'unsupported-job', jobId: claim.jobId, pack },
        `Released ${claim.jobId} (pack '${pack}'); work runs codex-file jobs only. It is pending again and this session will not be offered it — run it with your own runner (phm node pull, then complete) or let another node take it.`);
    }
    if (job.secrets !== undefined && job.secrets.length > 0) {
      return release({ '--decline': '' }, { worked: false, reason: 'needs-secrets', jobId: claim.jobId, secrets: job.secrets },
        `Released ${claim.jobId}; it needs secret NAMES ${job.secrets.join(', ')} which this runner cannot supply — jobs carry names, never values, and the pack injects none. It is pending again and this session will not be offered it — run it with your own runner.`);
    }
    // Keep the node session and the job lease alive for the run's duration;
    // either dying fences the claim, so the first failure aborts codex.
    const run = new AbortController();
    const onExternal = () => run.abort();
    // addEventListener does not fire retroactively on an already-aborted signal.
    if (deps.signal?.aborted) run.abort();
    else deps.signal?.addEventListener('abort', onExternal, { once: true });
    const onSigint = () => run.abort();
    const onSigterm = () => run.abort();
    process.once('SIGINT', onSigint);
    process.once('SIGTERM', onSigterm);
    let fenced = false;
    const nodeSession = { nodeId: claim.nodeId, session: claim.session };
    const keepalive = setInterval(() => {
      if (run.signal.aborted) return;
      try {
        if (!nodes.heartbeat(nodeSession) || !nodes.renewClaim(claim)) { fenced = true; run.abort(); }
      } catch { fenced = true; run.abort(); }
    }, deps.keepaliveMs ?? KEEPALIVE_MS);
    keepalive.unref();
    let reply: CodexFileReply;
    try {
      reply = await (deps.runPack ?? runCodexFilePack)(
        { jobId: claim.jobId, task: (job.task as { text: string }).text },
        { ...(deps.packDeps ?? {}), signal: run.signal });
    } catch {
      reply = { codex: 'error', packError: 'codex-spawn-failed' };
    } finally {
      clearInterval(keepalive);
      deps.signal?.removeEventListener('abort', onExternal);
      process.off('SIGINT', onSigint);
      process.off('SIGTERM', onSigterm);
    }
    if (fenced || run.signal.aborted) {
      try { runNodeFleet('release', leaseFlags(claim), nodes, probeAuth, { rejoinWatch: true }); } catch { /* claim already fenced */ }
      return emit({ worked: false, reason: 'lease-lost', jobId: claim.jobId },
        `Lease lost while ${claim.jobId} ran; the codex child was stopped and nothing was completed. Rejoin and pull again.`, 1);
    }
    if (reply.codex !== 'ok') {
      const fix = PACK_ERROR_FIX[reply.packError] ?? 'The codex-file pack failed; the job is pending again.';
      try { runNodeFleet('release', leaseFlags(claim), nodes, probeAuth, { rejoinWatch: true }); } catch { /* claim already fenced */ }
      return emit({ worked: false, reason: 'pack-error', jobId: claim.jobId, packError: reply.packError },
        `codex-file ${claim.jobId} failed (${reply.packError}). ${fix}`, 1);
    }
    try {
      runNodeFleet('complete', leaseFlags(claim, { '--result': reply.resultRef }), nodes, probeAuth, { rejoinWatch: true });
    } catch (error) {
      const detail = error instanceof UsageError ? error.message : 'Completion refused.';
      return emit({ worked: false, reason: 'lease-lost', jobId: claim.jobId },
        `codex-file ${claim.jobId} finished but completion was refused: ${detail} The result artifact stays local under ~/.ashlr-runs/node-results.`, 1);
    }
    return emit({ worked: true, jobId: claim.jobId, resultRef: reply.resultRef, completed: true },
      `Worked ${claim.jobId} (codex-file); result ${reply.resultRef}.`, 0);
  } catch (error) {
    const known = error instanceof UsageError;
    const operatorMessage = /^(?:Invalid |Drive |(?:Universe|Private) storage|Unsafe drive|Cannot create filesystem root)/;
    const message = error instanceof Error && (known || operatorMessage.test(error.message)) ? error.message : 'Node store unavailable or invalid.';
    const fix = known ? error.fix : 'Check that the node store is a private (0700) directory you own, and that no other process holds its lock.';
    const code = known ? error.code : 'rejected';
    if (json) log(JSON.stringify({ schemaVersion: 1, command: 'work', error: { code, message, fix } }));
    else errorOut(`${message} Fix: ${fix}`);
    return known ? error.exit : 1;
  }
}
