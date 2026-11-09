/** Operator count preferences. Null removes a preference ceiling, not admission.
 * Unset counts follow the adaptive throughput level: ramp until a measured
 * limit, then back off. Explicit numbers stay as written.
 */
import type { DaemonConfig } from '../types.js';

/** First ramp step. Not a permanent ceiling. */
export const ADAPTIVE_START_LEVEL = 1;

export interface ThroughputLevel {
  level: number;
  measuredLimit: number | null;
}

export interface ThroughputWindow {
  lane: string;
  status: 'fresh' | 'unknown';
  headroom: number | null;
}

export interface ThroughputSample {
  /** A tick failed or timed out, or a runtime reported it was full. */
  saturated?: boolean;
  /** Usage windows. Devin ACU and claude-api are ignored so spend gates stay put. */
  windows?: readonly ThroughputWindow[];
}

export type ThroughputRule = 'ramp' | 'back-off' | 'hold';

/** Pay-per-use lanes. Their caps stay in the spend and ACU gates. */
const SPEND_LANES = new Set(['devin', 'claude-api']);

export function nextThroughputLevel(
  previous: ThroughputLevel | null,
  sample: ThroughputSample = {},
): ThroughputLevel & { rule: ThroughputRule } {
  if (previous === null) return { level: ADAPTIVE_START_LEVEL, measuredLimit: null, rule: 'ramp' };
  const fresh = (sample.windows ?? []).filter((window) => window.status === 'fresh' && !SPEND_LANES.has(window.lane));
  const blocked = fresh.some((window) => window.headroom === 0);
  const room = fresh.some((window) => window.headroom !== null && window.headroom > 0);
  if (sample.saturated === true || blocked) {
    const measuredLimit = Math.max(ADAPTIVE_START_LEVEL, previous.level);
    return { level: Math.max(ADAPTIVE_START_LEVEL, measuredLimit - 1), measuredLimit, rule: 'back-off' };
  }
  if (room) return { level: previous.level + 1, measuredLimit: null, rule: 'ramp' };
  if (previous.measuredLimit !== null) {
    return { level: Math.min(previous.level, previous.measuredLimit), measuredLimit: previous.measuredLimit, rule: 'hold' };
  }
  return { level: previous.level + 1, measuredLimit: null, rule: 'ramp' };
}

let throughput: ThroughputLevel = { level: ADAPTIVE_START_LEVEL, measuredLimit: null };

export function resetAdaptiveThroughput(): void {
  throughput = { level: ADAPTIVE_START_LEVEL, measuredLimit: null };
}

export function currentThroughputLevel(): ThroughputLevel {
  return { level: throughput.level, measuredLimit: throughput.measuredLimit };
}

export function noteThroughputSample(sample: ThroughputSample = {}): ThroughputLevel & { rule: ThroughputRule } {
  const next = nextThroughputLevel(throughput, sample);
  throughput = { level: next.level, measuredLimit: next.measuredLimit };
  return next;
}

/** One resident tick. A failed or timed-out tick is the measured limit. */
export function noteResidentTickOutcome(outcome: string | null): ThroughputLevel & { rule: ThroughputRule } {
  return noteThroughputSample({ saturated: outcome === 'failed' || outcome === 'timeout' });
}

export function resolveCountPreference(value: unknown, fallback: number | null): number | null {
  if (value === null) return null;
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

export function resolveDaemonCountPreferences(raw: Partial<DaemonConfig> = {}) {
  const adaptive = currentThroughputLevel().level;
  const total = resolveCountPreference(raw.concurrency?.total, adaptive);
  return {
    perTickItems: resolveCountPreference(raw.perTickItems, adaptive),
    parallel: resolveCountPreference(raw.parallel, adaptive),
    // Explicit null has the same precedence as an explicit numeric override.
    maxConcurrent: resolveCountPreference(raw.maxConcurrent, total),
    concurrency: {
      local: resolveCountPreference(raw.concurrency?.local, adaptive),
      cloud: resolveCountPreference(raw.concurrency?.cloud, adaptive),
      total,
    },
  };
}

/** Allocate only from finite admitted inventory; never use a sentinel width. */
export function countForInventory(preference: number | null, inventory: number): number {
  const available = Number.isSafeInteger(inventory) && inventory > 0 ? inventory : 0;
  return preference === null ? available : Math.min(preference, available);
}
