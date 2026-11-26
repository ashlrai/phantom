import { join } from 'node:path';
import { ledgerJobId } from '../fleet/jobs-ledger-dialect.js';
import { readJobsTail } from '../fleet/report-ledger.js';
import { readTelemetryFile } from '../resources/telemetry.js';
import { isQueueRecord, nonNegativeFinite, nonNegativeSafeInt, pickQueueString } from './schema.js';

export interface SettleInputs {
  load1: number | null; ncpu: number | null; memoryFreePercent: number | null;
  swapGrowthGb: number | null; runningJobs: number | null; launchesLast10Minutes: number | null;
}
/** Host integration supplies its existing fixed interval; no host config is written. */
export interface SettleConfig { enabled?: boolean; legacySeconds?: number }
const record = (v: unknown): Record<string, unknown> => isQueueRecord(v) ? v : {};
const clamp = (v: number): number => Math.max(0, Math.min(1, v));

/** Pure interval policy, not permission to launch. Missing evidence keeps the old interval. */
export function adaptiveSettle(raw: SettleInputs, config: SettleConfig = {}) {
  const inputs: SettleInputs = {
    load1: nonNegativeFinite(raw.load1), ncpu: nonNegativeSafeInt(raw.ncpu) !== null && raw.ncpu! > 0 ? raw.ncpu : null,
    memoryFreePercent: nonNegativeFinite(raw.memoryFreePercent) !== null && raw.memoryFreePercent! <= 100 ? raw.memoryFreePercent : null,
    swapGrowthGb: nonNegativeFinite(raw.swapGrowthGb), runningJobs: nonNegativeSafeInt(raw.runningJobs), launchesLast10Minutes: nonNegativeSafeInt(raw.launchesLast10Minutes),
  };
  const legacySeconds = nonNegativeFinite(config.legacySeconds) !== null && config.legacySeconds! >= 30 ? config.legacySeconds! : 300;
  const enabled = config.enabled === undefined || config.enabled === true;
  let settleSeconds = legacySeconds;
  let reason = 'Adaptive settle disabled; keep the legacy interval.';
  if (enabled) {
    if (inputs.swapGrowthGb !== null && inputs.swapGrowthGb > 0) reason = 'Swap is growing; keep the legacy interval.';
    else if (Object.values(inputs).some(v => v === null)) reason = 'Telemetry is incomplete or stale; keep the legacy interval.';
    else {
      const pressures = [
        ['CPU load', clamp(inputs.load1! / inputs.ncpu! - 1)],
        ['free memory', clamp((35 - inputs.memoryFreePercent!) / 20)],
        ['running jobs', clamp(inputs.runningJobs! / inputs.ncpu! - 1)],
        ['launch burst', clamp((inputs.launchesLast10Minutes! - 3) / 9)],
      ] as const;
      const p = Math.max(...pressures.map(([, pressure]) => pressure));
      // Smoothstep is continuous, monotone and flat at both ends of the pressure range.
      settleSeconds = Math.min(legacySeconds, Math.ceil(30 + (legacySeconds - 30) * p * p * (3 - 2 * p)));
      reason = p === 0 ? 'CPU and memory have headroom; no job or launch burst pressure.'
        : `Pressure from ${pressures.filter(([, pressure]) => pressure === p).map(([name]) => name).join(', ')} increases the interval.`;
    }
  }
  return { inputs, enabled, legacySeconds, settleSeconds, reason };
}
export type SettleDecision = ReturnType<typeof adaptiveSettle>;

const timestamp = (v: unknown): number => typeof v === 'number' && Number.isFinite(v) ? v * 1000 : typeof v === 'string' ? Date.parse(v) : NaN;
/** A short settle needs fresh evidence, even when the older admission report remains usable. */
const fresh = (v: unknown, now: number): boolean => now - timestamp(v) >= 0 && now - timestamp(v) <= 60_000;

/** jobs.jsonl field dialects, the same sets dispatchd `_vc_pick` accepts:
 * ids job|job_id|jobId|id, events event|type|kind, phases
 * outcome|state|status plus producer aliases, timestamps
 * ts|timestamp|at|time|mergedAt|closedAt|recordedAt|updatedAt. */
const LEDGER_EVENT_KEYS = ['event', 'type', 'kind'] as const;
const LEDGER_PHASE_KEYS = ['outcome', 'state', 'status', 'phase', 'result', 'conclusion'] as const;
const LEDGER_TS_KEYS = ['ts', 'timestamp', 'at', 'time', 'mergedAt', 'closedAt', 'recordedAt', 'updatedAt'] as const;
const ledgerTs = (row: Record<string, unknown>): number => {
  for (const key of LEDGER_TS_KEYS) {
    const at = timestamp(row[key]);
    if (Number.isFinite(at)) return at;
  }
  return NaN;
};

export function recentLaunches(text: string | null, truncated: boolean, now: number): number | null {
  if (text === null || !Number.isFinite(now)) return null;
  const launches = new Set<string>();
  let previous = -Infinity; let covered = !truncated;
  for (const line of text.split('\n').filter(line => line.trim())) {
    try {
      const row = record(JSON.parse(line));
      // Eventless rows carrying a phase marker are outcome rows (the
      // batcher/_vc_event inference); a row with neither stays unknown.
      let event = pickQueueString(row, LEDGER_EVENT_KEYS);
      if (event === null && pickQueueString(row, LEDGER_PHASE_KEYS) !== null) event = 'outcome';
      if (event === null) return null;
      if (event !== 'launch') continue; // Reconciled outcomes legitimately carry older event times.
      const at = ledgerTs(row);
      if (!Number.isFinite(at) || (truncated && at < previous) || at > now) return null;
      previous = at;
      if (at <= now - 600_000) covered = true;
      if (at > now - 600_000) {
        const job = ledgerJobId(row);
        if (!job) return null;
        launches.add(`${at}:${job}`);
      }
    } catch { return null; }
  }
  return covered ? launches.size : null;
}

/** Reuse the dispatcher's existing observations; never guess admission-ctl.json's private schema. */
export async function readAdaptiveSettle(root: string, now: number, snapshot: unknown, config?: SettleConfig): Promise<SettleDecision> {
  let status: Record<string, unknown> = {};
  try { status = record(JSON.parse(await readTelemetryFile(join(root, 'queue/status.json')) ?? '{}')); } catch { /* unknown */ }
  const a = record(snapshot); const current = fresh(a.ts, now);
  const jobs = await readJobsTail(join(root, 'metrics/jobs.jsonl'));
  // A zero growth reported without two swap samples is an unmeasured baseline, not calm swap.
  const samples = Array.isArray(a.swap_samples) ? a.swap_samples.filter(v => Array.isArray(v) && v.length === 2 &&
    nonNegativeFinite(v[0]) !== null && nonNegativeFinite(v[1]) !== null && now - v[0] * 1000 >= 0 && now - v[0] * 1000 <= 300_000) : [];
  const measuredSwap = nonNegativeFinite(a.swap_gb) !== null && new Set(samples.map(v => v[0])).size >= 2;
  return adaptiveSettle({
    load1: current ? nonNegativeFinite(a.load1) : null, ncpu: current ? nonNegativeSafeInt(a.ncpu) : null,
    runningJobs: current ? nonNegativeSafeInt(a.running) : null,
    memoryFreePercent: fresh(status.last_tick, now) ? nonNegativeFinite(status.mem_free_pct) : null,
    swapGrowthGb: current && measuredSwap ? nonNegativeFinite(a.swap_growth_gb) : null,
    launchesLast10Minutes: recentLaunches(jobs.text, jobs.truncated, now),
  }, config);
}
