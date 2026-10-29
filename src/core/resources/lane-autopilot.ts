/** Resource autopilot: one pure rule that turns disk, inode, memory and credit readings into lane targets.
 * Read-only inputs only. An unknown or stale reading holds the current target and never raises it. */

export type DiskLevel = 'green' | 'compact1' | 'compact2' | 'pause';
export interface DiskReading { freeBytes: number; totalBytes: number; freeInodes: number; totalInodes: number }
export interface Reading<T> { value: T | null; asOf: string | null; ttlMs: number }
export interface LaneLimits { target: number; floor: number; ceiling: number }
export interface DevinOutcome { pr: boolean }
export type LaneKind = 'usd-paced' | 'quota-window' | 'devin' | 'cloud' | 'fixed';
export interface LaneInput {
  lane: string; kind: LaneKind; limits: LaneLimits;
  /** usd-paced: need and per-slot burn in USD per hour. */
  pace?: Reading<{ needUsdPerHour: number; slotUsdPerHour: number; poolOpen: boolean }>;
  /** quota-window: highest used percent across the provider windows (0..100). */
  quota?: Reading<{ usedPercent: number }>;
  /** devin: ACUs used this period against a typed allowance, plus recent outcomes. */
  devin?: Reading<{ usedAcus: number; allowanceAcus: number; periodFraction: number }>;
  devinOutcomes?: DevinOutcome[];
  memTarget?: number;
  memory?: MemoryReading;
}
/** Memory input: free percent plus swap GROWTH (vm_stat swapouts or pageouts per minute), not absolute swap. */
export interface MemoryReading { freePct: number; swapUsedGb: number; swapoutsPerMin: number }
// UNMEASURED conservative defaults: tune from metrics/swapout-rate.jsonl (24h of memguard samples).
export const MEMORY_GUARD = Object.freeze({ raiseFreePct: 30, lowFreePct: 25, growingSwapoutsPerMin: 100, swapBackstopGb: 48 });

/** Old swap stays allocated after pressure passes, so static swap alone never blocks a raise.
 * Absolute swap blocks raises only when swap is also growing or free memory is under 25%. */
export function memoryAllowsRaise(m: MemoryReading | undefined): boolean {
  if (!m) return true;
  const growing = m.swapoutsPerMin >= MEMORY_GUARD.growingSwapoutsPerMin;
  if (growing || m.freePct < MEMORY_GUARD.lowFreePct) return false;
  if (m.swapUsedGb > MEMORY_GUARD.swapBackstopGb) return false;   // absolute backstop only; parked swap below it never blocks
  return m.freePct > MEMORY_GUARD.raiseFreePct;
}
export interface LaneDecision { lane: string; target: number; reason: string; held: boolean }

export const GIB = 1024 ** 3;
export const DISK_THRESHOLDS = Object.freeze({
  compact1: { freeBytes: 40 * GIB, freeInodePct: 20 },
  compact2: { freeBytes: 28 * GIB, freeInodePct: 12 },
  pause: { freeBytes: 20 * GIB, freeInodePct: 5 },
});
/** Typed values older than this are treated as unknown. */
export const TYPED_MAX_AGE_MS = 24 * 60 * 60_000;
export const QUOTA_FLOOR_AT_PCT = 90;
export const DEVIN_STEP_DOWN = Object.freeze({ window: 10, maxNonPr: 3, step: 2, floor: 6 });

/** One source of truth for byte thresholds: the "compact" block in budget-overrides.json (l1_free_gb, l2_free_gb),
 * shared with compact.sh and autopilot.py. Mac defaults L1 300G, L2 200G. Values are capped (Security rev2 A2):
 * l1 at most 2000G, l2 at most l1, pause fixed at 20G. Inode thresholds are fixed. */
export const COMPACT_CONFIG_DEFAULTS = Object.freeze({ l1FreeGb: 300, l2FreeGb: 200, maxGb: 2000 });
export interface ByteThresholds { compact1: number; compact2: number; pause: number }
export function compactThresholds(overrides: unknown): ByteThresholds {
  const block = overrides && typeof overrides === 'object' ? (overrides as Record<string, unknown>)['compact'] : undefined;
  const c = block && typeof block === 'object' ? block as Record<string, unknown> : {};
  const gb = (k: string, d: number) => { const v = c[k]; return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : d; };
  const l1 = Math.min(gb('l1_free_gb', COMPACT_CONFIG_DEFAULTS.l1FreeGb), COMPACT_CONFIG_DEFAULTS.maxGb);
  const l2 = Math.min(gb('l2_free_gb', COMPACT_CONFIG_DEFAULTS.l2FreeGb), l1);
  return { compact1: l1 * GIB, compact2: l2 * GIB, pause: DISK_THRESHOLDS.pause.freeBytes };
}

