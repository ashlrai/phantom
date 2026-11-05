import type { DriveNodes, JobClaim } from './index.js';
import type { NodeAuth } from './state.js';

export class UsageError extends Error {
  constructor(readonly code: string, message: string, readonly fix: string, readonly exit = 2) { super(message); }
}

const LEASE = ['--job', '--node', '--session', '--token', '--leader-token'];
/** Flags each verb accepts; anything else is refused, never ignored. `--json` is always allowed. */
const FLAGS: Record<string, { value: string[]; boolean?: string[] }> = {
  join: { value: ['--node', '--owner', '--caps', '--slots'] },
  beat: { value: ['--node', '--session', '--usage', '--auth', '--slots'], boolean: ['--probe-auth'] },
  enqueue: { value: ['--job', '--owner', '--requires', '--pack', '--secrets'] },
  plan: { value: ['--owner'] },
  pull: { value: ['--node', '--session'] },
  renew: { value: LEASE },
  complete: { value: [...LEASE, '--result'] },
  status: { value: ['--owner'] },
  list: { value: ['--owner'] },
  leave: { value: ['--node', '--session'] },
};

export function parseNodeFleetFlags(verb: string, args: string[]): Map<string, string> {
  const allowed = FLAGS[verb]!;
  const flags = new Map<string, string>();
  for (let i = 0; i < args.length; i++) {
    const [name, inline] = args[i]!.split(/=(.*)/s, 2) as [string, string | undefined];
    if (flags.has(name)) throw new UsageError('duplicate-flag', 'A flag was given twice.', 'Pass each flag once.');
    if ((name === '--json' || allowed.boolean?.includes(name)) && inline === undefined) flags.set(name, '');
    else if (allowed.value.includes(name)) {
      const value = inline ?? args[++i];
      if (value === undefined || value.startsWith('--')) {
        throw new UsageError('missing-value', `${name} needs a value.`, `Run: phm node --help`);
      }
      flags.set(name, value);
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

export function runNodeFleet(verb: string, flags: Map<string, string>, nodes: DriveNodes, probeAuth: () => NodeAuth): Record<string, unknown> {
  const session = (): { nodeId: string; session: number } => ({ nodeId: need(flags, '--node'), session: num(flags, '--session') });
  const stale = new UsageError('session-expired', 'That node session is not live (it expired, left, or was replaced).',
    'Rejoin with: phm node join --node <id> --owner <scope>; then use the new session.', 1);
  switch (verb) {
    case 'join': {
      const owners = csv(need(flags, '--owner'));
      const caps = csv(flags.get('--caps'));
      const joined = nodes.join(need(flags, '--node'), { owners, caps,
        ...(flags.has('--slots') ? { slots: num(flags, '--slots') } : {}) });
      if (!joined) throw new UsageError('node-live', 'A live node already uses that ID.',
        'Pick another --node, wait for its lease to expire, or run phm node leave from that node.', 1);
      return { nodeId: joined.nodeId, session: joined.session, owners: [...new Set(owners)].sort(), caps: [...new Set(caps)].sort() };
    }
    case 'beat': {
      const auth = flags.has('--probe-auth') ? probeAuth() : flags.get('--auth');
      if (auth !== undefined && !['ok', 'missing', 'unknown'].includes(auth)) {
        throw new UsageError('bad-auth', '--auth must be ok, missing or unknown.', 'Use --probe-auth to check this machine\'s own gh login.');
      }
      const usage = flags.has('--usage') ? num(flags, '--usage') : undefined;
      const s = session();
      const beat = nodes.heartbeat(s, { ...(flags.has('--slots') ? { slots: num(flags, '--slots') } : {}), ...(usage === undefined ? {} : { usage }), ...(auth === undefined ? {} : { auth: auth as NodeAuth }) });
      if (!beat) throw stale;
      return { nodeId: s.nodeId, leader: beat.leader?.nodeId === s.nodeId, ...(auth === undefined ? {} : { auth }) };
    }
    case 'enqueue': {
      const jobId = need(flags, '--job');
      const added = nodes.enqueue(jobId, { owner: need(flags, '--owner'), requires: csv(flags.get('--requires')),
        ...(flags.has('--pack') ? { pack: flags.get('--pack')! } : {}), secrets: csv(flags.get('--secrets')) });
      return { jobId, enqueued: added };
    }
    case 'plan': return { routes: nodes.plan(flags.get('--owner')) };
    case 'pull': {
      const pulled = nodes.pull(session());
      if (!pulled) return { pulled: false };
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
    case 'list':
    case 'status': return { ...nodes.view(csv(need(flags, '--owner'))) };
    default: {
      const left = nodes.leave(session());
      return { nodeId: need(flags, '--node'), left };
    }
  }
}

/** Shared by the SSH endpoint, retaining the existing strict parser and scoped views. */
export function executeNodeFleet(verb: string, args: string[], nodes: DriveNodes): Record<string, unknown> {
  if (!Object.hasOwn(FLAGS, verb)) throw new Error('Invalid drive node operation');
  return runNodeFleet(verb, parseNodeFleetFlags(verb, args), nodes, () => 'unknown');
}
