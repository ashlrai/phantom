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

/** Flag values are checked against the store's grammar before the store sees
 * them: a malformed value is bad usage (exit 2) naming the rule, never a store
 * 'rejected' — and the value itself is never echoed (secret NAMES included).
 * The store re-checks every rule for direct API and rpc callers. */
const ID_RULE = 'letters, digits and . _ : / - (up to 200 characters, starting with a letter or digit)';
const HELP = 'Run: phm node --help';
const checkId = (value: string, name: string, code: string, noun: string): string => {
  if (!validId(value)) throw new UsageError(code, `${name} is not a valid ${noun}.`, `Use ${ID_RULE}. ${HELP}`);
  return value;
};
const needId = (flags: Map<string, string>, name: string): string => checkId(need(flags, name), name, 'bad-id', 'id');
const optId = (flags: Map<string, string>, name: string): string | undefined => {
  const value = flags.get(name);
  return value === undefined ? undefined : checkId(value, name, 'bad-id', 'id');
};
const needOwner = (flags: Map<string, string>): string => checkId(need(flags, '--owner'), '--owner', 'bad-owner', 'owner scope');
const optOwner = (flags: Map<string, string>): string | undefined => {
  const value = flags.get('--owner');
  return value === undefined ? undefined : checkId(value, '--owner', 'bad-owner', 'owner scope');
};
/** --owner is a comma list on join/status/list and a single scope elsewhere; an
 * empty, over-long or malformed list is bad usage, not an empty view. The store's
 * names() dedupes before its 64-entry bound, so the same happens here. */
const ownerScopes = (flags: Map<string, string>): string[] => {
  const scopes = [...new Set(csv(need(flags, '--owner')))];
  if (!scopes.length || scopes.length > 64 || scopes.some(scope => !validId(scope))) {
    throw new UsageError('bad-owner', '--owner needs 1-64 valid owner scopes.', `Use ${ID_RULE}; separate several scopes with commas. ${HELP}`);
  }
  return scopes;
};
const CAP_RULE = 'lowercase letters, digits and . _ : - (up to 64 characters), like build or pack:codex-file';
const capsArg = (flag: string, value: string | undefined): string[] => {
  const caps = [...new Set(csv(value))];
  if (caps.length > 64 || caps.some(cap => !validCap(cap))) {
    throw new UsageError('bad-cap', `${flag} takes up to 64 lowercase capability names.`, `Use ${CAP_RULE}. ${HELP}`);
  }
  return caps;
};
const secretsArg = (value: string | undefined): string[] => {
  const secrets = [...new Set(csv(value))];
  if (secrets.length > 64 || secrets.some(secret => !validSecretName(secret))) {
    throw new UsageError('bad-secret', '--secrets takes up to 64 secret NAMES, never values.', `Use SCREAMING_SNAKE names like DEPLOY_KEY; secret values are never accepted. ${HELP}`);
  }
  return secrets;
};
/** num() proves digits; the verb's own bound is still a usage error. */
const ranged = (flags: Map<string, string>, name: string, max: number, code: string, rule: string): number | undefined => {
  if (!flags.has(name)) return undefined;
  const value = num(flags, name);
  if (value > max) throw new UsageError(code, `${name} must be a whole number from 0 to ${max}.`, `Use ${rule}. ${HELP}`);
  return value;
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
      const owners = ownerScopes(flags);
      const caps = capsArg('--caps', flags.get('--caps'));
      const nodeId = needId(flags, '--node');
      const slots = ranged(flags, '--slots', 64, 'bad-slots', 'a whole number from 0 to 64');
      const joined = nodes.join(nodeId, { owners, caps, ...(slots === undefined ? {} : { slots }) });
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
      const usage = ranged(flags, '--usage', 1000, 'bad-usage', 'a load permille from 0 (idle) to 1000 (saturated)');
      const slots = ranged(flags, '--slots', 64, 'bad-slots', 'a whole number from 0 to 64');
      const s = session();
      const beat = nodes.heartbeat(s, { ...(capacity === undefined ? {} : { capacity }), ...(isHostStats(hostStats) ? { hostStats } : {}), ...(slots === undefined ? {} : { slots }), ...(usage === undefined ? {} : { usage }), ...(auth === undefined ? {} : { auth: auth as NodeAuth }) });
      if (!beat) throw stale(s.nodeId, s.session);
      return { nodeId: s.nodeId, leader: beat.leader?.nodeId === s.nodeId, ...(auth === undefined ? {} : { auth }) };
    }
    case 'enqueue': {
      const jobId = needId(flags, '--job');
      let task;
      if (flags.has('--task-part') || flags.has('--task-sha256')) {
        const text = need(flags, '--task-part');
        const digest = need(flags, '--task-sha256');
        if (!/^sha256:[0-9a-f]{64}$/.test(digest)) throw new Error('Invalid embedded node task');
        task = { text, sha256: digest.slice(7) };
        if (!validNodeTask(task)) throw new Error('Invalid embedded node task');
      }
      const pack = optId(flags, '--pack');
      const added = nodes.enqueue(jobId, { owner: needOwner(flags), requires: capsArg('--requires', flags.get('--requires')),
        ...(pack === undefined ? {} : { pack }), secrets: secretsArg(flags.get('--secrets')), ...(task ? { task } : {}) });
      return { jobId, enqueued: added };
    }
    case 'plan': return { routes: nodes.plan(optOwner(flags)) };
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
      const claim = claimOf(flags);
      const result = flags.get('--result') ?? '';
      if (Buffer.byteLength(result) > 64 * 1024) {
        throw new UsageError('bad-result', '--result must be at most 64 KiB.', 'Pass a short result reference; keep details in the job artifacts. Run: phm node --help');
      }
      const done = nodes.complete(claim, result);
      if (!done) throw new UsageError('lease-lost', 'Completion refused: the lease is gone or the job is already complete.',
        'Discard this run\'s result. Another node holds a newer token or the job finished.', 1);
      return { jobId: claim.jobId, completed: true };
    }
    case 'release': {
      if (!nodes.release(claimOf(flags), flags.has('--decline'))) throw new UsageError('lease-lost', 'Release refused: the lease is gone or the job is already complete.',
        'Nothing to hand back. Another node holds a newer token or the job finished.', 1);
      return { jobId: need(flags, '--job'), released: true, declined: flags.has('--decline') };
    }
    case 'withdraw': {
      const jobId = needId(flags, '--job');
      return { jobId, ...nodes.withdraw(jobId, needOwner(flags)) };
    }
    case 'list':
    case 'status': return { ...nodes.view(ownerScopes(flags)) };
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
