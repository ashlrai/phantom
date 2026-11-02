/** `phm node join|beat|enqueue|plan|pull|renew|complete|status|leave`: thin handlers over DriveNodes. */
import type { DriveNodes, JobClaim, NodesStore } from '../core/drive/nodes/index.js';
import type { NodeAuth } from '../core/drive/nodes/state.js';

export interface NodeFleetDeps {
  store?: NodesStore;
  now?: () => number;
  probeAuth?: () => NodeAuth;
}

class UsageError extends Error {
  constructor(readonly code: string, message: string, readonly fix: string, readonly exit = 2) { super(message); }
}

const LEASE = ['--job', '--node', '--session', '--token', '--leader-token'];
/** Flags each verb accepts; anything else is refused, never ignored. `--json` is always allowed. */
const FLAGS: Record<string, { value: string[]; boolean?: string[] }> = {
  join: { value: ['--node', '--owner', '--caps'] },
  beat: { value: ['--node', '--session', '--usage', '--auth'], boolean: ['--probe-auth'] },
  enqueue: { value: ['--job', '--owner', '--requires', '--pack', '--secrets'] },
  plan: { value: ['--owner'] },
  pull: { value: ['--node', '--session'] },
  renew: { value: LEASE },
  complete: { value: [...LEASE, '--result'] },
  status: { value: ['--owner'] },
  leave: { value: ['--node', '--session'] },
};

function parse(verb: string, args: string[]): Map<string, string> {
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

function run(verb: string, flags: Map<string, string>, nodes: DriveNodes, probeAuth: () => NodeAuth): Record<string, unknown> {
  const session = (): { nodeId: string; session: number } => ({ nodeId: need(flags, '--node'), session: num(flags, '--session') });
  const stale = new UsageError('session-expired', 'That node session is not live (it expired, left, or was replaced).',
    'Rejoin with: phm node join --node <id> --owner <scope>; then use the new session.', 1);
  switch (verb) {
    case 'join': {
      const owners = csv(need(flags, '--owner'));
      const caps = csv(flags.get('--caps'));
      const joined = nodes.join(need(flags, '--node'), { owners, caps });
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
      const beat = nodes.heartbeat(s, { ...(usage === undefined ? {} : { usage }), ...(auth === undefined ? {} : { auth: auth as NodeAuth }) });
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
    case 'status': return { ...nodes.view(csv(need(flags, '--owner'))) };
    default: {
      const left = nodes.leave(session());
      return { nodeId: need(flags, '--node'), left };
    }
  }
}

function text(verb: string, out: Record<string, unknown>): string {
  const routes = out['routes'] as { jobId: string; nodeId: string | null; fix?: string }[] | undefined;
  if (routes) return routes.length ? routes.map(r => `${r.jobId} -> ${r.nodeId ?? `nobody. ${r.fix}`}`).join('\n') : 'No routable jobs.';
  if (verb === 'status') {
    const nodes = out['nodes'] as { nodeId: string; live: boolean; usage: number; auth: string; caps: string[] }[];
    const jobs = out['jobs'] as { id: string; state: string }[];
    return [`Owner scope: ${(out['owners'] as string[]).join(',')}`,
      ...nodes.map(n => `node ${n.nodeId} ${n.live ? 'live' : 'expired'} usage=${n.usage} auth=${n.auth} caps=${n.caps.join(',') || '-'}`),
      ...jobs.map(j => `job ${j.id} ${j.state}`)].join('\n');
  }
  if (verb === 'pull') return out['pulled'] ? `Claimed ${(out['claim'] as { jobId: string }).jobId}. Renew before expiry; pass the token to every effect.` : 'No job for this node. Run: phm node plan';
  return Object.entries(out).map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(',') : String(v)}`).join('\n');
}

export async function cmdNodeFleet(verb: string, args: string[], deps: NodeFleetDeps = {}): Promise<number> {
  let json = false;
  try {
    const flags = parse(verb, args);
    json = flags.has('--json');
    // Parsing happens first and the store modules load after it, so a usage error never touches (or creates) state.
    const [{ DriveNodes, LocalNodesStore }, { probeLocalAuth }, { ashlrHome }, { privateDirectory }, { join }] = await Promise.all([
      import('../core/drive/nodes/index.js'), import('../core/drive/nodes/auth-probe.js'),
      import('../core/cloud/store.js'), import('../core/universe/artifacts.js'), import('node:path')]);
    const store: NodesStore = deps.store ?? { transaction: fn => new LocalNodesStore(privateDirectory(join(ashlrHome(), 'nodes'))).transaction(fn) };
    const out = run(verb, flags, new DriveNodes(store, deps.now ? { now: deps.now } : {}), deps.probeAuth ?? probeLocalAuth);
    console.log(json ? JSON.stringify({ schemaVersion: 1, command: verb, ...out }) : text(verb, out));
    return 0;
  } catch (error) {
    const known = error instanceof UsageError;
    const message = known ? error.message : error instanceof Error && /^Invalid drive/.test(error.message) ? error.message : 'Node store unavailable or invalid.';
    const fix = known ? error.fix : /^Invalid drive/.test(message) ? 'Check ids (letters, digits, . _ : / -), caps (lowercase) and secret NAMES (UPPER_SNAKE). Run: phm node --help'
      : 'Check that ~/.ashlr/nodes is a private (0700) directory you own, and that no other process holds its lock.';
    const code = known ? error.code : 'rejected';
    if (json) console.log(JSON.stringify({ schemaVersion: 1, command: verb, error: { code, message, fix } }));
    else console.error(`${message} Fix: ${fix}`);
    return known ? error.exit : 1;
  }
}
