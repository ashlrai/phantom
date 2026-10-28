/**
 * Read-only pressure projection for ONE-TEAM lanes. Collectors supply complete
 * snapshots; this module never probes a host, spends credits or changes slots.
 * A target is a total concurrency ceiling, not additional dispatch capacity.
 * Per-lane ceilings do not reserve or partition shared pool capacity.
 * Consumers must still apply their existing admission and backpressure gates.
 */
import { assessSeat, type SeatCapacity } from '../routing/headroom.js';
import type { SeatBudgetPolicy } from '../routing/types.js';

const GIB = 1024 ** 3;

/** Conservative host defaults; all byte thresholds use binary GiB. */
export const PRESSURE_LIMITS = Object.freeze({
  readingMaxAgeMs: 60_000,
  diskStopBytes: 2 * GIB,
  diskWarningBytes: 10 * GIB,
  swapWarningBytes: 2 * GIB,
  swapStopBytes: 8 * GIB,
  creditWarningPercent: 20,
});

export interface PressureReading<T> {
  readonly observedAtMs: number;
  readonly value: T;
}

export interface HostPressureReadings {
  /** null means unavailable, never an implicit RUN or zero usage. */
  readonly memguard: PressureReading<'RUN' | 'PAUSE'> | null;
  readonly freeDiskBytes: PressureReading<number> | null;
  readonly swapUsedBytes: PressureReading<number> | null;
}

interface PoolEventBase {
  readonly poolId: string;
  /** null keeps the brake until a fresh complete snapshot removes it. */
  readonly retryAtMs: number | null;
}

export type PoolPressureEvent =
  | (PoolEventBase & { readonly kind: 'rate_limit' })
  | (PoolEventBase & {
    readonly kind: 'model_capacity';
    readonly modelId: string;
    /** Total model concurrency ceiling, not unused slots. */
    readonly slotTarget: number;
  });

export interface PressureLane {
  readonly laneId: string;
  readonly poolId: string;
  readonly modelId: string;
  readonly seatId: string;
  readonly configuredSlots: number;
  /** Use the same capacity and policy snapshot as routing/headroom.ts. */
  readonly credit: {
    readonly capacity: SeatCapacity;
    readonly policy: SeatBudgetPolicy;
  } | null;
}

export type PressureState = 'clear' | 'limited' | 'blocked' | 'unknown';

export interface PressureComponent {
  readonly state: PressureState;
  readonly slotTarget: number;
  /** Fixed diagnostic text only; raw provider messages never enter the vector. */
  readonly reason: string;
}

export interface LanePressureVector {
  readonly laneId: string;
  readonly poolId: string;
  readonly modelId: string;
  readonly seatId: string;
  readonly evaluatedAtMs: number;
  readonly configuredSlots: number;
  readonly signals: Readonly<Record<
    'memguard' | 'freeDisk' | 'swap' | 'rateLimit' | 'modelCapacity' | 'credit', PressureComponent
  >>;
  readonly recommendedSlotTarget: number;
}

export interface PressureInput {
  readonly nowMs: number;
  readonly lanes: readonly PressureLane[];
  readonly host: HostPressureReadings;
  /** Complete current event set. [] is a successful empty read; null is unknown. */
  readonly poolEvents: PressureReading<readonly PoolPressureEvent[]> | null;
}

function unknown(reason: string): PressureComponent {
  return { state: 'unknown', slotTarget: 0, reason };
}

function component(slotTarget: number, max: number, reason: string, blocked = false): PressureComponent {
  return { state: blocked ? 'blocked' : slotTarget < max ? 'limited' : 'clear', slotTarget, reason };
}

