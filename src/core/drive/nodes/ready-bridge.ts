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
import { closeSync, constants, existsSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync, writeSync, openSync } from 'node:fs';
import { join } from 'node:path';
import { type DriveNodes, type JobView, type NodeView, type WithdrawOutcome } from './index.js';
import { validCap } from './state.js';

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
export interface BridgeRouter {
  view(owner: string): { nodes: NodeView[]; jobs: JobView[] };
  enqueue(jobId: string, spec: { owner: string; requires: string[]; pack: string }): boolean;
  withdraw(jobId: string, owner: string): WithdrawOutcome;
}
export interface DispatcherLock { release(): Promise<void> }
export type AcquireDispatcherLock = (queueDir: string, signal?: AbortSignal) => Promise<DispatcherLock | { busy: string }>;
interface Manifest {
  schema: typeof NODE_BRIDGE_SCHEMA; id: string; job: string; line: string; routerJobId: string; owner: string;
  createdAt: number; state: 'claimed' | 'offloaded' | 'completed'; completedAt?: number; result?: string;
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
  if (f.length < 5 || !JID.test(job)) return { job, lane: f[2] ?? '', line, spec: null, invalid: 'invalid_row' };
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
export function planNodeBridge(input: {
  rows: ReadyRow[]; claimed: (job: string) => boolean; nodes: NodeView[]; jobs: JobView[]; maxPerPass?: number;
}): { nodes: BridgeNodeView[]; rows: BridgeRowDecision[] } {
  const live = input.nodes.filter(n => n.live).sort((a, b) => (a.nodeId < b.nodeId ? -1 : 1));
  const running = (id: string) => input.jobs.filter(j => j.state === 'running' && j.claimedBy === id).length;
  const free = new Map<string, number | null>(live.map(n => [n.nodeId, n.slots === undefined ? null : Math.max(0, n.slots - running(n.nodeId))]));
  const take = (requires: string[]): NodeView | null => {
    const fits = live.filter(n => requires.every(c => n.caps.includes(c)) && (free.get(n.nodeId) ?? 0) > 0)
      .sort((a, b) => (free.get(b.nodeId)! - free.get(a.nodeId)!) || (a.nodeId < b.nodeId ? -1 : 1));
    if (fits[0]) free.set(fits[0].nodeId, free.get(fits[0].nodeId)! - 1);
    return fits[0] ?? null;
  };
  // Router jobs still waiting (or held by an unreported node) reserve a slot before any new row.
  for (const job of input.jobs) if (job.state === 'pending' || (job.state === 'running' && !job.claimedBy)) take(job.requires);
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
      if (!live.length) reasons.push('no_live_node');
      else if (!live.some(n => cap && n.caps.includes(cap))) reasons.push('lane_mismatch');
      else if (target!.writes && !NODE_BRIDGE_WORKTREE_PACK_ENABLED) reasons.push('pack_inert');
      else if (!live.some(n => n.caps.includes(`pack:${target!.pack}`))) reasons.push('node_pack_unsupported');
      else if (!capable.length) reasons.push('caps_missing');
      else if (capable.every(n => free.get(n.nodeId) === null)) reasons.push('slots_unknown');
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
      return m?.schema === NODE_BRIDGE_SCHEMA && `${m.id}.json` === name && m.id === bridgeLeaseOwner(m.job) ? [m] : [];
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

export function localBridgeRouter(nodes: DriveNodes): BridgeRouter {
  return {
    view: owner => nodes.view([owner]),
    enqueue: (jobId, spec) => nodes.enqueue(jobId, spec),
    withdraw: (jobId, owner) => nodes.withdraw(jobId, owner),
  };
}

/** Pool witness transport (`callPool`). A demoted primary never claims. */
export function poolBridgeRouter(call: (verb: string, args: string[]) => { demoted: boolean; result: Record<string, unknown> }): BridgeRouter {
  const ok = (verb: string, args: string[]) => {
    const reply = call(verb, args);
    if (reply.demoted) throw new Error('Node pool primary is demoted');
    return reply.result;
  };
  return {
    view: owner => ok('status', ['--owner', owner]) as unknown as { nodes: NodeView[]; jobs: JobView[] },
    enqueue: (jobId, spec) => ok('enqueue', ['--job', jobId, '--owner', spec.owner, '--requires', spec.requires.join(','), '--pack', spec.pack])['enqueued'] === true,
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
  /** Overrides host readiness (e.g. a pool backup/worker never claims). */
  inert?: string | null;
}

function leaseAction(m: Manifest, job: JobView | undefined, now: number, ttl: number): string {
  if (m.state === 'completed') return 'keep-completed';
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
  const emptyView = { nodes: [], jobs: [] };
  const readView = (): { nodes: NodeView[]; jobs: JobView[] } => {
    if (!owner || !opts.router) return emptyView;
    try { return opts.router.view(owner); } catch { report.inert ??= 'router-unavailable'; return emptyView; }
  };
  const recordSnapshot = (view: { nodes: NodeView[]; jobs: JobView[] }, manifests: Manifest[], fresh: { text: string; rows: ReadyRow[] }) => {
    report.leases = manifests.map(m => {
      const job = view.jobs.find(j => j.id === m.routerJobId);
      return { job: m.job, leaseOwner: m.id, routerJobId: m.routerJobId, state: m.state, routerState: job?.state ?? null,
        action: leaseAction(m, job, now, ttl) };
    });
    const bridged = new Set(manifests.map(m => m.job));
    const plan = planNodeBridge({ rows: fresh.rows, claimed: j => bridged.has(j) || claimedLocally(host, j),
      nodes: view.nodes, jobs: view.jobs, ...(opts.maxPerPass !== undefined ? { maxPerPass: opts.maxPerPass } : {}) });
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
      if (action === 'keep-completed' || action === 'wait') continue;
      let outcome: WithdrawOutcome;
      try { outcome = router.withdraw(m.routerJobId, owner); } catch { continue; }
      if (outcome.state === 'withdrawn' || outcome.state === 'absent') requeue.push(m);
      else if (outcome.state === 'completed') {
        writeAtomic(join(batchesDir(host), `${m.id}.json`), JSON.stringify({ ...m, state: 'completed', completedAt: now, result: (outcome.result ?? '').slice(0, 200) }) + '\n');
        report.completed.push(m.job);
      }
    }

    const claims = plan.rows.filter(r => r.offload);
    if (!requeue.length && !claims.length) return report;
    if (opts.signal?.aborted) { report.held = 'aborted'; return report; }

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
          current.line === m.line && current.routerJobId === m.routerJobId && current.owner === m.owner);
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

    const staged: { decision: BridgeRowDecision; manifest: Manifest }[] = [];
    for (const decision of claims) {
      const row = fresh.rows.find(r => r.job === decision.job);
      const id = bridgeLeaseOwner(decision.job);
      if (!row || claimedLocally(host, decision.job) || existsSync(join(batchesDir(host), `${id}.json`))) { report.lostRace.push(decision.job); continue; }
      const manifest: Manifest = { schema: NODE_BRIDGE_SCHEMA, id, job: decision.job, line: row.line, routerJobId: decision.routerJobId!,
        owner, createdAt: now, state: 'claimed' };
      const manifestPath = join(batchesDir(host), `${id}.json`);
      writeAtomic(manifestPath, JSON.stringify(manifest) + '\n');
      let fd: number;
      try { fd = openSync(join(runDir(host), `${decision.job}.batched`), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
      catch { unlinkSync(manifestPath); report.lostRace.push(decision.job); continue; }
      try { writeSync(fd, id); } finally { closeSync(fd); }
      staged.push({ decision, manifest });
    }
    if (staged.length) {
      const taken = new Set(staged.map(s => s.manifest.line));
      writeAtomic(join(queueDir(host), 'ready.tsv'), lines.filter(l => !taken.has(l)).map(l => l + '\n').join(''));
    }

    for (const { decision, manifest } of staged) {
      let enqueued = false;
      try { enqueued = router.enqueue(manifest.routerJobId, { owner, requires: decision.requires, pack: decision.pack! }); } catch { /* next pass */ }
      if (enqueued) writeAtomic(join(batchesDir(host), `${manifest.id}.json`), JSON.stringify({ ...manifest, state: 'offloaded' }) + '\n');
      report.claimed.push(decision.job);
    }
    return report;
  } finally { await lock.release(); }
}
