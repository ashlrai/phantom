/**
 * ready.tsv -> node-router claim bridge (RQ-NODE-BRIDGE-1).
 *
 * Reuses the claim dispatchd already honors: an O_EXCL `queue/run/<job>.batched`
 * lease whose owner is an `RQ-BATCH-` id with a `queue/batches/<owner>.json`
 * manifest. dispatchd drops a leased row (`SKIP_BATCHED`) and keeps the lease
 * (`LEASE_ORPHANED` frees only manifest-less ones); restock and the batcher skip it.
 * Every lease write happens while this process holds `dispatchd.tick.lock` and
 * `ready.lock`, so a dispatchd tick never sees a half-claimed row. A remote
 * claim is fenced by the router; only a router `withdraw` (fresh fencing token)
 * returns the row to ready.tsv, so a lapsed node can never complete it after.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, constants, existsSync, readFileSync, readdirSync, renameSync, realpathSync, unlinkSync, writeFileSync, writeSync, openSync, fstatSync, readSync } from 'node:fs';
import { join, sep } from 'node:path';
import { NODE_TASK_LIMIT, validNodeTask, nodeTaskArgs, type EmbeddedNodeTask } from './task.js';
import { type DriveNodes, type JobView, type NodeView, type WithdrawOutcome } from './index.js';
import { validCap } from './state.js';
import type { RouteAssignment } from './router.js';
import { scrubSecrets } from '../../util/scrub.js';

export const NODE_BRIDGE_SCHEMA = 'phantom.node-bridge.v1';
/** dispatchd keeps a lease only when its owner starts with RQ-BATCH- and has a manifest. */
export const NODE_BRIDGE_LEASE_PREFIX = 'RQ-BATCH-NODE-';
/** Read-only ready rows map to the runner's `<lane>-file` pack (codex exec, read-only sandbox). */
export const NODE_BRIDGE_READ_ONLY_KINDS = /^RQ-(?:REVIEW|RESEARCH|AUDIT)-/;
/** Code-writing rows need a worktree-capable `<lane>-worktree` pack. Designed, not shipped: inert. */
export const NODE_BRIDGE_WORKTREE_PACK_ENABLED = false;

/** The phm-node-worker/v1 pack a row needs; a node must advertise `pack:<name>` from its runner probe. */
export function remotePackFor(job: string, cap: string): { pack: string; writes: boolean } {
  const writes = !NODE_BRIDGE_READ_ONLY_KINDS.test(job);
  return { pack: `${cap}-${writes ? 'worktree' : 'file'}`, writes };
}
export const NODE_BRIDGE_PENDING_TTL_MS = 5 * 60_000;
export const NODE_BRIDGE_MAX_PER_PASS = 4;
/** One router call's worst case: the node SSH transport's own timeout (ssh.ts). */
export const NODE_BRIDGE_CALL_MS = 12_000;
/** The daemon phase's pass budget, under its 30 s deadline (TICK_PHASE_NODE_BRIDGE_MS). */
export const NODE_BRIDGE_PASS_BUDGET_MS = 25_000;

const JID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const LOCAL_LANES = new Set(['codex-local', 'omlx']);
const HOST_BOUND = ['RQ-FIX-MAIN-', 'RQ-REL-', 'RQ-DESK-', 'RQ-BATCH-'];
const DATA_CLASSES: Record<string, number> = { public: 0, internal: 1, confidential: 2, restricted: 3 };
/** work_market.py's clearance for a remote built-in executor. */
const REMOTE_CLEARANCE = 'internal';
const SPEC_KEYS = new Set(['preferred_lane', 'needs', 'min_tier', 'max_tier', 'max_cost_class', 'data_class', 'work_class',
  'repo', 'exclusive', 'priority', 'impact']);
/** Bounds measured on this host's lanes; a remote node publishes no tier or cost evidence. */
const UNVERIFIABLE = ['min_tier', 'max_tier', 'max_cost_class'];
const CLAIM_MARKERS = ['batched', 'dispatched', 'reaping', 'line'];

