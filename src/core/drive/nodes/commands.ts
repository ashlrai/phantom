import type { DriveNodes, JobClaim } from './index.js';
import type { NodeAuth, NodeCapacitySample } from './state.js';
import { isNodeCapacity, isHostStats, validId } from './state.js';
import { NODE_TASK_LIMIT, validNodeTask } from './task.js';

export class UsageError extends Error {
  constructor(readonly code: string, message: string, readonly fix: string, readonly exit = 2) { super(message); }
}

const LEASE = ['--job', '--node', '--session', '--token', '--leader-token'];
/** Flags each verb accepts; anything else is refused, never ignored. `--json` is always allowed. */
const FLAGS: Record<string, { value: string[]; boolean?: string[] }> = {
  join: { value: ['--node', '--owner', '--caps', '--slots'] },
  beat: { value: ['--node', '--session', '--usage', '--auth', '--slots', '--host-stats', '--capacity'], boolean: ['--probe-auth'] },
  enqueue: { value: ['--job', '--owner', '--requires', '--pack', '--secrets', '--task-part', '--task-sha256'] },
  plan: { value: ['--owner'] },
  pull: { value: ['--node', '--session'] },
  renew: { value: LEASE },
  complete: { value: [...LEASE, '--result'] },
  release: { value: LEASE, boolean: ['--decline'] },
  withdraw: { value: ['--job', '--owner'] },
  result: { value: ['--job', '--owner'] },
  status: { value: ['--owner'] },
  list: { value: ['--owner'] },
  leave: { value: ['--node', '--session'] },
};

export function parseNodeFleetFlags(verb: string, args: string[]): Map<string, string> {
  const allowed = FLAGS[verb]!;
  const flags = new Map<string, string>();
  for (let i = 0; i < args.length; i++) {
    const [name, inline] = args[i]!.split(/=(.*)/s, 2) as [string, string | undefined];
    if (flags.has(name) && name !== '--task-part') throw new UsageError('duplicate-flag', 'A flag was given twice.', 'Pass each flag once.');
    if ((name === '--json' || allowed.boolean?.includes(name)) && inline === undefined) flags.set(name, '');
    else if (allowed.value.includes(name)) {
      const value = inline ?? args[++i];
      if (value === undefined || (inline === undefined && value.startsWith('--'))) {
        throw new UsageError('missing-value', `${name} needs a value.`, `Run: phm node --help`);
      }
      if (name === '--task-part') {
        // Task text is carried in bounded parts and reassembled here; errors never echo it.
        const text = (flags.get(name) ?? '') + value;
        if (value.length > 4000 || Buffer.byteLength(text) > NODE_TASK_LIMIT) throw new Error('Invalid embedded node task');
        flags.set(name, text);
      } else flags.set(name, value);
    } else throw new UsageError('unknown-flag', `That flag is not supported by 'phm node ${verb}'.`, 'Run: phm node --help for the flags each verb takes.');
  }
  return flags;
}

const need = (flags: Map<string, string>, name: string): string => {
  const value = flags.get(name);
  if (value === undefined) throw new UsageError('missing-flag', `${name} is required.`, `Add ${name} <value>. Run: phm node --help`);
  return value;
};

const csv = (value: string | undefined): string[] => (value ? value.split(',').map(v => v.trim()).filter(Boolean) : []);
const num = (flags: Map<string, string>, name: string): number => {
  const raw = need(flags, name);
  if (!/^\d{1,15}$/.test(raw)) throw new UsageError('bad-number', `${name} must be a non-negative integer.`, `Pass the number printed by phm node join or pull.`);
  return Number(raw);
};

function claimOf(flags: Map<string, string>): JobClaim {
  return { nodeId: need(flags, '--node'), session: num(flags, '--session'), jobId: need(flags, '--job'),
    token: num(flags, '--token'), leaderToken: num(flags, '--leader-token'), expiresAt: 0 };
}

/** Rejoin command for a dead session's fix text: a concrete `--node` whenever the
 * id is valid, the last advertised `--owner`/`--caps`/`--slots` while the registry
 * still holds the record, placeholders when it does not. Only id-valid node ids
 * are inlined, so the hint can never carry shell metacharacters into a paste. */
function joinHint(nodes: DriveNodes, nodeId: string): string {
  if (!validId(nodeId)) return 'phm node join --node <id> --owner <scope>';
  const profile = nodes.nodeProfile(nodeId);
  if (!profile) return `phm node join --node ${nodeId} --owner <scope>`;
  return ['phm node join', `--node ${nodeId}`,
    profile.owners.length ? `--owner ${profile.owners.join(',')}` : '--owner <scope>',
    ...(profile.caps?.length ? [`--caps ${profile.caps.join(',')}`] : []),
    ...(profile.slots === undefined ? [] : [`--slots ${profile.slots}`])].join(' ');
}

