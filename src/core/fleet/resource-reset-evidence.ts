/** Display evidence only. No admission decision or inferred zero usage. */
export const QUOTA_EVIDENCE_MAX_AGE_MS = 5 * 60_000;
export interface QuotaMeasurement {
  lane: string;
  window: 'weekly' | 'credits' | 'none';
  usedPct: number | null;
  resetAt: string | null;
  source: string | null;
  /** The quota's captured timestamp; controller last_tick never substitutes for it. */
  observedAt: string | null;
}
export interface QuotaEvidence {
  state: 'exhausted' | 'observed-headroom' | 'refresh-needed' | 'unknown';
  reason: 'quota-recovered' | 'reset-passed' | 'stale-or-invalid-reading' | 'measured-quota' | 'status-quota' | 'no-reading';
  holdConflict: 'recovered-quota-while-held' | null;
  statusQuota: QuotaMeasurement | null;
  measuredQuota: QuotaMeasurement | null;
  maxAgeMs: number;
}
const time = (value: string | null): number => value === null ? NaN : Date.parse(value);
/** Budget overrides can carry ISO timestamps or Unix seconds. A tick is never the quota's capture time. */
export function budgetTimestamp(value: unknown): string | null {
  if (typeof value === 'string') {
    return /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:?\d\d)$/.test(value) && Number.isFinite(Date.parse(value))
      ? value : null;
  }
  const at = typeof value === 'number' ? value * 1000 : NaN;
  return Number.isFinite(at) && at > 0 && at <= 8.64e15 ? new Date(at).toISOString() : null;
}
const valid = (row: QuotaMeasurement | null): row is QuotaMeasurement =>
  row !== null && row.window === 'weekly' && row.usedPct !== null && Number.isFinite(row.usedPct) && row.usedPct >= 0;

/** Provider-neutral comparison, scoped to an identical lane and weekly quota. */
export function quotaEvidence(
  status: QuotaMeasurement | null, measured: QuotaMeasurement | null, held: boolean | null, now: number,
): QuotaEvidence {
  const evidence: QuotaEvidence = { state: 'unknown', reason: 'no-reading', holdConflict: null,
    statusQuota: status, measuredQuota: measured, maxAgeMs: QUOTA_EVIDENCE_MAX_AGE_MS };
  const row = measured ?? status;
  if (!row || !valid(row)) return evidence;
  const at = time(row.observedAt);
  const reset = time(row.resetAt);
  // Even a recently observed counter belongs to an expired window after reset.
  if (Number.isFinite(reset) && reset <= now) {
    return { ...evidence, state: 'refresh-needed', reason: 'reset-passed' };
  }
  if (!Number.isFinite(at) || at > now || now - at > QUOTA_EVIDENCE_MAX_AGE_MS) {
    return { ...evidence, state: 'refresh-needed', reason: 'stale-or-invalid-reading' };
  }
  // A dispatcher tick does not establish the freshness of its cached quota.
  if (!measured) {
    return { ...evidence, state: row.usedPct! >= 100 ? 'exhausted' : 'unknown', reason: 'status-quota' };
  }
  evidence.state = row.usedPct! >= 100 ? 'exhausted' : 'observed-headroom';
  evidence.reason = 'measured-quota';
  const statusAt = status ? time(status.observedAt) : NaN;
  const statusReset = status ? time(status.resetAt) : NaN;
  if (valid(status) && status.lane === measured.lane && status.usedPct! >= 100 && measured.usedPct! < 100 &&
      Number.isFinite(statusAt) && statusAt < at &&
      Number.isFinite(statusReset) && statusAt < statusReset && Number.isFinite(reset) && reset > at &&
      // Equal boundaries permit early/manual resets; advancing boundaries permit scheduled resets.
      reset >= statusReset) {
    evidence.reason = 'quota-recovered';
    if (held === true) evidence.holdConflict = 'recovered-quota-while-held';
  }
  return evidence;
}