export interface NodeBridgeHost { runsRoot: string; wtRoot: string }
export interface ReadyRow { job: string; lane: string; line: string; spec: Record<string, unknown> | null; invalid: string | null }
export interface BridgeRowDecision {
  job: string; lane: string; cap: string | null; pack: string | null; offload: boolean; reasons: string[];
  nodeId: string | null; routerJobId: string | null; requires: string[];
}
export interface BridgeNodeView { nodeId: string; lanes: string[]; slots: number | null; running: number; freeSlots: number | null }
export interface BridgeLeaseView { job: string; leaseOwner: string; routerJobId: string; state: string; routerState: string | null; action: string }
export interface NodeBridgeReport {
  schema: typeof NODE_BRIDGE_SCHEMA; mode: 'dry-run' | 'apply'; owner: string | null;
  /** Reason code the bridge is inert, or null when it may claim. */
  inert: string | null;
  /** Reason an apply pass claimed nothing this time (busy dispatcher tick, abort). */
  held: string | null;
  nodes: BridgeNodeView[]; rows: BridgeRowDecision[]; leases: BridgeLeaseView[];
  claimed: string[]; requeued: string[]; completed: string[]; lostRace: string[];
}
interface BridgeRouterView {
  nodes: NodeView[];
  jobs: JobView[];
  routes?: RouteAssignment[];
}
export interface BridgeRouter {
  scope: string;
  view(owner: string): BridgeRouterView;
  enqueue(jobId: string, spec: { owner: string; requires: string[]; pack: string; task?: EmbeddedNodeTask }): boolean;
  withdraw(jobId: string, owner: string): WithdrawOutcome;
}
export interface DispatcherLock { release(): Promise<void> }
export type AcquireDispatcherLock = (queueDir: string, signal?: AbortSignal) => Promise<DispatcherLock | { busy: string }>;
interface Manifest {
  /** Digest only; the task text is never written to a manifest. */
  taskSha256?: string;
  schema: typeof NODE_BRIDGE_SCHEMA; id: string; job: string; line: string; routerJobId: string; owner: string;
  routerScope?: string; createdAt: number; state: 'claimed' | 'offloaded' | 'completed'; completedAt?: number; result?: string;
}

const queueDir = (h: NodeBridgeHost) => join(h.runsRoot, 'queue');
const runDir = (h: NodeBridgeHost) => join(queueDir(h), 'run');
const batchesDir = (h: NodeBridgeHost) => join(queueDir(h), 'batches');

export function bridgeLeaseOwner(job: string): string {
  return NODE_BRIDGE_LEASE_PREFIX + createHash('sha256').update(job).digest('hex').slice(0, 20);
}

/** The node cap a ready lane needs, or null when the lane only runs on this host or on an API key. */
export function remoteLaneCap(lane: string): string | null {
  if (LOCAL_LANES.has(lane)) return null;
  if (lane === 'codex' || lane.startsWith('codex-')) return 'codex';
  if (lane === 'claude' || (lane.startsWith('claude-') && lane !== 'claude-api')) return 'claude';
  return null;
}

export function parseReadyRow(text: string): ReadyRow | null {
  const line = text.replace(/\r$/, '');
  if (!line.trim() || line.startsWith('#')) return null;
  const f = line.split('\t');
  const job = f[0] ?? '';
  const laneCell = f[2] ?? '';
  // A PARKED- marker in the status or lane cell is a hold, not a candidate —
  // the same cells dispatchd's parked_row() skips. A spec retained from before
  // the park still names preferred_lane, so the check must precede spec use.
  if (/^PARKED-/i.test(f[0]!) || /^PARKED-/i.test(laneCell)) {
    return { job, lane: laneCell, line, spec: null, invalid: 'parked_row' };
  }
  if (f.length < 5 || !JID.test(job)) return { job, lane: laneCell, line, spec: null, invalid: 'invalid_row' };
  let spec: Record<string, unknown> = {};
  if (f.length > 5) {
    try {
      const parsed: unknown = f[5]!.length <= 8192 ? JSON.parse(f[5]!) : null;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || Object.keys(parsed).some(k => !SPEC_KEYS.has(k))) throw new Error('spec');
      spec = parsed as Record<string, unknown>;
    } catch { return { job, lane: f[2]!, line, spec: null, invalid: 'invalid_requirements' }; }
  }
  return { job, lane: f[2]!, line, spec, invalid: null };
}

function routerJobId(job: string, jobs: JobView[]): string {
  const prefix = `ready:${job}:`;
  const attempts = jobs.filter(j => j.id.startsWith(prefix)).map(j => Number(j.id.slice(prefix.length))).filter(Number.isSafeInteger);
  return `${prefix}${attempts.length ? Math.max(...attempts) + 1 : 1}`;
}

