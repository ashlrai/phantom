/**
 * Historical pool-availability explanation over one recorded pool row. Pure:
 * caller-supplied recorded evidence and a caller-supplied `nowMs` only (no
 * clock, env, filesystem, network or provider reads).
 *
 * Recovered from PR #5952 (head 3d6c8fb7c7f7d52655fb3e0f13ef239686f7b886),
 * scheduler/pools.ts poolOpen(). Preserved closure predicates: disabled pools;
 * concurrency <= 0; expiry <= now (equality closes); a known finite balance
 * <= 0 (zero closes); and, when the balance is unknown, usedToday >= softCapPerDay.
 * Unlimited rows skip every balance and cap check.
 *
 * Deliberate differences from the boolean source:
 * - Three states. `open` requires every decisive field to be present, so an
 *   unknown finite balance below its cap is `unknown`, not open.
 * - Missing enabled, concurrency, unlimited or expiry is `unknown`; the source
 *   treated undefined as open. `expiresAtMs: null` still means "recorded with
 *   no expiry", as in the source. `undefined` means the field is missing.
 * - Non-finite or negative numbers, a non-integral concurrency, a non-boolean
 *   flag, and an invalid `nowMs` or `expiresAtMs` throw RangeError. The source
 *   let NaN fall through and expiry NaN became "no expiry".
 * - A known closure wins over any missing field. The result lists every
 *   known closure reason.
 *
 * The result explains a RECORDED row. It is not live admission, quota
 * evidence, a reset date, a reserve, or permission to execute or spend.
 */

export const RECORDED_POOL_AVAILABILITY_PROVENANCE = {
  sourcePr: 5952,
  sourceSha: '3d6c8fb7c7f7d52655fb3e0f13ef239686f7b886',
  sourceFunction: 'poolOpen',
  basis: 'historical-offline',
} as const;

export interface RecordedPoolEvidence {
  readonly enabled?: boolean | null;
  readonly concurrency?: number | null;
  /** Epoch ms. `null` means the record has no expiry; `undefined` means missing. */
  readonly expiresAtMs?: number | null;
  readonly unlimited?: boolean | null;
  /** Null or undefined means the finite balance is unknown. */
  readonly remaining?: number | null;
  readonly usedToday?: number | null;
  readonly softCapPerDay?: number | null;
  readonly nowMs: number;
}

export type RecordedPoolClosureReason =
  | 'disabled'
  | 'no-concurrency'
  | 'expired'
  | 'balance-exhausted'
  | 'daily-cap-reached';

export type RecordedPoolMissingField =
  | 'enabled'
  | 'concurrency'
  | 'expiresAtMs'
  | 'unlimited'
  | 'remaining'
  | 'usedToday'
  | 'softCapPerDay';

export type RecordedPoolAvailability = (
  | { readonly status: 'closed'; readonly reasons: readonly RecordedPoolClosureReason[] }
  | { readonly status: 'open'; readonly basis: 'unlimited' | 'positive-balance' }
  | { readonly status: 'unknown'; readonly missing: readonly RecordedPoolMissingField[] }
) & {
  readonly provenance: typeof RECORDED_POOL_AVAILABILITY_PROVENANCE;
  readonly historicalOnly: true;
};

function finiteNonNegative(name: string, value: number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new RangeError(`${name} must be a finite number >= 0`);
  }
  return value;
}

function flag(name: string, value: boolean | null | undefined): boolean | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'boolean') throw new RangeError(`${name} must be a boolean`);
  return value;
}

export function explainRecordedPoolAvailability(evidence: RecordedPoolEvidence): RecordedPoolAvailability {
  const base = { provenance: RECORDED_POOL_AVAILABILITY_PROVENANCE, historicalOnly: true } as const;
  if (typeof evidence.nowMs !== 'number' || !Number.isFinite(evidence.nowMs) || evidence.nowMs < 0) {
    throw new RangeError('nowMs must be a finite epoch-ms number >= 0');
  }
  const now = evidence.nowMs;
  const enabled = flag('enabled', evidence.enabled);
  const unlimited = flag('unlimited', evidence.unlimited);
  const concurrency = finiteNonNegative('concurrency', evidence.concurrency);
  if (concurrency !== null && !Number.isInteger(concurrency)) {
    throw new RangeError('concurrency must be an integer >= 0');
  }
  const expiresAtMs = finiteNonNegative('expiresAtMs', evidence.expiresAtMs);
  const remaining = finiteNonNegative('remaining', evidence.remaining);
  const usedToday = finiteNonNegative('usedToday', evidence.usedToday);
  const softCapPerDay = finiteNonNegative('softCapPerDay', evidence.softCapPerDay);

  // Balance checks apply only when the row is known to be finite (unlimited false).
  const finite = unlimited === false;
  const reasons: RecordedPoolClosureReason[] = [];
  if (enabled === false) reasons.push('disabled');
  if (concurrency === 0) reasons.push('no-concurrency');
  if (expiresAtMs !== null && expiresAtMs <= now) reasons.push('expired');
  if (finite && remaining === 0) reasons.push('balance-exhausted');
  if (finite && remaining === null && usedToday !== null && softCapPerDay !== null && usedToday >= softCapPerDay) {
    reasons.push('daily-cap-reached');
  }
  if (reasons.length > 0) return { status: 'closed', reasons, ...base };

  const positiveBalance = finite && remaining !== null && remaining > 0;
  const expiryKnown = evidence.expiresAtMs !== undefined;
  // Open only when the row is open under every value the missing unlimited flag could take.
  const open =
    enabled === true &&
    concurrency !== null && concurrency > 0 &&
    expiryKnown &&
    (unlimited === true || positiveBalance);
  if (open) return { status: 'open', basis: unlimited === true ? 'unlimited' : 'positive-balance', ...base };

  const missing: RecordedPoolMissingField[] = [];
  if (enabled === null) missing.push('enabled');
  if (concurrency === null) missing.push('concurrency');
  if (!expiryKnown) missing.push('expiresAtMs');
  if (unlimited === null) missing.push('unlimited');
  if (unlimited !== true && remaining === null) {
    missing.push('remaining');
    if (usedToday === null) missing.push('usedToday');
    if (softCapPerDay === null) missing.push('softCapPerDay');
  }
  return { status: 'unknown', missing, ...base };
}
