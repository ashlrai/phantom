/**
 * Measured node capacity (RQ-NODE-AUTOSCALE-1, unit 1B).
 *
 * Pure: a raw NodeSnapshot (see node-measure.ts) plus the previous document
 * become one `phantom.node-capacity.v1` document, the shape written to
 * ~/.ashlr-runs/metrics/node-capacity.json. Nothing here is a per-node or
 * per-lane cap: every number is derived from what the node measured, and the
 * only constants are the existing memguard thresholds, so this model never
 * admits work memguard would immediately back off. Unknown inputs yield null
 * (not zero, not permission).
 */
import { MEMORY_GUARD } from '../../resources/lane-autopilot.js';
import { HARNESS_ADAPTERS, type HarnessSession } from './harness-adapters.js';

export const NODE_CAPACITY_SCHEMA = 'phantom.node-capacity.v1';

/** Tunables, each tied to an existing gate. Exported so tests and docs cite one source. */
export const CAPACITY_POLICY = Object.freeze({
  /** Keep memguard's raise line free: memory above it is the only headroom. */
  memReserveFreePct: MEMORY_GUARD.raiseFreePct,
  /** memguard's swap-growth signal (vm_stat swapouts per minute). */
  growingSwapoutsPerMin: MEMORY_GUARD.growingSwapoutsPerMin,
  /** CPU above this fraction of all cores is not headroom (leave room for the OS and the operator). */
  cpuTargetFraction: 0.85,
  /** Counter deltas older than this are not a rate. */
  maxDeltaMs: 15 * 60_000,
  /** A footprint learned from an earlier sample stays usable this long when no session is live. */
  learnedFootprintTtlMs: 7 * 24 * 60 * 60_000,
});

export type ProcessSource = 'ps' | 'pgrep+footprint' | 'unavailable';

export interface NodeSnapshot {
  node: string;
  measuredAtMs: number;
  platform: string;
  cpu: { cores: number; load: [number, number, number] | null; busyPercent: number | null };
  mem: { totalBytes: number; freeBytes: number | null; freePercent: number | null; pressureLevel: 1 | 2 | 4 | null };
  swap: { usedBytes: number | null; totalBytes: number | null; swapoutsTotal: number | null };
  processSource: ProcessSource;
  /** Only harness trees; null when the process table could not be read at all. */
  sessions: HarnessSession[] | null;
}

export interface HarnessFootprint {
  /** Live sessions observed in this sample (0 for a learned footprint). */
  sessions: number;
  /** Largest observed session tree (CLI plus MCP servers and tools): the conservative per-session cost. */
  mem_bytes_max: number;
  mem_bytes_median: number;
  /** Cores one session uses; null when the process source cannot report CPU. */
  cpu_cores_per_session: number | null;
  source: 'measured' | 'learned';
  learned_at: string | null;
}

export type Limiter = 'memory' | 'cpu' | 'pressure' | 'swap-growth' | 'unmeasured';

export interface NodeCapacityDoc {
  schema: typeof NODE_CAPACITY_SCHEMA;
  node: string;
  measured_at: string;
  platform: string;
  cpu: { cores: number; load_1m: number | null; load_5m: number | null; load_15m: number | null; busy_percent: number | null;
    run_queue_per_core: number | null; headroom_cores: number | null };
  mem_free: { total_bytes: number; free_bytes: number | null; free_percent: number | null; pressure_level: 1 | 2 | 4 | null;
    headroom_bytes: number | null };
  swap: { used_bytes: number | null; total_bytes: number | null; swapouts_total: number | null;
    swapouts_per_min: number | null; growth_bytes_per_min: number | null; growing: boolean | null };
  per_harness_footprint: Record<string, HarnessFootprint>;
  /** Additional sessions of each harness this node can start right now; null means unknown. */
  agents_runnable_now: Record<string, number | null>;
  basis: {
    process_source: ProcessSource;
    live_sessions: number | null;
    limiting: Record<string, Limiter>;
    notes: string[];
    policy: typeof CAPACITY_POLICY;
  };
}

const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);
const nullableNonnegative = (n: unknown): boolean => n === null || (finite(n) && n >= 0);
const round = (n: number, places = 2) => Math.round(n * 10 ** places) / 10 ** places;

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid]! : Math.round((sorted[mid - 1]! + sorted[mid]!) / 2);
}