/** Pure eligibility plan. Unknown slot telemetry is `null` and never admits a row. */
export function planNodeBridge(input: BridgeRouterView & {
  rows: ReadyRow[]; claimed: (job: string) => boolean; maxPerPass?: number;
}): { nodes: BridgeNodeView[]; rows: BridgeRowDecision[] } {
  const live = input.nodes.filter(n => n.live).sort((a, b) => (a.nodeId < b.nodeId ? -1 : 1));
  const running = (id: string) => input.jobs.filter(j => j.state === 'running' && j.claimedBy === id).length;
  const free = new Map<string, number | null>(live.map(n => [n.nodeId, n.slots === undefined ? null : Math.max(0, n.slots - running(n.nodeId))]));
  // Capacity-reporting nodes on one physical host share its measured slots —
  // the router's nodeCapacityView groups by capacity.hostId the same way. Each
  // node's advertised `slots` already includes host headroom, so free capacity
  // is accounted once per host (the smallest advertisement minus every claim
  // on it), never summed per node; a node without a capacity sample is its own
  // host, which leaves standalone accounting exactly as before.
  const hostOf = (n: NodeView): string => n.capacity?.hostId ?? n.nodeId;
  const hostGroups = new Map<string, NodeView[]>();
  for (const n of live) { const host = hostOf(n); const members = hostGroups.get(host) ?? []; members.push(n); hostGroups.set(host, members); }
  const hostFree = new Map<string, number | null>();
  for (const [host, members] of hostGroups) {
    hostFree.set(host, members.every(m => m.slots !== undefined)
      ? Math.max(0, Math.min(...members.map(m => m.slots!)) - members.reduce((sum, m) => sum + running(m.nodeId), 0))
      : null);
  }
  const reserve = (node: NodeView) => {
    const host = hostOf(node);
    const nodeSlots = free.get(node.nodeId);
    const hostSlots = hostFree.get(host);
    if (nodeSlots != null) free.set(node.nodeId, Math.max(0, nodeSlots - 1));
    if (hostSlots != null) hostFree.set(host, Math.max(0, hostSlots - 1));
  };
  const hasAuth = (node: NodeView, requires: string[]) => !requires.includes('gh') || node.auth === 'ok';
  const take = (requires: string[]): NodeView | null => {
    const fits = live.filter(n => requires.every(c => n.caps.includes(c)) && hasAuth(n, requires) &&
      (free.get(n.nodeId) ?? 0) > 0 && (hostFree.get(hostOf(n)) ?? 0) > 0)
      .sort((a, b) => ((hostFree.get(hostOf(b)) ?? 0) - (hostFree.get(hostOf(a)) ?? 0)) || (a.nodeId < b.nodeId ? -1 : 1));
    if (!fits[0]) return null;
    reserve(fits[0]);
    return fits[0];
  };
  if (input.routes) {
    const byId = new Map(live.map(node => [node.nodeId, node]));
    for (const route of input.routes) {
      const node = route.nodeId === null ? undefined : byId.get(route.nodeId);
      if (node) reserve(node);
    }
  } else {
    // Older router views lack assignments. Keep their capability-based estimate.
    for (const job of input.jobs) if (job.state === 'pending' || (job.state === 'running' && !job.claimedBy)) take(job.requires);
  }
  const nodes = live.map(n => ({ nodeId: n.nodeId, lanes: n.lanes, slots: n.slots ?? null, running: running(n.nodeId), freeSlots: free.get(n.nodeId) ?? null }));
  const limit = input.maxPerPass ?? NODE_BRIDGE_MAX_PER_PASS;
  const seen = new Set<string>();
  let planned = 0;
  const rows = input.rows.map((row): BridgeRowDecision => {
    const spec = row.spec ?? {};
    const lane = typeof spec['preferred_lane'] === 'string' ? spec['preferred_lane'] : row.lane;
    const cap = remoteLaneCap(lane);
    const rawNeeds = spec['needs'];
    const needsValid = rawNeeds === undefined || (Array.isArray(rawNeeds) && rawNeeds.every(n => typeof n === 'string'));
    const needs = Array.isArray(rawNeeds) && needsValid ? rawNeeds as string[] : [];
    const target = cap ? remotePackFor(row.job, cap) : null;
    const requires = cap && target ? [...new Set([cap, `pack:${target.pack}`, ...needs])] : [];
    const reasons: string[] = [];
    if (row.invalid) reasons.push(row.invalid);
    else {
      if (seen.has(row.job)) reasons.push('duplicate_row');
      if (HOST_BOUND.some(p => row.job.startsWith(p))) reasons.push('host_bound_job');
      if (input.claimed(row.job)) reasons.push('local_claim_present');
      if (spec['exclusive'] === true) reasons.push('exclusive');
      if (LOCAL_LANES.has(lane) || LOCAL_LANES.has(row.lane)) reasons.push('local_execution_required');
      else if (!cap) reasons.push('lane_not_remote');
      const dc = spec['data_class'];
      if (dc !== undefined && (typeof dc !== 'string' || !Object.prototype.hasOwnProperty.call(DATA_CLASSES, dc))) reasons.push('data_class_invalid');
      else if (typeof dc === 'string' && DATA_CLASSES[dc]! > DATA_CLASSES[REMOTE_CLEARANCE]!) reasons.push('data_class_exceeded');
      if (UNVERIFIABLE.some(k => spec[k] !== undefined)) reasons.push('requirement_unverifiable');
      if (!needsValid) reasons.push('needs_invalid');
      if (needs.some(n => !validCap(n))) reasons.push('need_not_routable');
    }
    seen.add(row.job);
    let nodeId: string | null = null;
    if (!reasons.length) {
      const capable = live.filter(n => requires.every(c => n.caps.includes(c)));
      const eligible = capable.filter(n => hasAuth(n, requires));
      if (!live.length) reasons.push('no_live_node');
      else if (!live.some(n => cap && n.caps.includes(cap))) reasons.push('lane_mismatch');
      else if (target!.writes && !NODE_BRIDGE_WORKTREE_PACK_ENABLED) reasons.push('pack_inert');
      else if (!live.some(n => n.caps.includes(`pack:${target!.pack}`))) reasons.push('node_pack_unsupported');
      else if (!capable.length) reasons.push('caps_missing');
      else if (!eligible.length) reasons.push('auth_missing');
      else if (eligible.every(n => free.get(n.nodeId) === null)) reasons.push('slots_unknown');
      else if (planned >= limit) reasons.push('pass_limit');
      else nodeId = take(requires)?.nodeId ?? null;
      if (!reasons.length && !nodeId) reasons.push('no_free_slot');
    }
    if (nodeId) planned++;
    return { job: row.job, lane, cap, pack: target?.pack ?? null, offload: !!nodeId, reasons, nodeId,
      routerJobId: nodeId ? routerJobId(row.job, input.jobs) : null, requires: nodeId ? requires : [] };
  });
  return { nodes, rows };
}

