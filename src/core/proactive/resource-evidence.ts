/** Pure projection of public host snapshots. No collectors, probes, credentials, IO or clock reads. */
import type { SeatCapacity } from '../routing/headroom.js';
import type { ResourceConnectionsSnapshot } from '../resources/connection-types.js';
import type { CreditPoolReadView } from '../resources/credit-pool-types.js';
import type { ProactiveProfile } from './types.js';
import type { ProactiveEvidenceState, ProactiveResourceCost, ProactiveResourceCredit,
  ProactiveResourceEvidenceResponse, ProactiveResourceEvidenceRow, ProactiveResourceIdentity, ProactiveResourceKind } from './resource-evidence-types.js';

export interface ProactiveCapacityEvidence { identity: ProactiveResourceIdentity; capacity: SeatCapacity }
/** Caller must supply cost evidence explicitly; percent usage never becomes currency or tokens. */
export interface ProactiveCostEvidence {
  resourceId: string; identity: ProactiveResourceIdentity; state: 'actual' | 'estimated';
  value: number; currency: string | null; units: string; source: string; asOf: string;
}
/** Synthetic/public host funding evidence only; this module never loads financial records. */
export interface ProactiveFundingEvidence {
  poolId: string; identity: ProactiveResourceIdentity; kind: ProactiveResourceCredit['kind'];
  recordKind: 'balance' | 'purchase' | 'grant'; amount: string | null; total?: string | null;
  unit: string; surface: string; source: string; asOf: string | null; expiresAt?: string | null;
  fundingProductId?: string | null; fundingAccountId?: string | null;
  eligibilityState?: 'declared' | 'unknown'; eligibleSurfaces?: string[]; excludedSurfaces?: string[];
}
export interface ProactiveResourceSnapshots {
  profiles?: ProactiveProfile[] | unknown; connections?: ResourceConnectionsSnapshot | null | unknown;
  capacities?: ProactiveCapacityEvidence[] | unknown; creditPools?: CreditPoolReadView | null | unknown;
  costs?: ProactiveCostEvidence[] | unknown;
  fundingEvidence?: ProactiveFundingEvidence[] | unknown;
}
export interface ProactiveResourceProjectionOptions { nowMs: number; maxAgeMs?: number }
const MAX_ROWS = 512, MAX_WINDOWS = 64, DEFAULT_MAX_AGE = 15 * 60_000;
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error('Invalid snapshot object');
  const keys = Reflect.ownKeys(value);
  if (keys.length > 64 || keys.some(key => typeof key !== 'string' || !('value' in Object.getOwnPropertyDescriptor(value, key)!))) throw new Error('Invalid snapshot fields');
  return value as Record<string, unknown>;
}
function array(value: unknown, max = MAX_ROWS): unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > max ||
    Reflect.ownKeys(value).length !== value.length + 1 || Array.from({ length: value.length }, (_, i) => Object.getOwnPropertyDescriptor(value, String(i))).some(d => !d || !('value' in d))) throw new Error('Invalid snapshot list');
  return value;
}
function text(value: unknown, max = 256): string {
  if (typeof value !== 'string' || !value || value.length > max || [...value].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) throw new Error('Invalid snapshot reference');
  return value;
}
function slug(value: unknown): string { const result = text(value, 64); if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(result)) throw new Error('Invalid slug'); return result; }
function nullableText(value: unknown, max = 256): string | null { return value === null || value === undefined ? null : text(value, max); }
function instant(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const result = text(value, 32); if (!Number.isFinite(Date.parse(result)) || new Date(result).toISOString() !== result) throw new Error('Invalid timestamp'); return result;
}
function number(value: unknown, max = Number.MAX_SAFE_INTEGER): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > max) throw new Error('Invalid measurement'); return value;
}
function decimal(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const result = text(value, 64); if (!/^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/u.test(result)) throw new Error('Invalid native amount'); return result;
}
function oneOf<T extends string>(value: unknown, choices: readonly T[]): T { if (!choices.includes(value as T)) throw new Error('Invalid snapshot state'); return value as T; }
function bool(value: unknown): boolean { if (typeof value !== 'boolean') throw new Error('Invalid boolean'); return value; }
function identity(value: unknown): ProactiveResourceIdentity {
  const raw = record(value); return { provider: slug(raw.provider), accountId: nullableText(raw.accountId), agentId: nullableText(raw.agentId) };
}
function identityKey(value: ProactiveResourceIdentity): string { return JSON.stringify([value.provider, value.accountId, value.agentId]); }
function resourceId(prefix: string, value: ProactiveResourceIdentity, id: string): string {
  return `${prefix}:${encodeURIComponent(value.provider)}:${encodeURIComponent(value.accountId ?? '')}:${encodeURIComponent(id)}`;
}
function fresh(asOf: string | null, expiresAt: string | null, opts: Required<ProactiveResourceProjectionOptions>): ProactiveEvidenceState {
  if (!asOf) return 'missing';
  const observed = Date.parse(asOf);
  if (observed > opts.nowMs || expiresAt && Date.parse(expiresAt) <= observed) return 'invalid';
  return opts.nowMs - observed > opts.maxAgeMs || expiresAt !== null && Date.parse(expiresAt) <= opts.nowMs ? 'stale' : 'current';
}
function unknownCost(evidenceState: ProactiveEvidenceState = 'missing'): ProactiveResourceCost {
  return { state: 'unknown', value: null, currency: null, units: null, source: null, asOf: null, evidenceState };
}
function base(resource: string, label: string, ident: ProactiveResourceIdentity, kind: ProactiveResourceKind, source: string, asOf: string | null,
  state: ProactiveEvidenceState): ProactiveResourceEvidenceRow {
  return { resourceId: resource, label, identity: ident, kind, identityState: ident.accountId === null ? 'unknown' : 'observed-reference',
    connectionState: 'unknown', capabilityState: 'unknown', capabilityIds: [], entitlementState: 'unknown', readinessState: 'unknown',
    evidenceState: state, source, asOf, usageWindows: [], credits: [], cost: unknownCost(), executionAuthorized: false,
    notes: ['Display evidence does not establish entitlement, authorization or provider eligibility.'] };
}
function windows(value: unknown, asOf: string | null, state: ProactiveEvidenceState): ProactiveResourceEvidenceRow['usageWindows'] {
  const ids = new Set<string>();
  return array(value, MAX_WINDOWS).map(item => {
    const row = record(item), id = text(row.id, 128); if (ids.has(id)) throw new Error('Duplicate usage window'); ids.add(id);
    const native = row.nativeReport === undefined || row.nativeReport === null ? null : record(row.nativeReport);
    const measured = row.measured === undefined ? true : bool(row.measured);
    const reported = number(row.usedPercent, 100);
    return { id, usedPercent: state === 'current' && measured ? reported : null, resetsAt: instant(row.resetsAt),
      resetDescription: nullableText(native?.resetDescription ?? row.resetDescription, 512), limitReached: bool(row.limitReached ?? false),
      observedAt: asOf, evidenceState: state === 'current' && (reported === null || !measured) ? 'missing' : state };
  });
}
function credit(row: Record<string, unknown>, opts: Required<ProactiveResourceProjectionOptions>, state?: ProactiveEvidenceState): ProactiveResourceCredit {
  const asOf = instant(row.capturedAt), expiresAt = instant(row.expiresAt);
  const expired = expiresAt !== null && Date.parse(expiresAt) <= opts.nowMs;
  const temporalState = state ?? fresh(asOf, null, opts), evidenceState = temporalState === 'current' && expired ? 'stale' : temporalState;
  const recordKind = row.recordKind === undefined ? 'balance' : oneOf(row.recordKind, ['balance', 'purchase', 'grant']);
  const eligibilityState = row.eligibilityState === undefined ? 'unknown' : oneOf(row.eligibilityState, ['declared', 'unknown']);
  const surfaceList = (value: unknown): string[] => {
    const result = value === undefined ? [] : array(value, 32).map(slug);
    if (new Set(result).size !== result.length) throw new Error('Duplicate funding eligibility surface'); return result;
  };
  const eligibleSurfaces = surfaceList(row.eligibleSurfaces), excludedSurfaces = surfaceList(row.excludedSurfaces);
  if (eligibleSurfaces.some(surface => excludedSurfaces.includes(surface)) || eligibilityState === 'unknown' && (eligibleSurfaces.length || excludedSurfaces.length)) throw new Error('Conflicting eligibility declaration');
  // Preserve original decimal receipts, but never promote them to remaining balance or metered spend.
  const reportedAmount = decimal(row.amount), reportedTotal = decimal(row.total);
  return { poolId: text(row.poolId), kind: oneOf(row.kind, ['gifted-cloud', 'purchased-usage', 'subscription-allowance', 'native-credit', 'promotional-api']),
    amount: recordKind === 'balance' && evidenceState === 'current' ? reportedAmount : null,
    total: recordKind === 'balance' && evidenceState === 'current' ? reportedTotal : null,
    unit: text(row.unit, 64), surface: text(row.surface, 64), source: text(row.source, 128), asOf, expiresAt,
    expiryDate: null, expiryState: expiresAt === null ? 'unknown' : expired ? 'expired' : 'upcoming', evidenceState,
    fundingProductId: nullableText(row.fundingProductId), fundingAccountId: nullableText(row.fundingAccountId), eligibilityState, eligibleSurfaces, excludedSurfaces,
    recordKind, receiptAmount: recordKind !== 'balance' && (evidenceState === 'current' || evidenceState === 'stale') ? reportedAmount : null };
}
function conflicted(row: ProactiveResourceEvidenceRow): void {
  row.evidenceState = 'conflict'; row.identityState = 'conflict'; row.connectionState = 'unknown'; row.readinessState = 'unknown';
  row.usageWindows = row.usageWindows.map(window => ({ ...window, usedPercent: null, evidenceState: 'conflict' }));
  row.credits = row.credits.map(value => ({ ...value, amount: null, total: null, receiptAmount: null, evidenceState: 'conflict' })); row.cost = unknownCost('conflict');
  row.notes.push('Conflicting identity or source rows; measurements are unknown.');
}

