/** Shared display evidence. This projection never supplies execution authority. */
import { accountStatus, hasCurrentUsage, type AccountStatus, type CapacityRow } from '../usage/capacity-strip-model.js';
import { DEFAULT_RESOURCE_OBSERVATION_MAX_AGE_MS } from '../../../../core/resources/provider-aggregation-types.js';
import { currentQuotaReading } from '../../../../core/verse/quota-freshness.js';

export type ResourceUsageDisplayState = 'current' | 'retained' | 'historical' | 'missing' | 'signed-out' | 'not-applicable';

export interface ResourceDisplayView {
  usage: {
    state: ResourceUsageDisplayState;
    observedAt: string | null;
    current: boolean;
    freshness: 'current' | 'stale' | 'unconfirmed' | 'missing';
    label: string;
    summary: string;
  };
  connection: { checkedAt: string | null };
  credit: { current: boolean; observedAt: string | null; expiresAt: string | null };
  status: AccountStatus;
}

function canonicalInstant(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value ? value : null;
}
function observedInstant(value: string | null | undefined, nowMs: number): string | null {
  const instant = canonicalInstant(value);
  return instant !== null && Number.isFinite(nowMs) && nowMs >= 0 && Date.parse(instant) <= nowMs ? instant : null;
}

/** The capacity builder owns usage validation. Health/readiness do not restamp its evidence. */
export function projectResourceDisplay(row: CapacityRow, options: { nowMs: number; healthRead: boolean; maxAgeMs?: number }): ResourceDisplayView {
  const connection = { checkedAt: observedInstant(row.connectionCheckedAt, options.nowMs) };
  const time = observedInstant(row.usageObservedAt, options.nowMs);
  const historyTime = observedInstant(row.historicalUsage?.observedAt, options.nowMs);
  const maxAgeMs = options.maxAgeMs ?? DEFAULT_RESOURCE_OBSERVATION_MAX_AGE_MS;
  const policyValid = Number.isSafeInteger(maxAgeMs) && maxAgeMs > 0 && maxAgeMs <= 24 * 60 * 60_000;
  const ageStale = time !== null && policyValid && options.nowMs - Date.parse(time) > maxAgeMs;
  const sourceExpiry = canonicalInstant(row.quotaExpiresAt);
  const sourceExpired = sourceExpiry !== null && Date.parse(sourceExpiry) <= options.nowMs;
  const creditObservedAt = observedInstant(row.creditObservedAt, options.nowMs);
  const creditExpiry = canonicalInstant(row.creditsExpiresAt);
  const creditCurrent = row.engine === 'codex' && row.creditState !== undefined && row.creditState !== 'unknown'
    && !row.signedOut && !row.lastReading && policyValid
    && creditObservedAt !== null && options.nowMs - Date.parse(creditObservedAt) <= maxAgeMs
    && currentQuotaReading(creditObservedAt, creditExpiry, options.nowMs);
  const credit = { current: creditCurrent, observedAt: creditObservedAt, expiresAt: creditExpiry };
  let status = accountStatus(creditCurrent ? row : { ...row, credits: null, creditState: 'unknown', creditBalance: null },
    { now: options.nowMs, healthRead: options.healthRead });
  const resetExpired = row.windows.some(window => {
    const reset = canonicalInstant(window.resetsAt);
    return reset !== null && Date.parse(reset) <= options.nowMs;
  });
  const ageConfirmed = policyValid && time !== null && !ageStale
    && currentQuotaReading(time, sourceExpiry, options.nowMs, row.windows.map(window => window.resetsAt));
  let state: ResourceUsageDisplayState;
  if (row.kind === 'local') state = 'not-applicable';
  else if (row.signedOut) state = 'signed-out';
  else if (hasCurrentUsage(row) && time !== null && ageConfirmed) state = 'current';
  else if (row.windows.some(window => window.usedPercent !== null || window.limitReached)) state = 'retained';
  else if (historyTime !== null) state = 'historical';
  else state = 'missing';

  const labels: Record<ResourceUsageDisplayState, string> = {
    current: 'Current usage',
    retained: 'Last reading · current usage unconfirmed',
    historical: 'Last reading · current usage unconfirmed',
    missing: 'No current usage reading',
    'signed-out': 'Signed out · current usage unconfirmed',
    'not-applicable': 'Local readiness',
  };
  const observedAt = state === 'historical' ? historyTime
    : state === 'current' || state === 'retained' ? time : null;
  const freshness = state === 'current' ? 'current' : state === 'missing' || state === 'not-applicable' ? 'missing'
    : ageStale || sourceExpired || resetExpired || historyTime !== null && policyValid && options.nowMs - Date.parse(historyTime) > maxAgeMs ? 'stale' : 'unconfirmed';
  const summary = state === 'current' || state === 'not-applicable' ? row.summary
    : state === 'retained' ? row.lastReading
      ? 'Last known usage · latest check failed · current availability unconfirmed'
      : time === null ? 'Usage observation time unconfirmed · current availability unconfirmed'
      : sourceExpired ? 'Last known usage · original source expiry has passed · current availability unconfirmed'
      : sourceExpiry === null ? 'Usage source expiry unconfirmed · current availability unconfirmed'
      : resetExpired ? 'Last known usage · recorded window reset has passed · current availability unconfirmed'
      : 'Last known usage · reading age unconfirmed or stale · current availability unconfirmed'
    : state === 'historical' ? 'Last known usage · current availability and resets unconfirmed'
    : state === 'signed-out' ? 'Signed out · reconnect to check current usage'
    : 'Usage not reported by this resource.';
  if (row.kind === 'subscription' && state !== 'current' && state !== 'signed-out') {
    const connectionCurrent = connection.checkedAt !== null && policyValid
      && options.nowMs - Date.parse(connection.checkedAt) <= maxAgeMs;
    status = { ...status, kind: 'not-checked', label: connectionCurrent && row.connection !== null ? row.connection.word : 'Usage unconfirmed',
      detail: summary, tone: connectionCurrent && row.connection !== null ? row.connection.tone : 'neutral', usableAgain: null,
      coversConnection: connectionCurrent && row.connection !== null, checked: null, checkedTitle: null };
    // seatSubscription independently rejects expired/failed native credit reads.
    // An unconfirmed quota does not revoke that separate, qualified fact.
    if (creditCurrent && row.credits !== null) {
      const held = row.creditSpendControlReached === true;
      status = { ...status, kind: held ? 'unavailable' : 'low', label: held ? 'Credits held' : 'Credits available',
        detail: `${held ? 'native spend control reached' : 'native credit balance'} · separate from subscription usage · current usage unconfirmed`,
        tone: held ? 'danger' : 'warning', coversConnection: false };
    }
  }
  return { usage: { state, observedAt, current: state === 'current', freshness, label: labels[state], summary }, connection, credit, status };
}