function readText(path: string): string | null {
  try { return readFileSync(path, 'utf8'); } catch { return null; }
}

/** Bounded, no-follow read of a ready row's prompt, confined to <queue>/prompts. Errors carry a code, never text. */
function readBridgeTask(host: NodeBridgeHost, row: ReadyRow): EmbeddedNodeTask {
  let fd: number | undefined;
  try {
    const path = row.line.split('\t')[4]!;
    const prompts = join(realpathSync(queueDir(host)), 'prompts');
    if (realpathSync(prompts) !== prompts) throw new Error('task_unavailable');
    if (!realpathSync(path).startsWith(prompts + sep)) throw new Error('task_unavailable');
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    if (!fstatSync(fd).isFile()) throw new Error('task_unavailable');
    if (fstatSync(fd).size > NODE_TASK_LIMIT) throw new Error('task_oversize');
    const bytes = Buffer.alloc(NODE_TASK_LIMIT + 1);
    let size = 0;
    while (size < bytes.length) {
      const n = readSync(fd, bytes, size, bytes.length - size, null);
      if (!n) break;
      size += n;
    }
    if (size > NODE_TASK_LIMIT) throw new Error('task_oversize');
    const content = bytes.subarray(0, size);
    const text = content.toString('utf8');
    if (scrubSecrets(text) !== text) throw new Error('task_secret_shaped');
    const task = { text, sha256: createHash('sha256').update(content).digest('hex') };
    if (!Buffer.from(text).equals(content) || !validNodeTask(task)) throw new Error('task_invalid');
    return task;
  } catch (error) {
    if (error instanceof Error && ['task_oversize', 'task_invalid', 'task_secret_shaped'].includes(error.message)) throw error;
    throw new Error('task_unavailable');
  } finally { if (fd !== undefined) closeSync(fd); }
}