function rates(s: NodeSnapshot, prev: NodeCapacityDoc | null): { swapoutsPerMin: number | null; growthPerMin: number | null } {
  const prevAt = prev ? Date.parse(prev.measured_at) : NaN;
  const elapsed = s.measuredAtMs - prevAt;
  if (!prev || prev.node !== s.node || !finite(elapsed) || elapsed <= 0 || elapsed > CAPACITY_POLICY.maxDeltaMs) {
    return { swapoutsPerMin: null, growthPerMin: null };
  }
  const minutes = elapsed / 60_000;
  const outs = s.swap.swapoutsTotal, prevOuts = prev.swap.swapouts_total;
  // A counter that went backwards means a reboot: no rate rather than a negative one.
  const swapoutsPerMin = finite(outs) && finite(prevOuts) && outs >= prevOuts ? (outs - prevOuts) * 60_000 / elapsed : null;
  const used = s.swap.usedBytes, prevUsed = prev.swap.used_bytes;
  const growthPerMin = finite(used) && finite(prevUsed) ? Math.round((used - prevUsed) / minutes) : null;
  return { swapoutsPerMin, growthPerMin };
}

function footprints(s: NodeSnapshot, prev: NodeCapacityDoc | null, notes: string[]): Record<string, HarnessFootprint> {
  const out: Record<string, HarnessFootprint> = {};
  const busyCores = finite(s.cpu.busyPercent) ? s.cpu.cores * s.cpu.busyPercent / 100 : null;
  const live = s.sessions ?? [];
  let cpuFromHost = false;
  for (const adapter of HARNESS_ADAPTERS) {
    const sessions = live.filter(x => x.harness === adapter.id);
    // A zero RSS total supplies no usable session cost.
    const mems = sessions.map(x => x.memBytes).filter((bytes): bytes is number => finite(bytes) && bytes > 0);
    if (sessions.length && mems.length === sessions.length) {
      const cpus = sessions.map(x => x.cpuPercent).filter(finite);
      let cpu: number | null = cpus.length === sessions.length ? cpus.reduce((a, b) => a + b, 0) / cpus.length / 100 : null;
      // Without complete per-process CPU, the harness could account for all
      // busy cores. Bound its mean using only that harness's session count.
      if (cpu === null && busyCores !== null) { cpu = busyCores / sessions.length; cpuFromHost = true; }
      out[adapter.id] = { sessions: sessions.length, mem_bytes_max: Math.max(...mems), mem_bytes_median: median(mems),
        cpu_cores_per_session: cpu, source: 'measured', learned_at: null };
      continue;
    }
    const old = prev?.node === s.node ? prev.per_harness_footprint?.[adapter.id] : undefined;
    const previousAt = prev ? Date.parse(prev.measured_at) : NaN;
    const learnedAt = old?.source === 'learned'
      ? Date.parse(old.learned_at ?? '')
      : previousAt;
    if (old && finite(old.mem_bytes_max) && old.mem_bytes_max > 0 && finite(learnedAt) && learnedAt <= previousAt &&
        s.measuredAtMs - learnedAt >= 0 && s.measuredAtMs - learnedAt <= CAPACITY_POLICY.learnedFootprintTtlMs) {
      out[adapter.id] = { ...old, sessions: 0, source: 'learned', learned_at: new Date(learnedAt).toISOString() };
    }
  }
  if (cpuFromHost) notes.push('cpu_cores_per_session = host busy cores / live sessions of the same harness (incomplete per-process CPU; upper bound on the harness mean)');
  return out;
}

