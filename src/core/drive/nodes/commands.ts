import { createHash } from 'node:crypto';
import type { DriveNodes, JobClaim } from './index.js';
import type { NodeAuth, NodeCapacitySample } from './state.js';
import { isNodeCapacity, isHostStats, validCap, validId, validSecretName } from './state.js';
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
        if (value.length > 4000 || Buffer.byteLength(text) > NODE_TASK_LIMIT) {
          throw new UsageError('bad-task', 'Invalid embedded node task: --task-part is limited to 4000 characters per part and 16 KiB in total.',
            'Split the task into smaller --task-part values or shorten it. Run: phm node --help');
        }
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
/** Integer flag under the store's documented ceiling (slots 0-64, usage permille
 * 0-1000). Out-of-range is bad usage — exit 2 naming the flag — never the masked
 * store failure the DriveNodes bound check would surface as. */
const boundedNum = (flags: Map<string, string>, name: string, max: number, fix: string): number => {
  const value = num(flags, name);
  if (value > max) throw new UsageError(`bad-${name.slice(2)}`, `${name} must be an integer from 0 to ${max}.`, fix);
  return value;
};
const SLOTS_FIX = 'Pass only the concurrent job slots this machine can run at once; 0 holds admission. Run: phm node --help';
const USAGE_FIX = '--usage is self-reported load in permille: 0 idle, 1000 saturated. Run: phm node --help';

/** Flag values that name registry objects must satisfy the store's own rules;
 * a malformed one is bad usage — exit 2 naming the flag — never the masked
 * store failure the same DriveNodes check would surface as. Owner scope is a
 * comma list on join/status/list but a single scope on plan/enqueue/withdraw/
 * result, so the helpers are applied per verb, not per flag name. */
const ID_FIX = 'Ids start with a letter or digit and use only letters, digits and . _ : / - (200 characters max). Run: phm node --help';
const CAP_FIX = 'Capabilities start with a lowercase letter or digit and use only lowercase letters, digits and . _ : - (64 characters max). Run: phm node --help';
const SECRET_FIX = 'Secret flags take NAMES such as DEPLOY_KEY, never values. Run: phm node --help';
const LIST_FIX = 'Separate entries with commas; at most 64 entries. Run: phm node --help';

const badFlag = (name: string, message: string, fix: string): UsageError =>
  new UsageError(`bad-${name.slice(2)}`, message, fix);

const needId = (flags: Map<string, string>, name: string): string => {
  const value = need(flags, name);
  if (!validId(value)) throw badFlag(name, `${name} is not a valid id.`, ID_FIX);
  return value;
};
const optId = (flags: Map<string, string>, name: string): string | undefined => {
  const value = flags.get(name);
  if (value !== undefined && !validId(value)) throw badFlag(name, `${name} is not a valid id.`, ID_FIX);
  return value;
};
const needIdList = (flags: Map<string, string>, name: string): string[] => {
  const items = csv(need(flags, name));
  if (items.length === 0 || items.length > 64 || !items.every(validId)) {
    throw badFlag(name, `${name} must be a comma-separated list of 1-64 ids.`, `${ID_FIX} ${LIST_FIX}`);
  }
  return items;
};
const optCapList = (flags: Map<string, string>, name: string): string[] => {
  const items = csv(flags.get(name));
  if (items.length > 64 || !items.every(validCap)) {
    throw badFlag(name, `${name} must be a comma-separated list of up to 64 capabilities.`, `${CAP_FIX} ${LIST_FIX}`);
  }
  return items;
};
const optSecretList = (flags: Map<string, string>, name: string): string[] => {
  const items = csv(flags.get(name));
  if (items.length > 64 || !items.every(validSecretName)) {
    throw badFlag(name, `${name} must be a comma-separated list of up to 64 secret NAMES such as DEPLOY_KEY, never values.`, SECRET_FIX);
  }
  return items;
};