function readRows(host: NodeBridgeHost): { text: string; rows: ReadyRow[] } {
  const text = readText(join(queueDir(host), 'ready.tsv')) ?? '';
  return { text, rows: text.split('\n').map(parseReadyRow).filter((r): r is ReadyRow => r !== null) };
}

function claimedLocally(host: NodeBridgeHost, job: string): boolean {
  return CLAIM_MARKERS.some(s => existsSync(join(runDir(host), `${job}.${s}`))) || existsSync(join(host.wtRoot, job));
}

function readManifests(host: NodeBridgeHost): Manifest[] {
  let names: string[];
  try { names = readdirSync(batchesDir(host)).filter(n => n.startsWith(NODE_BRIDGE_LEASE_PREFIX) && n.endsWith('.json')).sort(); }
  catch { return []; }
  return names.flatMap(name => {
    try {
      const m = JSON.parse(readFileSync(join(batchesDir(host), name), 'utf8')) as Manifest;
      return m?.schema === NODE_BRIDGE_SCHEMA && `${m.id}.json` === name && m.id === bridgeLeaseOwner(m.job) &&
        (m.routerScope === undefined || typeof m.routerScope === 'string') ? [m] : [];
    } catch { return []; }
  });
}

function writeAtomic(path: string, text: string): void {
  const tmp = `${path}.node-bridge.${process.pid}.tmp`;
  writeFileSync(tmp, text, { mode: 0o600, flag: 'w' });
  renameSync(tmp, path);
}

function leaseHeldBy(host: NodeBridgeHost, job: string, owner: string): boolean {
  return readText(join(runDir(host), `${job}.batched`))?.trim() === owner;
}

/** Why the bridge must not claim on this host, or null. Never installs or edits the dispatcher. */
export function nodeBridgeReadiness(host: NodeBridgeHost): string | null {
  if (['KILL', 'PAUSE'].some(n => existsSync(join(host.runsRoot, n))) || existsSync(join(queueDir(host), 'NODE_BRIDGE_OFF'))) return 'stopped';
  if (!existsSync(join(queueDir(host), 'ready.tsv'))) return 'queue-absent';
  const dispatcher = readText(join(host.runsRoot, 'bin', 'dispatchd.py'));
  if (dispatcher === null) return 'dispatcher-absent';
  // The installed dispatcher must honor the lease protocol this bridge relies on.
  if (!dispatcher.includes('SKIP_BATCHED') || !dispatcher.includes('LEASE_ORPHANED') ||
      !dispatcher.includes('dispatchd.tick.lock') || !dispatcher.includes('batcher.BATCH_PREFIX')) return 'dispatcher-lease-unsupported';
  return null;
}

const LOCK_SCRIPT = `import fcntl,sys,time
t=open(sys.argv[1],'a')
try: fcntl.flock(t,fcntl.LOCK_EX|fcntl.LOCK_NB)
except BlockingIOError: print('busy:dispatcher-tick-busy',flush=True); sys.exit(3)
r=open(sys.argv[2],'a'); end=time.monotonic()+float(sys.argv[3])
while True:
  try: fcntl.flock(r,fcntl.LOCK_EX|fcntl.LOCK_NB); break
  except BlockingIOError:
    if time.monotonic()>end: print('busy:ready-lock-busy',flush=True); sys.exit(4)
    time.sleep(0.05)
print('locked',flush=True); sys.stdin.read()`;

