/** `phm node join|beat|enqueue|plan|pull|renew|complete|status|leave`: thin handlers over DriveNodes. */
import { hostname } from 'node:os';
import type { NodesStore } from '../core/drive/nodes/index.js';
import { UsageError, parseNodeFleetFlags, runNodeFleet } from '../core/drive/nodes/commands.js';
import { validId, type NodeAuth } from '../core/drive/nodes/state.js';

export interface NodeFleetDeps {
  store?: NodesStore;
  now?: () => number;
  probeAuth?: () => NodeAuth;
  /** This build's version for the join `phm-<version>` cap; defaults to localPhmVersion. */
  phmVersion?: () => string | null;
  /** This computer's hostname for the join `--node` default; defaults to os.hostname. */
  hostname?: () => string;
}


/** Plain-words job state for the status list. `claimedBy` is present only while
 * a live session can still act on the claim, so a running job without it has a
 * lapsed or fenced claim and is routable again once the claim expires. */
function jobStateWords(job: { state: string; claimedBy?: string; completedBy?: string; producerWithdrawn?: true }): string {
  if (job.state === 'running') return job.claimedBy ? `running (claimed by ${job.claimedBy})` : 'running (no live claim)';
  if (job.state === 'completed') {
    if (job.producerWithdrawn) return 'completed (withdrawn by the producer)';
    return job.completedBy ? `completed by ${job.completedBy}` : 'completed';
  }
  return job.state;
}

function text(verb: string, out: Record<string, unknown>): string {
  if (verb === 'join') {
    // Join is the first command every new node runs; its text answer is a
    // sentence, not the key:value dump, and it states the 30-second session
    // expiry the keep-alive exists to beat (docs/add-a-computer.md).
    const owners = out['owners'] as string[];
    const caps = out['caps'] as string[];
    return [
      `Joined ${String(out['nodeId'])} as session ${String(out['session'])} for ${owners.length === 1 ? 'owner' : 'owners'} ${owners.join(', ')} (caps: ${caps.join(', ') || 'none'}).`,
      'The session expires 30 seconds after the last beat. Keep it live:',
      `  ${String(out['next'])}`,
    ].join('\n');
  }
  if (verb === 'plan') {
    const routes = out['routes'] as { jobId: string; nodeId: string | null; fix?: string }[];
    return routes.length ? routes.map(r => `${r.jobId} -> ${r.nodeId ?? `nobody. ${r.fix}`}`).join('\n') : 'No routable jobs.';
  }
  if (verb === 'status' || verb === 'list') {
    const nodes = out['nodes'] as { nodeId: string; live: boolean; usage: number | null; auth: string; caps: string[];
      slots?: number; capacity?: { held?: string | null } }[];
    const jobs = out['jobs'] as { id: string; state: string; claimedBy?: string; completedBy?: string; producerWithdrawn?: true }[];
    const scope = (out['owners'] as string[]).join(',');
    // slots is the advertised admission bound: a reported number (0 holds
    // admission), or 'unbounded' when none was reported — an absent bound is
    // legacy unbounded routing, not a measured zero. held is the last measured
    // capacity hold, shown only while one is reported.
    const lines = [`Owner scope: ${scope}`,
      ...nodes.map(n => `node ${n.nodeId} ${n.live ? 'live' : 'expired'} usage=${n.usage ?? 'unknown'} auth=${n.auth} slots=${n.slots ?? 'unbounded'}${n.capacity?.held ? ` held=${n.capacity.held}` : ''} caps=${n.caps.join(',') || '-'}`),
      ...jobs.map(j => `job ${j.id} ${jobStateWords(j)}`)];
    // An empty scope is the first-run case: say so and print the join command,
    // the same next step `phm node plan` prints for a job with no live node.
    if (!nodes.length) lines.push('No nodes joined in this scope.');
    if (!jobs.length) lines.push('No jobs queued in this scope.');
    if (!nodes.length && !jobs.length && scope) lines.push(`Join this computer: phm node join --owner ${scope}`);
    return lines.join('\n');
  }
  if (verb === 'enqueue') {
    // enqueued:false means the job id is already taken — enqueue is idempotent
    // on the id, so this is a fact, not a failure.
    const jobId = String(out['jobId']);
    return out['enqueued'] === true ? `Enqueued ${jobId}.` : `Job ${jobId} already exists; nothing changed.`;
  }
  if (verb === 'withdraw') {
    const jobId = String(out['jobId']);
    switch (out['state']) {
      case 'withdrawn': return `Job ${jobId} withdrawn: it is terminal and can never run again.`;
      case 'held': return `Job ${jobId} is held by a live claim; withdraw again once the claim lapses or completes.`;
      case 'completed': return `Job ${jobId} already completed.`;
      default: return `Job ${jobId} is absent in this owner scope (unknown id or another owner's job).`;
    }
  }
  if (verb === 'renew') {
    const expires = typeof out['expiresAt'] === 'number' ? new Date(out['expiresAt']).toISOString() : 'unknown';
    return `Renewed ${String(out['jobId'])}; the lease expires ${expires}.`;
  }
  if (verb === 'complete') return `Completed ${String(out['jobId'])}.`;
  if (verb === 'leave') {
    const nodeId = String(out['nodeId']);
    if (out['left'] === true) return `Node ${nodeId} left the registry.`;
    return typeof out['liveSession'] === 'number'
      ? `Node ${nodeId} was not left; it is live as session ${out['liveSession']}. Run: ${String(out['next'])}`
      : `Node ${nodeId} was not left; no live session matches that node and session.`;
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
    const [{ DriveNodes, LocalNodesStore }, { probeLocalAuth }, { ashlrHome }, { canonicalPath, privateDirectory }, { join }, { localPhmVersion, versionCap, versionFromCaps }] = await Promise.all([
      import('../core/drive/nodes/index.js'), import('../core/drive/nodes/auth-probe.js'),
      import('../core/cloud/store.js'), import('../core/universe/artifacts.js'), import('node:path'),
      import('../core/drive/nodes/phm-version.js')]);
    const store: NodesStore = deps.store ?? { transaction: fn => new LocalNodesStore(privateDirectory(canonicalPath(join(ashlrHome(), 'nodes')))).transaction(fn) };
    if (verb === 'join') {
      // A standalone join defaults --node to this computer's sanitized hostname,
      // the same default a pool join applies. Like the version cap below it stays
      // in the CLI layer: runNodeFleet is shared with the SSH endpoint, where the
      // joining worker — not this host — owns the node id it reports. A hostname
      // that cannot form a valid id leaves --node unset so the missing-flag error
      // still asks for one explicitly.
      if (!flags.has('--node')) {
        const id = (deps.hostname ?? hostname)().replace(/[^a-zA-Z0-9_.-]/g, '-').slice(0, 100);
        if (validId(id)) flags.set('--node', id);
      }
      // A standalone join advertises this build as a `phm-<version>` cap, the same
      // report a pool worker sends, so `phm node self-update` reads a real version
      // instead of `unreported`. The node's own build is authoritative: any
      // version-report cap already in --caps (say, copied from an older join hint)
      // is dropped and replaced, never left to report a stale build. This stays in
      // the CLI layer: runNodeFleet is shared with the SSH endpoint, where the
      // joining worker — not this host — owns the version it reports.
      const reported = versionCap((deps.phmVersion ?? localPhmVersion)());
      if (reported !== null) {
        const caps = (flags.get('--caps') ?? '').split(',').map(c => c.trim()).filter(Boolean)
          .filter(c => versionFromCaps([c]) === null);
        caps.push(reported);
        flags.set('--caps', caps.join(','));
      }
    }
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