function claimOf(flags: Map<string, string>): JobClaim {
  return { nodeId: needId(flags, '--node'), session: num(flags, '--session'), jobId: needId(flags, '--job'),
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
  const session = (): { nodeId: string; session: number } => ({ nodeId: needId(flags, '--node'), session: num(flags, '--session') });
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
      const owners = needIdList(flags, '--owner');
      const caps = optCapList(flags, '--caps');
      const nodeId = needId(flags, '--node');
      const joined = nodes.join(nodeId, { owners, caps,
        ...(flags.has('--slots') ? { slots: boundedNum(flags, '--slots', 64, SLOTS_FIX) } : {}) });
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
      const usage = flags.has('--usage') ? boundedNum(flags, '--usage', 1000, USAGE_FIX) : undefined;
      const s = session();
      const beat = nodes.heartbeat(s, { ...(capacity === undefined ? {} : { capacity }), ...(isHostStats(hostStats) ? { hostStats } : {}), ...(flags.has('--slots') ? { slots: boundedNum(flags, '--slots', 64, SLOTS_FIX) } : {}), ...(usage === undefined ? {} : { usage }), ...(auth === undefined ? {} : { auth: auth as NodeAuth }) });
      if (!beat) throw stale(s.nodeId, s.session);
      return { nodeId: s.nodeId, leader: beat.leader?.nodeId === s.nodeId, ...(auth === undefined ? {} : { auth }) };
    }
    case 'enqueue': {
      const jobId = needId(flags, '--job');
      const owner = needId(flags, '--owner');
      const requires = optCapList(flags, '--requires');
      const pack = optId(flags, '--pack');
      const secrets = optSecretList(flags, '--secrets');
      let task;
      if (flags.has('--task-part') || flags.has('--task-sha256')) {
        const text = need(flags, '--task-part');
        const digest = need(flags, '--task-sha256');
        if (!/^sha256:[0-9a-f]{64}$/.test(digest)) {
          throw new UsageError('bad-task-sha256', 'Invalid embedded node task: --task-sha256 must be sha256: followed by 64 lowercase hex characters.',
            'Digest the exact --task-part text, for example: printf %s "$TASK" | shasum -a 256. Run: phm node --help');
        }
        const sha256 = digest.slice(7);
        if (createHash('sha256').update(text, 'utf8').digest('hex') !== sha256) {
          throw new UsageError('bad-task-sha256', 'Invalid embedded node task: --task-sha256 does not match the --task-part text.',
            'Recompute the digest over the exact text being sent; the store refuses a mismatch. Run: phm node --help');
        }
        task = { text, sha256 };
        if (!validNodeTask(task)) {
          throw new UsageError('bad-task', 'Invalid embedded node task: the text must be non-empty UTF-8 of at most 16 KiB and carry no secret-shaped strings.',
            'Pass plain task text within those limits. Run: phm node --help');
        }
        if (pack !== 'codex-file') {
          throw new UsageError('bad-pack', 'Invalid embedded node task: an embedded task requires --pack codex-file.',
            'Add --pack codex-file, or drop --task-part/--task-sha256. Run: phm node --help');
        }
      }
      const added = nodes.enqueue(jobId, { owner, requires,
        ...(pack === undefined ? {} : { pack }), secrets, ...(task ? { task } : {}) });
      return { jobId, enqueued: added };
    }
    case 'plan': return { routes: nodes.plan(optId(flags, '--owner')) };
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
    case 'withdraw': {
      const jobId = needId(flags, '--job');
      return { jobId, ...nodes.withdraw(jobId, needId(flags, '--owner')) };
    }
    case 'result': {
      // Read-only: the owner reads back what a completed job answered, or the
      // live state while it is still pending or running. Never a fence.
      const jobId = needId(flags, '--job');
      return { jobId, ...nodes.jobOutcome(jobId, needId(flags, '--owner')) };
    }
    case 'list':
    case 'status': return { ...nodes.view(needIdList(flags, '--owner')) };
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