/** Holds dispatchd.tick.lock (never waits: a running tick wins) and ready.lock, the same flock(2) locks dispatchd takes. */
export const flockDispatcher: AcquireDispatcherLock = (dir, signal) => new Promise(resolve => {
  let settled = false;
  const child = spawn('python3', ['-c', LOCK_SCRIPT, join(dir, 'dispatchd.tick.lock'), join(dir, 'ready.lock'), '2'],
    { stdio: ['pipe', 'pipe', 'ignore'] });
  const exited = new Promise<void>(done => child.once('close', () => done()));
  const settle = (value: DispatcherLock | { busy: string }) => {
    if (settled) return;
    settled = true; clearTimeout(timer); signal?.removeEventListener('abort', onAbort);
    if ('busy' in value) child.kill();
    resolve(value);
  };
  const onAbort = () => settle({ busy: 'aborted' });
  const timer = setTimeout(() => settle({ busy: 'lock-timeout' }), 5_000);
  signal?.addEventListener('abort', onAbort, { once: true });
  let out = '';
  child.stdout.on('data', (chunk: Buffer) => {
    out += chunk.toString('utf8');
    const first = out.split('\n')[0]!;
    if (!out.includes('\n')) return;
    settle(first === 'locked' ? { release: async () => { child.stdin.end(); await exited; } }
      : { busy: first.startsWith('busy:') ? first.slice(5) : 'lock-helper-unavailable' });
  });
  child.once('error', () => settle({ busy: 'lock-helper-unavailable' }));
  child.once('close', () => settle({ busy: 'lock-helper-unavailable' }));
});

export function localBridgeRouter(nodes: DriveNodes, storeDirectory: string): BridgeRouter {
  return {
    scope: realpathSync(storeDirectory),
    view: owner => nodes.view([owner]),
    enqueue: (jobId, spec) => nodes.enqueue(jobId, spec),
    withdraw: (jobId, owner) => nodes.withdraw(jobId, owner),
  };
}

/** Pool witness transport (`callPool`). A demoted primary never claims. */
export function poolBridgeRouter(call: (verb: string, args: string[]) => { demoted: boolean; result: Record<string, unknown> },
  storeDirectory: string): BridgeRouter {
  const ok = (verb: string, args: string[]) => {
    const reply = call(verb, args);
    if (reply.demoted) throw new Error('Node pool primary is demoted');
    return reply.result;
  };
  return {
    scope: realpathSync(storeDirectory),
    view: owner => ok('status', ['--owner', owner]) as unknown as BridgeRouterView,
    enqueue: (jobId, spec) => ok('enqueue', ['--job', jobId, '--owner', spec.owner, '--requires', spec.requires.join(','), '--pack', spec.pack, ...nodeTaskArgs(spec.task)])['enqueued'] === true,
    withdraw: (jobId, owner) => {
      const r = ok('withdraw', ['--job', jobId, '--owner', owner]);
      if (!['withdrawn', 'held', 'completed', 'absent'].includes(String(r['state']))) throw new Error('Invalid withdraw reply');
      return { state: r['state'] as WithdrawOutcome['state'], ...(typeof r['result'] === 'string' ? { result: r['result'] } : {}) };
    },
  };
}

export interface NodeBridgeOptions {
  host: NodeBridgeHost;
  router: BridgeRouter | null;
  owner: string | null;
  apply: boolean;
  now: number;
  lock?: AcquireDispatcherLock;
  pendingTtlMs?: number;
  maxPerPass?: number;
  signal?: AbortSignal;
  /** Wall-clock end of the pass: no router call starts unless it can finish before it. */
  deadlineAt?: number;
  clock?: () => number;
  /** Overrides host readiness (e.g. a pool backup/worker never claims). */
  inert?: string | null;
}

function leaseAction(m: Manifest, job: JobView | undefined, owner: string | null, scope: string | null, now: number, ttl: number): string {
  if (m.state === 'completed') return 'keep-completed';
  if (m.owner !== owner) return 'hold-owner-mismatch';
  if (m.routerScope === undefined || m.routerScope !== scope) return 'hold-router-mismatch';
  if (!job) return 'requeue';
  if (job.state === 'completed') return job.producerWithdrawn === true ? 'requeue' : 'complete';
  if (job.state === 'running') return 'check-lease';
  return now - m.createdAt >= ttl ? 'withdraw-requeue' : 'wait';
}

