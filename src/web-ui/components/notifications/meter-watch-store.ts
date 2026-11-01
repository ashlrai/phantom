/**
 * components/notifications/meter-watch-store.ts — localStorage persistence
 * for the meter-watch sample log. The stuck-meter check needs an hour of
 * remembered readings, which has to survive a page reload (the console is
 * reloaded far more often than a meter stalls), so the log lives under one
 * key. Same class of persistence as the theme toggle: operational history,
 * never a secret.
 *
 * Never throws: unreadable storage, unparseable JSON and wrong shapes all
 * yield an empty log — losing the history only resets the stall clock,
 * while throwing would take the whole notification engine down with it.
 */
import type { MeterWatchLog } from './meter-watch-model.js';

export const METER_WATCH_STORAGE_KEY = 'phantom.meterWatch.v1';

const record = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const nullableNumber = (v: unknown): boolean => v === null || finite(v);
const isSample = (v: unknown): boolean =>
  record(v) && finite(v.at) && v.at >= 0 && nullableNumber(v.usedPct) && nullableNumber(v.creditsRemaining);

/** Read the persisted log; corrupt or missing storage yields an empty log. */
export function loadMeterWatchLog(): MeterWatchLog {
  try {
    const raw = localStorage.getItem(METER_WATCH_STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!record(parsed)) return {};
    const log: MeterWatchLog = {};
    for (const [lane, samples] of Object.entries(parsed)) {
      if (!Array.isArray(samples)) continue;
      const valid = samples.filter(isSample);
      if (valid.length > 0) log[lane] = valid;
    }
    return log;
  } catch {
    return {};
  }
}

/** Persist the log; failures are swallowed for the same reason as load. */
export function saveMeterWatchLog(log: MeterWatchLog): void {
  try {
    localStorage.setItem(METER_WATCH_STORAGE_KEY, JSON.stringify(log));
  } catch {
    /* best-effort */
  }
}