/** Derive the node-capacity.json document. Pure and deterministic. */
export function computeNodeCapacity(s: NodeSnapshot, prev: NodeCapacityDoc | null = null): NodeCapacityDoc {
  const notes: string[] = [];
  const { swapoutsPerMin, growthPerMin } = rates(s, prev);
  const growing = swapoutsPerMin === null ? null : swapoutsPerMin >= CAPACITY_POLICY.growingSwapoutsPerMin;
  if (swapoutsPerMin === null) notes.push('swap growth unknown: no previous sample of this node within 15 minutes');

  const total = s.mem.totalBytes;
  const freePct = finite(s.mem.freePercent) ? s.mem.freePercent
    : finite(s.mem.freeBytes) && total > 0 ? s.mem.freeBytes / total * 100 : null;
  const headroomBytes = freePct === null || !(total > 0) ? null
    : Math.max(0, Math.floor(total * (freePct - CAPACITY_POLICY.memReserveFreePct) / 100));

  const busy = s.cpu.busyPercent;
  const headroomCores = finite(busy) && s.cpu.cores > 0
    ? Math.max(0, s.cpu.cores * (CAPACITY_POLICY.cpuTargetFraction * 100 - busy) / 100) : null;

  const per = footprints(s, prev, notes);
  const runnable: Record<string, number | null> = {};
  const limiting: Record<string, Limiter> = {};
  for (const adapter of HARNESS_ADAPTERS) {
    const id = adapter.id, fp = per[id];
    if (s.mem.pressureLevel !== null && s.mem.pressureLevel !== 1) { runnable[id] = 0; limiting[id] = 'pressure'; continue; }
    if (growing === true) { runnable[id] = 0; limiting[id] = 'swap-growth'; continue; }
    // A model server is shared infrastructure, not an agent session, and footprint omits its
    // mmapped weights; local placements are sized by model bytes in the router instead.
    if (adapter.kind === 'local-model') {
      runnable[id] = null; limiting[id] = 'unmeasured';
      if (fp) notes.push(`${id}: server footprint excludes mmapped model weights; sized per model by the router`);
      continue;
    }
    if (s.mem.pressureLevel === null || headroomBytes === null || !fp) { runnable[id] = null; limiting[id] = 'unmeasured'; continue; }
    if (headroomCores === 0) { runnable[id] = 0; limiting[id] = 'cpu'; continue; }
    const byMem = Math.floor(headroomBytes / fp.mem_bytes_max);
    let byCpu: number | null = null;
    if (headroomCores !== null && fp.cpu_cores_per_session !== null) {
      if (fp.cpu_cores_per_session === 0) byCpu = byMem;
      else {
        // Undo division roundoff at exact decimal boundaries (e.g. 0.30 / 0.10).
        const ratio = headroomCores / fp.cpu_cores_per_session;
        byCpu = Math.floor(ratio + ratio * Number.EPSILON);
      }
    }
    if (byCpu === null) { runnable[id] = byMem; limiting[id] = 'memory'; notes.push(`${id}: cpu per session unknown, memory-only`); continue; }
    runnable[id] = Math.min(byMem, byCpu);
    limiting[id] = byCpu < byMem ? 'cpu' : 'memory';
  }
  if (s.processSource === 'unavailable') notes.push('process table unreadable: no per-harness footprint measured this sample');
  const [l1, l5, l15] = s.cpu.load ?? [null, null, null];
  return {
    schema: NODE_CAPACITY_SCHEMA, node: s.node, measured_at: new Date(s.measuredAtMs).toISOString(), platform: s.platform,
    cpu: { cores: s.cpu.cores, load_1m: l1, load_5m: l5, load_15m: l15, busy_percent: finite(busy) ? round(busy, 1) : null,
      run_queue_per_core: finite(l1) && s.cpu.cores > 0 ? round(l1 / s.cpu.cores) : null, headroom_cores: headroomCores },
    mem_free: { total_bytes: total, free_bytes: s.mem.freeBytes, free_percent: freePct === null ? null : round(freePct, 1),
      pressure_level: s.mem.pressureLevel, headroom_bytes: headroomBytes },
    swap: { used_bytes: s.swap.usedBytes, total_bytes: s.swap.totalBytes, swapouts_total: s.swap.swapoutsTotal,
      swapouts_per_min: swapoutsPerMin, growth_bytes_per_min: growthPerMin, growing },
    per_harness_footprint: per, agents_runnable_now: runnable,
    basis: { process_source: s.processSource, live_sessions: s.sessions?.length ?? null, limiting, notes: [...new Set(notes)],
      policy: CAPACITY_POLICY },
  };
}

/** Strict-enough reader for a previous or remote document; anything malformed is ignored, never trusted. */
export function parseNodeCapacityDoc(value: unknown): NodeCapacityDoc | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const d = value as Partial<NodeCapacityDoc>;
  if (d.schema !== NODE_CAPACITY_SCHEMA || typeof d.node !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,199}$/.test(d.node) ||
      typeof d.measured_at !== 'string' || !finite(Date.parse(d.measured_at)) ||
      !d.mem_free || typeof d.mem_free !== 'object' || !d.swap || typeof d.swap !== 'object' || !d.cpu || typeof d.cpu !== 'object' ||
      !d.per_harness_footprint || typeof d.per_harness_footprint !== 'object' || Array.isArray(d.per_harness_footprint) ||
      !d.agents_runnable_now || typeof d.agents_runnable_now !== 'object' || Array.isArray(d.agents_runnable_now)) return null;
  if (!nullableNonnegative(d.cpu.headroom_cores) || !nullableNonnegative(d.mem_free.headroom_bytes) ||
      ![null, 1, 2, 4].includes(d.mem_free.pressure_level) ||
      !(d.swap.growing === null || typeof d.swap.growing === 'boolean')) return null;
  for (const fp of Object.values(d.per_harness_footprint)) {
    if (!fp || typeof fp !== 'object' || !finite(fp.mem_bytes_max) || fp.mem_bytes_max <= 0 ||
        !(fp.cpu_cores_per_session === null || (finite(fp.cpu_cores_per_session) && fp.cpu_cores_per_session >= 0))) return null;
  }
  for (const n of Object.values(d.agents_runnable_now)) {
    if (!(n === null || (Number.isSafeInteger(n) && n >= 0))) return null;
  }
  return d as NodeCapacityDoc;
}