/** One bounded bridge pass. Dry-run (`apply: false`) reads only. */
export async function runNodeBridge(opts: NodeBridgeOptions): Promise<NodeBridgeReport> {
  const { host, owner, now } = opts;
  const report: NodeBridgeReport = { schema: NODE_BRIDGE_SCHEMA, mode: opts.apply ? 'apply' : 'dry-run', owner, inert: null, held: null,
    nodes: [], rows: [], leases: [], claimed: [], requeued: [], completed: [], lostRace: [] };
  report.inert = !owner ? 'bridge-owner-unset' : opts.inert !== undefined && opts.inert !== null ? opts.inert
    : nodeBridgeReadiness(host) ?? (opts.router ? null : 'router-unavailable');
  const ttl = opts.pendingTtlMs ?? NODE_BRIDGE_PENDING_TTL_MS;
  const clock = opts.clock ?? Date.now;
  /** Router calls that still fit before the deadline; each may block for NODE_BRIDGE_CALL_MS. */
  const callsLeft = (): number => opts.signal?.aborted ? 0 : opts.deadlineAt === undefined ? Infinity
    : Math.max(0, Math.floor((opts.deadlineAt - clock()) / NODE_BRIDGE_CALL_MS));
  const emptyView = { nodes: [], jobs: [] };
  const readView = (): BridgeRouterView => {
    if (!owner || !opts.router) return emptyView;
    try { return opts.router.view(owner); } catch { report.inert ??= 'router-unavailable'; return emptyView; }
  };
  const recordSnapshot = (view: BridgeRouterView, manifests: Manifest[], fresh: { text: string; rows: ReadyRow[] }) => {
    report.leases = manifests.map(m => {
      const job = view.jobs.find(j => j.id === m.routerJobId);
      return { job: m.job, leaseOwner: m.id, routerJobId: m.routerJobId, state: m.state, routerState: job?.state ?? null,
        action: leaseAction(m, job, owner, opts.router?.scope ?? null, now, ttl) };
    });
    const bridged = new Set(manifests.map(m => m.job));
    const plan = planNodeBridge({ rows: fresh.rows, claimed: j => bridged.has(j) || claimedLocally(host, j),
      ...view, ...(opts.maxPerPass !== undefined ? { maxPerPass: opts.maxPerPass } : {}) });
    report.nodes = plan.nodes;
    report.rows = plan.rows;
    return plan;
  };

  if (!opts.apply || report.inert || !owner || !opts.router) {
    recordSnapshot(readView(), readManifests(host), readRows(host));
    return report;
  }
  if (opts.signal?.aborted) { report.held = 'aborted'; return report; }

  const router = opts.router;
  const lock = await (opts.lock ?? flockDispatcher)(queueDir(host), opts.signal);
  if ('busy' in lock) { report.held = lock.busy; return report; }
  try {
    if (opts.signal?.aborted) { report.held = 'aborted'; return report; }
    const view = readView();
    const manifests = readManifests(host);
    const fresh = readRows(host);
    const plan = recordSnapshot(view, manifests, fresh);
    if (report.inert) return report;

    const requeue: Manifest[] = [];
    for (const m of manifests) {
      const action = report.leases.find(l => l.leaseOwner === m.id)!.action;
      if (action === 'keep-completed' || action === 'wait' || action === 'hold-owner-mismatch' || action === 'hold-router-mismatch') continue;
      // Out of time: the rest wait for the next pass (each lease's action is recomputed then).
      if (callsLeft() < 1) { report.held = 'deadline'; break; }
      let outcome: WithdrawOutcome;
      try { outcome = router.withdraw(m.routerJobId, owner); } catch { continue; }
      if (outcome.state === 'withdrawn' || outcome.state === 'absent') requeue.push(m);
      else if (outcome.state === 'completed') {
        writeAtomic(join(batchesDir(host), `${m.id}.json`), JSON.stringify({ ...m, state: 'completed', completedAt: now, result: (outcome.result ?? '').slice(0, 200) }) + '\n');
        report.completed.push(m.job);
      }
    }

    let claims = plan.rows.filter(r => r.offload);
    if (!requeue.length && !claims.length) return report;
    if (opts.signal?.aborted) { report.held = 'aborted'; return report; }
    // A withdrawn lease is requeued only after a second view; with no time for it, it is
    // requeued by the next pass (its router job is gone, so its action is requeue).
    if (requeue.length && callsLeft() < 1) { report.held = 'deadline'; return report; }

    let safeRequeue = requeue;
    if (requeue.length) {
      let currentView: { nodes: NodeView[]; jobs: JobView[] };
      try { currentView = router.view(owner); } catch {
        report.held = 'router-unavailable';
        return report;
      }
      const currentManifests = readManifests(host);
      safeRequeue = requeue.filter(m => {
        const currentManifest = currentManifests.find(current => current.id === m.id && current.job === m.job &&
          current.line === m.line && current.routerJobId === m.routerJobId && current.owner === m.owner &&
          current.routerScope === m.routerScope && current.routerScope === router.scope);
        if (!currentManifest) return false;
        const job = currentView.jobs.find(current => current.id === m.routerJobId);
        return !job || (job.state === 'completed' && job.producerWithdrawn === true);
      });
    }

    const lines = fresh.text.split('\n');
    if (lines.at(-1) === '') lines.pop();
    const toRequeue: Manifest[] = [];
    for (const m of safeRequeue) {
      if (!leaseHeldBy(host, m.job, m.id)) {
        try { unlinkSync(join(batchesDir(host), `${m.id}.json`)); } catch { /* gone */ }
        continue;
      }
      if (!lines.some(l => l.split('\t')[0] === m.job)) lines.push(m.line);
      toRequeue.push(m);
    }
    if (toRequeue.length) writeAtomic(join(queueDir(host), 'ready.tsv'), lines.map(l => l + '\n').join(''));
    for (const m of toRequeue) {
      unlinkSync(join(runDir(host), `${m.job}.batched`));
      try { unlinkSync(join(batchesDir(host), `${m.id}.json`)); } catch { /* gone */ }
      report.requeued.push(m.job);
    }

    // Claim only rows whose enqueue still fits: a staged claim leaves ready.tsv before it is enqueued.
    const fits = callsLeft();
    if (claims.length > fits) {
      for (const decision of claims.slice(Math.max(0, fits))) {
        decision.offload = false;
        decision.reasons.push('deadline');
        decision.nodeId = null;
        decision.routerJobId = null;
        decision.requires = [];
      }
      claims = claims.slice(0, Math.max(0, fits));
      report.held ??= 'deadline';
    }
    const staged: { decision: BridgeRowDecision; manifest: Manifest; task?: EmbeddedNodeTask }[] = [];
    for (const decision of claims) {
      const row = fresh.rows.find(r => r.job === decision.job);
      const id = bridgeLeaseOwner(decision.job);
      if (!row || claimedLocally(host, decision.job) || existsSync(join(batchesDir(host), `${id}.json`))) { report.lostRace.push(decision.job); continue; }
      let task: EmbeddedNodeTask | undefined;
      if (decision.pack === 'codex-file') {
        // Embed the bounded prompt so the receiving host needs no access to this host's prompt root.
        try { task = readBridgeTask(host, row); }
        catch (error) {
          decision.offload = false;
          decision.reasons.push((error as Error).message);
          decision.nodeId = null;
          decision.routerJobId = null;
          decision.requires = [];
          continue;
        }
      }
      const manifest: Manifest = { schema: NODE_BRIDGE_SCHEMA, id, job: decision.job, line: row.line, routerJobId: decision.routerJobId!,
        owner, routerScope: router.scope, createdAt: now, state: 'claimed', ...(task ? { taskSha256: task.sha256 } : {}) };
      const manifestPath = join(batchesDir(host), `${id}.json`);
      writeAtomic(manifestPath, JSON.stringify(manifest) + '\n');
      let fd: number;
      try { fd = openSync(join(runDir(host), `${decision.job}.batched`), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
      catch { unlinkSync(manifestPath); report.lostRace.push(decision.job); continue; }
      try { writeSync(fd, id); } finally { closeSync(fd); }
      staged.push({ decision, manifest, ...(task ? { task } : {}) });
    }
    if (staged.length) {
      const taken = new Set(staged.map(s => s.manifest.line));
      writeAtomic(join(queueDir(host), 'ready.tsv'), lines.filter(l => !taken.has(l)).map(l => l + '\n').join(''));
    }

    for (const { decision, manifest, task } of staged) {
      let enqueued = false;
      try { enqueued = router.enqueue(manifest.routerJobId, { owner, requires: decision.requires, pack: decision.pack!, ...(task ? { task } : {}) }); } catch { /* next pass */ }
      if (enqueued) writeAtomic(join(batchesDir(host), `${manifest.id}.json`), JSON.stringify({ ...manifest, state: 'offloaded' }) + '\n');
      report.claimed.push(decision.job);
    }
    return report;
  } finally { await lock.release(); }
}