export function projectProactiveResourceEvidence(input: ProactiveResourceSnapshots, options: ProactiveResourceProjectionOptions): ProactiveResourceEvidenceResponse {
  if (!Number.isFinite(options.nowMs) || options.nowMs < 0 || !Number.isFinite(new Date(options.nowMs).getTime()) ||
    options.maxAgeMs !== undefined && (!Number.isSafeInteger(options.maxAgeMs) || options.maxAgeMs < 1 || options.maxAgeMs > 24 * 60 * 60_000)) throw new Error('Invalid projection clock');
  const opts = { nowMs: options.nowMs, maxAgeMs: options.maxAgeMs ?? DEFAULT_MAX_AGE };
  const resources: ProactiveResourceEvidenceRow[] = [], notes: string[] = [];
  try { record(input); }
  catch { return { schemaVersion: 1, sampledAt: new Date(opts.nowMs).toISOString(), sourceState: 'invalid', resources: [], executionAuthorized: false,
    notes: ['Invalid snapshot envelope; no sources were evaluated.'] }; }
  let invalid = false, present = false;
  const collect = (source: string, supplied: unknown, project: () => ProactiveResourceEvidenceRow[]) => {
    if (supplied === undefined || supplied === null) return;
    present = true;
    try { const rows = project(); if (resources.length + rows.length > MAX_ROWS) throw new Error('Too many resources'); resources.push(...rows); }
    catch { invalid = true; notes.push(`${source} snapshot invalid or exceeds bounds; its rows were withheld.`); }
  };
  collect('profiles', input.profiles, () => array(input.profiles).map(item => {
    const profile = record(item), ident = identity(profile.identity);
    if (ident.accountId === null || ident.agentId === null || profile.connection !== 'configured' || profile.capabilityVerification !== 'declared-unverified') throw new Error('Invalid declared profile');
    const capabilities = array(profile.capabilityIds, 32).map(slug); if (new Set(capabilities).size !== capabilities.length) throw new Error('Duplicate capabilities');
    const updatedAt = instant(profile.updatedAt);
    const row = base(text(profile.id), text(profile.displayName, 120), ident, 'personal-agent', 'declared-profile', updatedAt,
      updatedAt !== null && Date.parse(updatedAt) > opts.nowMs ? 'invalid' : 'missing');
    row.identityState = 'declared'; row.connectionState = 'configured'; row.capabilityState = 'declared-unverified'; row.capabilityIds = capabilities;
    row.readinessState = bool(profile.enabled) ? 'unverified' : 'blocked'; row.notes.push('Capabilities and preferences are declared; no qualified personal-agent transport is implied.'); return row;
  }));
  collect('connections', input.connections, () => {
    const snapshot = record(input.connections); const sampledAt = instant(snapshot.sampledAt);
    if (sampledAt === null || Date.parse(sampledAt) > opts.nowMs) throw new Error('Invalid snapshot time');
    return array(snapshot.accounts).map(item => {
      const account = record(item), ident = { provider: slug(account.provider), accountId: text(account.id), agentId: null };
      const asOf = instant(account.observedAt), expiresAt = instant(account.expiresAt), state = fresh(asOf, expiresAt, opts);
      const connection = oneOf(account.state, ['checking', 'observed', 'signed-out', 'unavailable']);
      const authentication = oneOf(account.authentication, ['signed-in', 'signed-out', 'unknown']);
      const health = oneOf(account.health, ['reachable', 'unknown', 'unavailable']);
      const row = base(resourceId('native', ident, ident.accountId), text(account.label, 120), ident, 'native-subscription', 'native-connection-snapshot', asOf, state);
      row.connectionState = state === 'current' ? connection === 'checking' ? 'unknown' : connection : 'unknown';
      row.readinessState = state !== 'current' ? 'unknown' : connection === 'signed-out' || connection === 'unavailable' || health === 'unavailable' ? 'blocked'
        : authentication === 'signed-in' && health === 'reachable' && bool(account.executionSupported) ? 'adapter-reported' : 'unverified';
      row.capabilityState = row.readinessState === 'adapter-reported' ? 'adapter-reported' : 'unknown';
      const measurementState = state === 'current' && (connection !== 'observed' || authentication !== 'signed-in' || health === 'unavailable') ? 'missing' : state;
      row.usageWindows = windows(account.windows, asOf, measurementState);
      if (account.codexCredits !== undefined && account.codexCredits !== null) {
        const native = record(account.codexCredits); bool(native.hasCredits); bool(native.unlimited);
        row.credits.push(credit({ poolId: 'native-reported', kind: 'native-credit', amount: decimal(native.balance), total: null, unit: 'provider-credit',
          surface: 'over-plan-usage', capturedAt: asOf, expiresAt: null, source: 'native-connection-snapshot' }, opts, measurementState));
        if (native.unlimited) row.notes.push('Provider reports unlimited credits; no numeric amount or entitlement is inferred.');
      }
      return row;
    });
  });
  collect('capacities', input.capacities, () => array(input.capacities).map(item => {
    const wrapper = record(item), ident = identity(wrapper.identity), capacity = record(wrapper.capacity), seatId = text(capacity.seatId);
    const engine = slug(capacity.engine), kind: ProactiveResourceKind = engine === 'local' ? 'local' : engine.endsWith('-api') || capacity.costBasis === 'per-token' ? 'api' : 'native-subscription';
    const asOf = instant(capacity.observedAt), state = fresh(asOf, null, opts);
    const row = base(resourceId('seat', ident, seatId), text(capacity.label, 120), ident, kind, 'seat-capacity-snapshot', asOf, state);
    row.usageWindows = windows(capacity.windows, asOf, state);
    const signedOut = bool(capacity.signedOut), reachable = capacity.reachable === null ? null : bool(capacity.reachable);
    row.connectionState = state !== 'current' ? 'unknown' : signedOut ? 'signed-out' : reachable === true ? 'observed' : reachable === false ? 'unavailable' : 'unknown';
    row.readinessState = state !== 'current' ? 'unknown' : signedOut || reachable === false ? 'blocked' : reachable === true ? 'adapter-reported' : 'unverified';
    if (state === 'current' && (signedOut || reachable === false)) row.usageWindows = row.usageWindows.map(window => ({ ...window, usedPercent: null, evidenceState: 'missing' }));
    const spent = number(capacity.spentTodayUsd);
    // SeatCapacity defines spentTodayUsd as reported metered spend, not a subscription-price estimate.
    // Preserve actual zero only with a fresh capture; local/free labels never manufacture zero cost.
    if (spent !== null && state === 'current') row.cost = { state: 'actual', value: spent, currency: 'USD', units: 'today', source: 'seat-capacity-spent-today', asOf, evidenceState: state };
    else if (state !== 'current') row.cost = unknownCost(state);
    if (kind === 'native-subscription' && (ident.accountId !== seatId || ident.provider !== engine)) conflicted(row);
    if (capacity.claudeApiGrant !== undefined) {
      const grant = record(capacity.claudeApiGrant);
      if (grant.v !== 1 || grant.automaticAdmission !== 'held' || kind !== 'api') throw new Error('Invalid promotion view');
      if (grant.state === 'recorded') {
        const capturedAt = instant(grant.capturedAt), creditState = fresh(capturedAt, null, opts);
        const promotion = credit({ poolId: 'api-promotion-history', kind: 'promotional-api', amount: decimal(grant.remainingUsdMicros), total: decimal(grant.totalUsdMicros),
          unit: 'USD-micros', surface: 'api', capturedAt, expiresAt: null, source: 'claude-api-grant-history' }, opts, creditState);
        if (grant.expiryDate !== null) {
          const date = text(grant.expiryDate, 10); if (!/^\d{4}-\d{2}-\d{2}$/u.test(date) || new Date(`${date}T00:00:00.000Z`).toISOString().slice(0, 10) !== date) throw new Error('Invalid expiry date');
          promotion.expiryDate = date;
          const today = new Date(opts.nowMs).toISOString().slice(0, 10);
          promotion.expiryState = date < today ? 'expired' : date > today ? 'upcoming' : 'unknown';
          // A date before today is expired without inventing a provider expiry instant.
          if (promotion.expiryState === 'expired' && promotion.evidenceState === 'current') {
            promotion.evidenceState = 'stale'; promotion.amount = null; promotion.total = null;
          }
        }
        row.credits.push(promotion); row.notes.push('API promotional history is independent of subscription allowance and never authorizes API spending.');
      } else oneOf(grant.state, ['missing', 'unavailable']);
    }
    return row;
  }));
  collect('credit-pools', input.creditPools, () => {
    const view = record(input.creditPools); if (view.v !== 1) throw new Error('Invalid credit view');
    const sourceState = oneOf(view.sourceState, ['healthy', 'missing', 'unavailable']); const items = array(view.rows);
    if (sourceState !== 'healthy' && items.length) throw new Error('Invalid credit source');
    return items.map(item => {
      const pool = record(item), ident = { provider: slug(pool.provider), accountId: text(pool.accountId), agentId: null };
      const identityState = oneOf(pool.identityState, ['matched', 'unknown', 'mismatch']);
      const poolState = oneOf(pool.evidenceState, ['recorded', 'current-native', 'stale-native', 'identity-unknown', 'identity-mismatch']);
      const asOf = instant(pool.capturedAt), state = identityState === 'mismatch' || poolState === 'identity-mismatch' ? 'conflict'
        : identityState !== 'matched' || poolState === 'identity-unknown' ? 'missing' : poolState === 'stale-native' ? 'stale' : fresh(asOf, null, opts);
      oneOf(pool.surface, ['cloud-session', 'over-plan-usage', 'subscription']); const source = record(pool.source);
      const row = base(resourceId('credit-pool', ident, text(pool.poolId)), `Credit pool ${text(pool.poolId)}`, ident,
        'funding-pool', 'credit-pool-snapshot', asOf, state);
      row.credits = [credit({ ...pool, source: `${oneOf(source.kind, ['verified-manual', 'native-metadata'])}:${text(source.adapter, 64)}` }, opts, state)];
      row.identityState = identityState === 'matched' ? 'observed-reference' : identityState === 'mismatch' ? 'conflict' : 'unknown';
      row.notes.push('Credit amount, surface and expiry are provider-native display evidence; no execution entitlement or price conversion.'); return row;
    });
  });
  collect('funding-evidence', input.fundingEvidence, () => array(input.fundingEvidence).map(item => {
    const funding = record(item), ident = identity(funding.identity), asOf = instant(funding.asOf), state = fresh(asOf, null, opts);
    const row = base(resourceId('funding-evidence', ident, text(funding.poolId)), `Funding evidence ${text(funding.poolId)}`, ident,
      'funding-pool', 'host-funding-evidence', asOf, state);
    row.identityState = ident.accountId === null ? 'unknown' : 'declared';
    row.credits = [credit({ ...funding, capturedAt: asOf }, opts, state)];
    row.evidenceState = row.credits[0]!.evidenceState;
    const fundingAccountId = row.credits[0]!.fundingAccountId;
    if (fundingAccountId !== null && fundingAccountId !== ident.accountId) conflicted(row);
    row.notes.push('Funding product/account and eligibility are declared host evidence; eligible surfaces never establish permission or transport.');
    if (row.credits[0]!.recordKind !== 'balance') row.notes.push('Historical purchase/grant amount is a receipt; remaining balance and consumed spend remain unknown.');
    return row;
  }));
  const byId = new Map<string, ProactiveResourceEvidenceRow[]>();
  for (const row of resources) { const duplicate = byId.get(row.resourceId) ?? []; duplicate.push(row); byId.set(row.resourceId, duplicate); }
  for (const duplicate of byId.values()) if (duplicate.length > 1) duplicate.forEach(conflicted);
  // Independent public sources may disagree. Do not silently pick the more optimistic account reading.
  const nativeRows = resources.filter(row => row.kind === 'native-subscription' && row.source !== 'credit-pool-snapshot');
  const sourceConflicts = new Set<ProactiveResourceEvidenceRow>();
  for (let i = 0; i < nativeRows.length; i++) for (let j = i + 1; j < nativeRows.length; j++) {
    const left = nativeRows[i]!, right = nativeRows[j]!;
    if (identityKey(left.identity) !== identityKey(right.identity) || left.evidenceState !== 'current' || right.evidenceState !== 'current') continue;
    const disagreement = left.usageWindows.some(a => right.usageWindows.some(b => a.id === b.id &&
      (a.usedPercent !== null && b.usedPercent !== null && a.usedPercent !== b.usedPercent || a.resetsAt !== null && b.resetsAt !== null && a.resetsAt !== b.resetsAt))) ||
      left.connectionState === 'signed-out' && right.connectionState === 'observed' || right.connectionState === 'signed-out' && left.connectionState === 'observed';
    if (disagreement) { sourceConflicts.add(left); sourceConflicts.add(right); }
  }
  sourceConflicts.forEach(conflicted);
  const costs = input.costs;
  if (costs !== undefined && costs !== null) {
    present = true;
    try {
      const parsed = array(costs).map(item => {
        const raw = record(item), ident = identity(raw.identity), id = text(raw.resourceId, 1024), asOf = instant(raw.asOf), state = fresh(asOf, null, opts);
        const value = number(raw.value); if (value === null) throw new Error('Unknown cost is not an actual or estimated amount');
        return { id, ident, cost: { state: oneOf(raw.state, ['actual', 'estimated']), value, currency: nullableText(raw.currency, 16),
          units: text(raw.units, 64), source: text(raw.source, 128), asOf, evidenceState: state } as ProactiveResourceCost };
      });
      const seen = new Set<string>();
      for (const item of parsed) {
        const rows = byId.get(item.id) ?? [];
        if (seen.has(item.id)) { rows.forEach(row => { row.cost = unknownCost('conflict'); }); continue; } seen.add(item.id);
        for (const row of rows) {
          if (row.kind === 'funding-pool') { row.cost = unknownCost(); continue; }
          row.cost = identityKey(row.identity) !== identityKey(item.ident) || row.evidenceState === 'conflict' ? unknownCost('conflict')
            : item.cost.evidenceState !== 'current' ? unknownCost(item.cost.evidenceState) : item.cost;
        }
      }
    } catch { invalid = true; notes.push('Cost snapshot invalid; explicit cost rows were withheld.'); }
  }
  return { schemaVersion: 1, sampledAt: new Date(opts.nowMs).toISOString(), sourceState: invalid ? 'invalid' : present ? 'snapshot' : 'missing',
    resources, executionAuthorized: false, notes: [...notes, 'No probes or provider contacts are performed by this projection.'] };
}

/** Inject only a getter for an already captured public snapshot. Never pass collector refresh/touch/credits methods. */
export function projectCachedProactiveResourceEvidence(readCache: () => ProactiveResourceSnapshots | null, options: ProactiveResourceProjectionOptions): ProactiveResourceEvidenceResponse {
  if (!Number.isFinite(options.nowMs) || options.nowMs < 0 || !Number.isFinite(new Date(options.nowMs).getTime())) throw new Error('Invalid projection clock');
  try { return projectProactiveResourceEvidence(readCache() ?? {}, options); }
  catch { return { schemaVersion: 1, sampledAt: new Date(options.nowMs).toISOString(), sourceState: 'invalid', resources: [], executionAuthorized: false,
    notes: ['Cached public evidence is unavailable; no fallback probes, native reads or provider contacts were attempted.'] }; }
}