/** The session a node id is live under right now, or null. Read-only, and used
 * only to point a refusal at the real recovery command. join and pull already
 * print session numbers on this host, the state directory is private, and the
 * pool rpc masks refusal text before it crosses SSH, so naming the live session
 * here exposes nothing a local caller could not already read. A failed read
 * degrades to the rejoin hint rather than replacing the refusal. */
function liveSession(nodes: DriveNodes, nodeId: string): number | null {
  try {
    const state = nodes.snapshot();
    const node = state.nodes.find(n => n.nodeId === nodeId);
    return node !== undefined && node.expiresAt > state.observedAt ? node.session : null;
  } catch { return null; }
}

export function runNodeFleet(verb: string, flags: Map<string, string>, nodes: DriveNodes, probeAuth: () => NodeAuth): Record<string, unknown> {
  const session = (): { nodeId: string; session: number } => ({ nodeId: need(flags, '--node'), session: num(flags, '--session') });
  const stale = (nodeId: string, attempted?: number) => {
    const live = liveSession(nodes, nodeId);
    return new UsageError('session-expired',
      `Node '${nodeId}' has no live session (it expired, left, or was replaced).`,
      live !== null && live !== attempted
        ? `Node '${nodeId}' is live as session ${live}: retry with --session ${live}, or run phm node leave --node ${nodeId} --session ${live} and rejoin.`
        : `Rejoin with: ${joinHint(nodes, nodeId)}; then use the new session.`, 1);
  };
  switch (verb) {
    case 'join': {
      const owners = csv(need(flags, '--owner'));
      const caps = csv(flags.get('--caps'));
      const nodeId = need(flags, '--node');
      const joined = nodes.join(nodeId, { owners, caps,
        ...(flags.has('--slots') ? { slots: num(flags, '--slots') } : {}) });
      if (!joined) {
        const live = liveSession(nodes, nodeId);
        throw new UsageError('node-live', 'A live node already uses that ID.',
          live === null ? 'Pick another --node, wait for its lease to expire, or run phm node leave from that node.'
            : `It is live as session ${live}: keep it with --session ${live} on beat, pull and leave, or run phm node leave --node ${nodeId} --session ${live} to replace it.`, 1);
      }
      return { nodeId: joined.nodeId, session: joined.session, owners: [...new Set(owners)].sort(), caps: [...new Set(caps)].sort() };
    }
    case 'beat': {
      let hostStats: unknown;
      if (flags.has('--host-stats')) {
        try { const raw = flags.get('--host-stats')!; hostStats = raw.length <= 128 * 1024 ? JSON.parse(raw) : null; } catch { hostStats = null; }
        if (!isHostStats(hostStats)) throw new UsageError('bad-host-stats', 'Host stats must be a numeric host observation.', 'Use the node worker to collect host stats.');
      }
      // --capacity is the documented `$(phm node measure)` paste, so a bad value
      // is a usage error naming the flag — never the masked store failure a
      // bare JSON.parse or shape Error would surface as downstream.
      let capacity: NodeCapacitySample | undefined;
      if (flags.has('--capacity')) {
        let parsed: unknown;
        try { parsed = JSON.parse(flags.get('--capacity')!); }
        catch {
          throw new UsageError('bad-capacity', '--capacity must be one JSON object.',
            'Run: phm node measure, then pass its output unchanged: --capacity "$(phm node measure)". Omit --capacity when measure exits 1.');
        }
        if (!isNodeCapacity(parsed)) {
          throw new UsageError('bad-capacity', '--capacity is not a valid node capacity sample.',
            'Pass the object `phm node measure` prints, unchanged: --capacity "$(phm node measure)". Omit --capacity when measure exits 1.');
        }
        capacity = parsed;
      }
      const auth = flags.has('--probe-auth') ? probeAuth() : flags.get('--auth');
      if (auth !== undefined && !['ok', 'missing', 'unknown'].includes(auth)) {
        throw new UsageError('bad-auth', '--auth must be ok, missing or unknown.', 'Use --probe-auth to check this machine\'s own gh login.');
      }
      const usage = flags.has('--usage') ? num(flags, '--usage') : undefined;
      const s = session();
      const beat = nodes.heartbeat(s, { ...(capacity === undefined ? {} : { capacity }), ...(isHostStats(hostStats) ? { hostStats } : {}), ...(flags.has('--slots') ? { slots: num(flags, '--slots') } : {}), ...(usage === undefined ? {} : { usage }), ...(auth === undefined ? {} : { auth: auth as NodeAuth }) });
      if (!beat) throw stale(s.nodeId, s.session);
      return { nodeId: s.nodeId, leader: beat.leader?.nodeId === s.nodeId, ...(auth === undefined ? {} : { auth }) };
    }
    case 'enqueue': {
      const jobId = need(flags, '--job');
      let task;
      if (flags.has('--task-part') || flags.has('--task-sha256')) {
        const text = need(flags, '--task-part');
        const digest = need(flags, '--task-sha256');
        if (!/^sha256:[0-9a-f]{64}$/.test(digest)) throw new Error('Invalid embedded node task');
        task = { text, sha256: digest.slice(7) };
        if (!validNodeTask(task)) throw new Error('Invalid embedded node task');
      }
      const added = nodes.enqueue(jobId, { owner: need(flags, '--owner'), requires: csv(flags.get('--requires')),
        ...(flags.has('--pack') ? { pack: flags.get('--pack')! } : {}), secrets: csv(flags.get('--secrets')), ...(task ? { task } : {}) });
      return { jobId, enqueued: added };
    }
    case 'plan': return { routes: nodes.plan(flags.get('--owner')) };
    case 'pull': {
      const s = session();
      const pulled = nodes.pull(s);
      if (!pulled) {
        // A dead session and an empty route both answer null; only a live
        // session may hear "no job" — a stale one must rejoin first.
        if (!nodes.sessionLive(s)) throw stale(s.nodeId, s.session);
        return { pulled: false };
      }
      const { claim, job } = pulled;
      return { pulled: true, job, claim: { jobId: claim.jobId, nodeId: claim.nodeId, session: claim.session,
        token: claim.token, leaderToken: claim.leaderToken, expiresAt: claim.expiresAt } };
    }
    case 'renew': {
      const claim = nodes.renewClaim(claimOf(flags));
      if (!claim) throw new UsageError('lease-lost', 'The lease is gone: it expired, was reassigned, or the leader changed. Stop work on this job.',
        'Do not run effects for it. Pull again; a newer token fences this one.', 1);
      return { jobId: claim.jobId, expiresAt: claim.expiresAt };
    }
    case 'complete': {
      const done = nodes.complete(claimOf(flags), flags.get('--result') ?? '');
      if (!done) throw new UsageError('lease-lost', 'Completion refused: the lease is gone or the job is already complete.',
        'Discard this run\'s result. Another node holds a newer token or the job finished.', 1);
      return { jobId: need(flags, '--job'), completed: true };
    }
    case 'release': {
      if (!nodes.release(claimOf(flags), flags.has('--decline'))) throw new UsageError('lease-lost', 'Release refused: the lease is gone or the job is already complete.',
        'Nothing to hand back. Another node holds a newer token or the job finished.', 1);
      return { jobId: need(flags, '--job'), released: true, declined: flags.has('--decline') };
    }
    case 'withdraw': return { jobId: need(flags, '--job'), ...nodes.withdraw(need(flags, '--job'), need(flags, '--owner')) };
    case 'result': {
      // Read-only: the owner reads back what a completed job answered, or the
      // live state while it is still pending or running. Never a fence.
      const jobId = need(flags, '--job');
      return { jobId, ...nodes.jobOutcome(jobId, need(flags, '--owner')) };
    }
    case 'list':
    case 'status': return { ...nodes.view(csv(need(flags, '--owner'))) };
    default: {
      const s = session();
      const left = nodes.leave(s);
      if (left) return { nodeId: s.nodeId, left };
      // A refused leave is silent today: name the live session so the operator
      // can retry with it or replace the node, instead of a bare `left:false`.
      const live = liveSession(nodes, s.nodeId);
      return { nodeId: s.nodeId, left,
        ...(live === null || live === s.session ? {} : { liveSession: live,
          next: `phm node leave --node ${s.nodeId} --session ${live}` }) };
    }
  }
}

/** Shared by the SSH endpoint, retaining the existing strict parser and scoped views. */
export function executeNodeFleet(verb: string, args: string[], nodes: DriveNodes): Record<string, unknown> {
  if (!Object.hasOwn(FLAGS, verb)) throw new Error('Invalid drive node operation');
  return runNodeFleet(verb, parseNodeFleetFlags(verb, args), nodes, () => 'unknown');
}