export function diskLevel(d: DiskReading, bytes?: ByteThresholds): DiskLevel {
  // A failed or nonsensical disk read is yellow (compact1: raises frozen), never green.
  if (![d.freeBytes, d.totalBytes, d.freeInodes, d.totalInodes].every(n => Number.isFinite(n) && n >= 0) || d.totalBytes <= 0) return 'compact1';
  const inodePct = d.totalInodes > 0 ? (d.freeInodes / d.totalInodes) * 100 : 100;
  const t = DISK_THRESHOLDS;
  const b = bytes ?? { compact1: t.compact1.freeBytes, compact2: t.compact2.freeBytes, pause: t.pause.freeBytes };
  if (d.freeBytes < b.pause || inodePct < t.pause.freeInodePct) return 'pause';
  if (d.freeBytes < b.compact2 || inodePct < t.compact2.freeInodePct) return 'compact2';
  if (d.freeBytes < b.compact1 || inodePct < t.compact1.freeInodePct) return 'compact1';
  return 'green';
}

/** A reading is usable only with a valid as_of no older than min(ttl, 24h) and not in the future. */
export function fresh<T>(r: Reading<T> | undefined, nowMs: number): r is Reading<T> & { value: T; asOf: string } {
  if (!r || r.value === null || typeof r.asOf !== 'string') return false;
  const at = Date.parse(r.asOf);
  if (!Number.isFinite(at) || at > nowMs + 60_000) return false;
  return nowMs - at <= Math.min(r.ttlMs, TYPED_MAX_AGE_MS);
}

const clamp = (n: number, l: LaneLimits) => Math.max(l.floor, Math.min(l.ceiling, Math.floor(n)));

export function devinStepDown(target: number, outcomes: DevinOutcome[] | undefined): number {
  const last = (outcomes ?? []).slice(-DEVIN_STEP_DOWN.window);
  const nonPr = last.filter(o => !o.pr).length;
  // Lowers only: a target already under the step-down floor is never raised by this rule.
  return nonPr > DEVIN_STEP_DOWN.maxNonPr ? Math.min(target, Math.max(DEVIN_STEP_DOWN.floor, target - DEVIN_STEP_DOWN.step)) : target;
}

function paceTarget(input: LaneInput, nowMs: number): { t: number; reason: string } | null {
  const l = input.limits;
  switch (input.kind) {
    case 'usd-paced': {
      if (!fresh(input.pace, nowMs)) return null;
      const p = input.pace.value;
      if (!p.poolOpen) return { t: l.floor, reason: 'pool at stop line' };
      if (p.slotUsdPerHour <= 0) return null;
      return { t: Math.ceil(p.needUsdPerHour / p.slotUsdPerHour), reason: 'usd pace' };
    }
    case 'quota-window': {
      if (!fresh(input.quota, nowMs)) return null;
      const used = Math.max(0, Math.min(100, input.quota.value.usedPercent));
      if (used >= QUOTA_FLOOR_AT_PCT) return { t: l.floor, reason: `quota ${used}% used` };
      return { t: l.floor + ((l.ceiling - l.floor) * (100 - used)) / 100, reason: `quota ${used}% used` };
    }
    case 'devin': {
      if (!fresh(input.devin, nowMs)) return null;
      const d = input.devin.value;
      if (d.allowanceAcus <= 0) return null;
      const burn = d.usedAcus / d.allowanceAcus;   // fraction of allowance spent
      if (burn >= 0.98) return { t: l.floor, reason: 'acu allowance at stop line' };
      // Ahead of pace: shrink; behind pace: grow, scaled by how far.
      const ratio = d.periodFraction > 0 ? burn / d.periodFraction : 0;
      return { t: ratio > 1 ? l.target - Math.ceil((ratio - 1) * 4) : l.target + (ratio < 0.9 ? 2 : 0), reason: 'acu pace' };
    }
    case 'cloud': return { t: l.floor, reason: 'cloud credits unknown, hold at floor' };
    default: return null;
  }
}

/** target = clamp(floor, ceiling, min(pace, mem, disk cap)); unknown pace holds the current target (never raises). */
export function decideLane(input: LaneInput, disk: DiskLevel, nowMs: number): LaneDecision {
  const l = input.limits;
  if (disk === 'pause') return { lane: input.lane, target: 0, reason: 'disk pause: no new launches', held: true };
  const p = paceTarget(input, nowMs);
  let held = p === null;
  let t = p === null ? l.target : p.t;
  let reason = p === null ? 'reading unknown or stale: hold' : p.reason;
  if (p !== null && input.kind !== 'cloud' && disk !== 'green' && t > l.target) { t = l.target; reason += '; disk compact: raises frozen'; }
  if (input.memTarget !== undefined) t = Math.min(t, input.memTarget);
  if (t > l.target && !memoryAllowsRaise(input.memory)) { t = l.target; reason += '; memory guard: swap growing or free low'; }
  if (disk === 'compact2') { t = Math.min(t, Math.floor(l.target / 2)); reason += '; compact2 halve'; }
  if (input.kind === 'devin') {
    const s = devinStepDown(t, input.devinOutcomes);
    if (s !== t) { t = s; reason += '; devin step-down'; }
  }
  t = clamp(t, l);
  if (held) t = Math.min(t, l.target);
  return { lane: input.lane, target: t, reason, held };
}

export function decideLanes(inputs: LaneInput[], disk: DiskReading, nowMs = Date.now(), bytes?: ByteThresholds) {
  const level = diskLevel(disk, bytes);
  return { schema: 'phantom.lane-autopilot.v1', disk: level, lanes: inputs.map(i => decideLane(i, level, nowMs)) };
}
