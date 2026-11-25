/** `phm node join|beat|enqueue|plan|pull|renew|complete|status|leave`: thin handlers over DriveNodes. */
import type { NodesStore } from '../core/drive/nodes/index.js';
import { UsageError, parseNodeFleetFlags, runNodeFleet } from '../core/drive/nodes/commands.js';
import type { NodeAuth } from '../core/drive/nodes/state.js';

export interface NodeFleetDeps {
  store?: NodesStore;
  now?: () => number;
  probeAuth?: () => NodeAuth;
}


function text(verb: string, out: Record<string, unknown>): string {
  if (verb === 'plan') {
    const routes = out['routes'] as { jobId: string; nodeId: string | null; fix?: string }[];
    return routes.length ? routes.map(r => `${r.jobId} -> ${r.nodeId ?? `nobody. ${r.fix}`}`).join('\n') : 'No routable jobs.';
  }
  if (verb === 'status' || verb === 'list') {
    const nodes = out['nodes'] as { nodeId: string; live: boolean; usage: number | null; auth: string; caps: string[] }[];
    const jobs = out['jobs'] as { id: string; state: string }[];
    return [`Owner scope: ${(out['owners'] as string[]).join(',')}`,
      ...nodes.map(n => `node ${n.nodeId} ${n.live ? 'live' : 'expired'} usage=${n.usage ?? 'unknown'} auth=${n.auth} caps=${n.caps.join(',') || '-'}`),
      ...jobs.map(j => `job ${j.id} ${j.state}`)].join('\n');
  }
  if (verb === 'pull') {
    if (!out['pulled']) return 'No job for this node. Run: phm node plan';
    // Text mode must carry everything a manual runner needs to work the lease:
    // the claim's fencing tokens (renew/complete refuse without them), the job's
    // requirements and secret NAMES, the embedded task text, and paste-ready
    // commands — the --json envelope is not the only way through the lifecycle.
    const claim = out['claim'] as { jobId: string; nodeId: string; session: number; token: number; leaderToken: number; expiresAt: number };
    const job = out['job'] as { owner?: string; requires?: string[]; pack?: string; secrets?: string[]; task?: { text?: unknown } } | undefined;
    const facts = [
      job?.owner === undefined ? null : `owner ${job.owner}`,
      job?.requires?.length ? `requires ${job.requires.join(',')}` : null,
      job?.pack === undefined ? null : `pack ${job.pack}`,
      job?.secrets?.length ? `secrets ${job.secrets.join(',')}` : null,
    ].filter((fact): fact is string => fact !== null);
    const lease = `--job ${claim.jobId} --node ${claim.nodeId} --session ${claim.session} --token ${claim.token} --leader-token ${claim.leaderToken}`;
    const lines = [
      `Claimed ${claim.jobId}${facts.length ? ` (${facts.join('; ')})` : ''}.`,
      `Lease token ${claim.token}, leader-token ${claim.leaderToken}; expires ${new Date(claim.expiresAt).toISOString()}. Renew before expiry; pass the token to every effect.`,
    ];
    if (typeof job?.task?.text === 'string' && job.task.text.length) lines.push('', 'Task:', job.task.text);
    lines.push('', `Run: phm node renew ${lease}`, `Done? Run: phm node complete ${lease} --result <text>`);
    return lines.join('\n');
  }
  if (verb === 'result') {
    const jobId = String(out['jobId']), state = out['state'];
    if (state === 'absent') return `job ${jobId}: absent (no such job in this owner scope)`;
    if (state === 'pending') return `job ${jobId}: pending`;
    if (state === 'running') return `job ${jobId}: running${out['claimedBy'] ? ` (claimed by ${out['claimedBy']})` : ''}`;
    const head = out['producerWithdrawn'] === true ? 'withdrawn by the producer'
      : `completed by ${String(out['completedBy'] ?? 'unknown')}`;
    const when = typeof out['completedAt'] === 'number' ? ` at ${new Date(out['completedAt']).toISOString()}` : '';
    const body = typeof out['result'] === 'string' && out['result'].length ? `\n${out['result']}` : '';
    return `job ${jobId}: ${head}${when}${body}`;
  }
  return Object.entries(out).map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(',') : String(v)}`).join('\n');
}

export async function cmdNodeFleet(verb: string, args: string[], deps: NodeFleetDeps = {}): Promise<number> {
  // `--json` is a boolean flag and a standalone `--json` token can never be a
  // flag value (values starting with `--` are refused), so argv alone proves
  // the caller asked for JSON even when flag parsing fails first.
  const json = args.includes('--json');
  try {
    const flags = parseNodeFleetFlags(verb, args);
    if (!deps.store) {
      const { cmdNodePool, hasNodePool } = await import('./node-pool.js');
      if (hasNodePool()) return cmdNodePool(verb, args);
    }
    // Parsing happens first and the store modules load after it, so a usage error never touches (or creates) state.
    const [{ DriveNodes, LocalNodesStore }, { probeLocalAuth }, { ashlrHome }, { canonicalPath, privateDirectory }, { join }] = await Promise.all([
      import('../core/drive/nodes/index.js'), import('../core/drive/nodes/auth-probe.js'),
      import('../core/cloud/store.js'), import('../core/universe/artifacts.js'), import('node:path')]);
    const store: NodesStore = deps.store ?? { transaction: fn => new LocalNodesStore(privateDirectory(canonicalPath(join(ashlrHome(), 'nodes')))).transaction(fn) };
    const out = runNodeFleet(verb, flags, new DriveNodes(store, deps.now ? { now: deps.now } : {}), deps.probeAuth ?? probeLocalAuth);
    // Standalone join names its keep-alive beat. This stays out of runNodeFleet:
    // pool replies already carry their own `next` (the worker command) and a
    // `next` inside result.result would override it in the spread below. The
    // hint is the --watch loop, the only beat form that keeps the session
    // live past the 30 s expiry; a node that advertised `gh` also gets
    // --probe-auth, because routing refuses gh jobs until a heartbeat reports
    // a working local gh login.
    if (verb === 'join') {
      const caps = out['caps'];
      const probe = Array.isArray(caps) && caps.includes('gh') ? ' --probe-auth' : '';
      out['next'] = `phm node beat --node ${String(out['nodeId'])} --session ${String(out['session'])}${probe} --watch`;
    }
    console.log(json ? JSON.stringify({ schemaVersion: 1, command: verb, ...out }) : text(verb, out));
    return 0;
  } catch (error) {
    const known = error instanceof UsageError;
    // Validation, privacy and lock messages in this stack are fixed operator-facing
    // strings (no values echoed), so they are shown; anything else stays masked.
    const operatorMessage = /^(?:Invalid |Drive |Universe storage|Unsafe drive|Cannot create filesystem root)/;
    const message = error instanceof Error && (known || operatorMessage.test(error.message)) ? error.message : 'Node store unavailable or invalid.';
    const fix = known ? error.fix : /^Invalid drive/.test(message) ? 'Check ids (letters, digits, . _ : / -), caps (lowercase) and secret NAMES (UPPER_SNAKE). Run: phm node --help'
      : 'Check that ~/.ashlr/nodes is a private (0700) directory you own, and that no other process holds its lock.';
    const code = known ? error.code : 'rejected';
    if (json) console.log(JSON.stringify({ schemaVersion: 1, command: verb, error: { code, message, fix } }));
    else console.error(`${message} Fix: ${fix}`);
    return known ? error.exit : 1;
  }
}