function validCount(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function fresh<T>(reading: PressureReading<T> | null, nowMs: number): reading is PressureReading<T> {
  return reading !== null && Number.isFinite(reading.observedAtMs)
    && reading.observedAtMs <= nowMs && nowMs - reading.observedAtMs <= PRESSURE_LIMITS.readingMaxAgeMs;
}

function hostComponents(host: HostPressureReadings, max: number, nowMs: number) {
  // Match concurrent-dispatch's warning bucket, including a one-slot lane.
  const near = Math.ceil(max / 2);
  const guard = host.memguard;
  const memguard = !fresh(guard, nowMs) || !['RUN', 'PAUSE'].includes(guard.value)
    ? unknown('Memguard reading is unavailable, stale or invalid.')
    : component(guard.value === 'PAUSE' ? 0 : max, max, `Memguard reports ${guard.value}.`, guard.value === 'PAUSE');
  const disk = host.freeDiskBytes;
  const freeDisk = !fresh(disk, nowMs) || !validCount(disk.value)
    ? unknown('Free disk reading is unavailable, stale or invalid.')
    : disk.value <= PRESSURE_LIMITS.diskStopBytes
      ? component(0, max, 'Free disk is at or below the stop threshold.', true)
      : disk.value <= PRESSURE_LIMITS.diskWarningBytes
        ? component(near, max, 'Free disk is at or below the warning threshold.')
        : component(max, max, 'Free disk has headroom.');
  const used = host.swapUsedBytes;
  const swap = !fresh(used, nowMs) || !validCount(used.value)
    ? unknown('Swap reading is unavailable, stale or invalid.')
    : used.value >= PRESSURE_LIMITS.swapStopBytes
      ? component(0, max, 'Swap usage is at or above the stop threshold.', true)
      : used.value >= PRESSURE_LIMITS.swapWarningBytes
        ? component(near, max, 'Swap usage is at or above the warning threshold.')
        : component(max, max, 'Swap usage has headroom.');
  return { memguard, freeDisk, swap };
}

function poolComponent(
  kind: PoolPressureEvent['kind'], lane: PressureLane,
  reading: PressureInput['poolEvents'], max: number, nowMs: number,
): PressureComponent {
  if (!fresh(reading, nowMs)) return unknown('Pool event snapshot is unavailable, stale or invalid.');
  let target = max;
  let blocked = false;
  for (const event of reading.value) {
    if (event.kind !== kind || event.poolId !== lane.poolId) continue;
    if (event.kind === 'model_capacity' && event.modelId !== lane.modelId) continue;
    if (event.retryAtMs !== null) {
      if (!Number.isFinite(event.retryAtMs) || event.retryAtMs < 0) return unknown('Pool event expiry is invalid.');
      if (event.retryAtMs <= nowMs) continue;
    }
    if (event.kind === 'rate_limit') { target = 0; blocked = true; }
    else {
      if (!validCount(event.slotTarget)) return unknown('Model capacity ceiling is invalid.');
      target = Math.min(target, event.slotTarget);
      blocked ||= event.slotTarget === 0;
    }
  }
  return component(target, max, blocked || target < max ? `Active ${kind} event limits this lane.` : `No ${kind} clamp on this lane.`, blocked);
}

function creditComponent(lane: PressureLane, max: number, nowMs: number): PressureComponent {
  const credit = lane.credit;
  if (!credit || credit.capacity.seatId !== lane.seatId || credit.policy.seatId !== lane.seatId) {
    return unknown('Credit capacity and policy must match the lane seat.');
  }
  const { capacity, policy } = credit;
  const percent = (value: number) => Number.isFinite(value) && value >= 0 && value <= 100;
  if (!percent(policy.reservePercent)
    || (policy.maxSessionWindowPercent !== undefined && !percent(policy.maxSessionWindowPercent))
    || (policy.dailyUsdCap !== undefined && (!Number.isFinite(policy.dailyUsdCap) || policy.dailyUsdCap < 0))
    || (capacity.spentTodayUsd !== null && (!Number.isFinite(capacity.spentTodayUsd) || capacity.spentTodayUsd < 0))
    || capacity.windows.some(window => window.usedPercent !== null && !percent(window.usedPercent))) {
    return unknown('Credit capacity or policy contains invalid numeric evidence.');
  }
  if (capacity.observedAt !== null) {
    const observedAtMs = Date.parse(capacity.observedAt);
    if (!Number.isFinite(observedAtMs) || observedAtMs > nowMs) return unknown('Credit timestamp is invalid or in the future.');
  }
  const assessment = assessSeat(capacity, policy, { nowMs });
  const { headroom } = assessment;
  if (assessment.unknownUsage) return unknown('Credit usage evidence is unavailable or stale.');
  if (!headroom.eligibleForAutonomy) {
    return headroom.autonomyHeadroomPercent === null
      ? unknown('Credit headroom is unknown or autonomy is unavailable.')
      : component(0, max, 'Credit policy does not permit autonomous work.', true);
  }
  const remaining = headroom.autonomyHeadroomPercent;
  if (remaining === null || !percent(remaining)) return unknown('Credit headroom is unavailable or invalid.');
  // The canonical headroom projection rounds to whole percentages. Do not
  // recommend more concurrency when that conservative projection is zero.
  if (remaining === 0) return component(0, max, 'No measurable credit headroom remains.', true);
  return component(remaining <= PRESSURE_LIMITS.creditWarningPercent ? Math.ceil(max / 2) : max,
    max, remaining <= PRESSURE_LIMITS.creditWarningPercent ? 'Credit headroom is low.' : 'Credit headroom is available.');
}

/**
 * One deterministic vector per unique lane. Independent ceilings intersect:
 * multiple warnings never multiply into an accidental stop. Unknown evidence
 * is a zero ceiling. A healthy vector is advisory and grants no authority.
 */
export function computePressureVectors(input: PressureInput): readonly LanePressureVector[] {
  if (!Number.isFinite(input.nowMs) || !Number.isFinite(new Date(input.nowMs).getTime())) {
    throw new RangeError('Pressure evaluation requires a valid clock.');
  }
  const seen = new Set<string>();
  for (const lane of input.lanes) {
    if (![lane.laneId, lane.poolId, lane.modelId, lane.seatId].every(id => id.trim().length > 0)
      || seen.has(lane.laneId) || !validCount(lane.configuredSlots)) {
      throw new RangeError('Pressure lanes require unique IDs, scope and nonnegative integer slot counts.');
    }
    seen.add(lane.laneId);
  }
  return input.lanes.map(lane => {
    const max = lane.configuredSlots;
    const signals = {
      ...hostComponents(input.host, max, input.nowMs),
      rateLimit: poolComponent('rate_limit', lane, input.poolEvents, max, input.nowMs),
      modelCapacity: poolComponent('model_capacity', lane, input.poolEvents, max, input.nowMs),
      credit: creditComponent(lane, max, input.nowMs),
    };
    return {
      laneId: lane.laneId, poolId: lane.poolId, modelId: lane.modelId, seatId: lane.seatId,
      evaluatedAtMs: input.nowMs, configuredSlots: max, signals,
      recommendedSlotTarget: Math.min(max, ...Object.values(signals).map(signal => signal.slotTarget)),
    };
  });
}
