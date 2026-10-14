/** Pure, browser-safe qualitative grouping of supplied public descriptors. No IO, clocks, pricing or admission. */
import type { ProviderAccountGroup, ProviderAggregationResponse, ProviderObservationGroup, ProviderObservationScope,
  ProviderPoolRelation, ProviderReadingState, ProviderResourceCoverage, ProviderResourceDescriptor, ProviderResourceGroup,
  ProviderScopedObservation } from './provider-aggregation-types.js';
import { DEFAULT_RESOURCE_OBSERVATION_MAX_AGE_MS } from './provider-aggregation-types.js';
export type * from './provider-aggregation-types.js';

export interface ProviderPoolProofMember { resource: ProviderResourceDescriptor; observation: ProviderScopedObservation }
export interface ProviderAggregationOptions {
  nowMs: number; maxAgeMs?: number;
  observations?: readonly ProviderScopedObservation[] | unknown;
  poolRelations?: readonly ProviderPoolRelation[] | unknown;
  /** Pure source-owned proof validator over already captured evidence. Default denies every relation. */
  validatePoolProof?: (relation: Readonly<ProviderPoolRelation>, members: readonly ProviderPoolProofMember[]) => boolean;
}
const MAX_RESOURCES = 512, MAX_OBSERVATIONS = 4096, MAX_RELATIONS = 256;
const READING_STATES: readonly ProviderReadingState[] = ['current', 'stale', 'missing', 'unknown', 'invalid', 'conflict', 'unavailable', 'declared'];
function plain(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error('Invalid object');
  if (Reflect.ownKeys(value).length !== keys.length || keys.some(key => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key); return !descriptor || !('value' in descriptor);
  })) throw new Error('Invalid fields'); return value as Record<string, unknown>;
}
function list(value: unknown, max: number): unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > max || Reflect.ownKeys(value).length !== value.length + 1 ||
    Array.from({ length: value.length }, (_, i) => Object.getOwnPropertyDescriptor(value, String(i))).some(d => !d || !('value' in d))) throw new Error('Invalid list'); return value;
}
function text(value: unknown, max = 256): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > max || [...value].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) throw new Error('Invalid reference'); return value;
}
function slug(value: unknown): string { const result = text(value, 64); if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(result)) throw new Error('Invalid slug'); return result; }
function nullable(value: unknown, max = 256): string | null { return value === null ? null : text(value, max); }
function instant(value: unknown): string | null {
  if (value === null) return null; const result = text(value, 32);
  if (!Number.isFinite(Date.parse(result)) || new Date(result).toISOString() !== result) throw new Error('Invalid instant'); return result;
}
function decimal(value: unknown): string | null {
  if (value === null) return null; const result = text(value, 64); if (!/^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/u.test(result)) throw new Error('Invalid quantity'); return result;
}
function choice<T extends string>(value: unknown, choices: readonly T[]): T { if (!choices.includes(value as T)) throw new Error('Invalid state'); return value as T; }
function effectiveState(state: ProviderReadingState, at: string | null, nowMs: number, maxAgeMs: number): ProviderReadingState {
  if (at !== null && Date.parse(at) > nowMs) return 'invalid';
  if (state !== 'current') return state;
  if (at === null) return 'unknown';
  return nowMs - Date.parse(at) > maxAgeMs ? 'stale' : 'current';
}
function descriptor(value: unknown, opts: ProviderAggregationOptions, maxAgeMs: number): ProviderResourceDescriptor {
  const row = plain(value, ['resourceId', 'provider', 'accountId', 'label', 'resourceKind', 'readingState', 'observedAt']);
  const observedAt = instant(row.observedAt);
  return { resourceId: text(row.resourceId, 1024), provider: slug(row.provider), accountId: nullable(row.accountId), label: text(row.label, 240),
    resourceKind: slug(row.resourceKind), readingState: effectiveState(choice(row.readingState, READING_STATES), observedAt, opts.nowMs, maxAgeMs), observedAt };
}
function scope(value: unknown): ProviderObservationScope {
  const row = plain(value, ['provider', 'fundingProductId', 'fundingAccountId', 'modelScope', 'surface', 'unit', 'windowId', 'resetsAt', 'expiresAt', 'recordKind']);
  return { provider: slug(row.provider), fundingProductId: nullable(row.fundingProductId), fundingAccountId: nullable(row.fundingAccountId),
    modelScope: nullable(row.modelScope), surface: slug(row.surface), unit: text(row.unit, 64), windowId: nullable(row.windowId),
    resetsAt: instant(row.resetsAt), expiresAt: instant(row.expiresAt),
    recordKind: choice(row.recordKind, ['usage', 'balance', 'purchase', 'grant', 'actual-cost', 'estimated-cost']) };
}
function scopeKey(value: ProviderObservationScope): string {
  return JSON.stringify([value.provider, value.fundingProductId, value.fundingAccountId, value.modelScope, value.surface, value.unit,
    value.windowId, value.resetsAt, value.expiresAt, value.recordKind]);
}
function completeScope(value: ProviderObservationScope): boolean {
  // Missing dimensions cannot establish commensurability, even when two unknowns compare equal.
  return value.fundingProductId !== null && value.fundingAccountId !== null && value.modelScope !== null && value.windowId !== null &&
    value.resetsAt !== null && value.expiresAt !== null;
}
function observation(value: unknown, resources: Map<string, ProviderResourceDescriptor>, opts: ProviderAggregationOptions, maxAgeMs: number): ProviderScopedObservation {
  const row = plain(value, ['observationId', 'resourceId', 'scope', 'readingState', 'observedAt', 'numerator', 'denominator', 'reportedPercent']);
  const resourceId = text(row.resourceId, 1024), resource = resources.get(resourceId); if (!resource) throw new Error('Unbound observation');
  const observedAt = instant(row.observedAt), dimensions = scope(row.scope), reportedPercent = row.reportedPercent;
  if (!(reportedPercent === null || typeof reportedPercent === 'number' && Number.isFinite(reportedPercent) && reportedPercent >= 0 && reportedPercent <= 100)) throw new Error('Invalid percentage');
  let readingState = effectiveState(choice(row.readingState, READING_STATES), observedAt, opts.nowMs, maxAgeMs);
  if (dimensions.expiresAt !== null && Date.parse(dimensions.expiresAt) <= opts.nowMs && readingState === 'current') readingState = 'stale';
  if (dimensions.recordKind === 'usage' && dimensions.resetsAt !== null && Date.parse(dimensions.resetsAt) <= opts.nowMs && readingState === 'current') readingState = 'stale';
  return { observationId: text(row.observationId), resourceId, scope: dimensions, readingState, observedAt,
    numerator: decimal(row.numerator), denominator: decimal(row.denominator), reportedPercent };
}
function relation(value: unknown): ProviderPoolRelation {
  const row = plain(value, ['relationId', 'poolId', 'memberObservationIds', 'scope', 'observedAt', 'expiresAt', 'proofReference']);
  const members = list(row.memberObservationIds, MAX_RESOURCES).map(value => text(value));
  if (members.length < 2 || new Set(members).size !== members.length) throw new Error('Invalid relation members');
  const observedAt = instant(row.observedAt), expiresAt = instant(row.expiresAt); if (observedAt === null || expiresAt === null) throw new Error('Missing relation time');
  return { relationId: text(row.relationId), poolId: text(row.poolId), memberObservationIds: members, scope: scope(row.scope), observedAt, expiresAt,
    proofReference: text(row.proofReference, 1024) };
}
function coverage(rows: readonly ProviderResourceDescriptor[]): ProviderResourceCoverage {
  return { resources: rows.length, current: rows.filter(row => row.readingState === 'current').length,
    stale: rows.filter(row => row.readingState === 'stale').length,
    unknown: rows.filter(row => row.readingState !== 'current' && row.readingState !== 'stale').length,
    accounts: null, accountReferences: new Set(rows.filter(row => row.accountId !== null).map(row => JSON.stringify([row.provider, row.accountId]))).size,
    unboundResources: rows.filter(row => row.accountId === null).length, totalExpectedAccounts: null, coverageState: 'unknown' };
}
function invalidResponse(): ProviderAggregationResponse {
  return { schemaVersion: 1, sourceState: 'invalid', providers: [], observations: [], observationGroups: [], coverage: coverage([]),
    numericTotal: null, numericTotalState: 'unknown', executionAuthorized: false, notes: ['Invalid or unbounded supplied descriptors; no provider totals were inferred.'] };
}

/**
 * Groups exact provider/supplied locator references and preserves independent quantitative observations.
 * Locators and declared references establish no verified provider/human identity, alias equivalence or ownership.
 * No percentage averages, balance/cost sums, denominator reconstruction or free-cost inference.
 * Relations are display grouping only and default deny; deserialized "verified" flags are not accepted.
 */
export function aggregateProviderResources(input: readonly ProviderResourceDescriptor[] | unknown, opts: ProviderAggregationOptions): ProviderAggregationResponse {
  try {
    if (!Number.isFinite(opts.nowMs) || opts.nowMs < 0 || !Number.isFinite(new Date(opts.nowMs).getTime())) return invalidResponse();
    const maxAgeMs = opts.maxAgeMs ?? DEFAULT_RESOURCE_OBSERVATION_MAX_AGE_MS;
    if (!Number.isSafeInteger(maxAgeMs) || maxAgeMs < 1 || maxAgeMs > 24 * 60 * 60_000) return invalidResponse();
    const rows = list(input, MAX_RESOURCES).map(row => descriptor(row, opts, maxAgeMs));
    const resources = new Map(rows.map(row => [row.resourceId, row])); if (resources.size !== rows.length) return invalidResponse();
    const observations = opts.observations === undefined ? [] : list(opts.observations, MAX_OBSERVATIONS).map(row => observation(row, resources, opts, maxAgeMs));
    const byObservation = new Map(observations.map(row => [row.observationId, row])); if (byObservation.size !== observations.length) return invalidResponse();
    // Different source aliases cannot conceal contradictory values for one exact scoped capture.
    // This only compares a fully known scope on the same resource/time; it never infers shared pools.
    const captures = new Map<string, ProviderScopedObservation[]>();
    for (const row of observations) if (completeScope(row.scope) && row.observedAt !== null) {
      const key = JSON.stringify([row.resourceId, scopeKey(row.scope), row.observedAt]);
      captures.set(key, [...(captures.get(key) ?? []), row]);
    }
    const quantityKey = (row: ProviderScopedObservation) => JSON.stringify([row.numerator, row.denominator, row.reportedPercent]);
    for (const aliases of captures.values()) if (aliases.some(row => quantityKey(row) !== quantityKey(aliases[0]!))) {
      aliases.forEach(row => { row.readingState = 'conflict'; resources.get(row.resourceId)!.readingState = 'conflict'; });
    }
    const relations = opts.poolRelations === undefined ? [] : list(opts.poolRelations, MAX_RELATIONS).map(relation);
    if (new Set(relations.map(row => row.relationId)).size !== relations.length) return invalidResponse();
    const groups: ProviderObservationGroup[] = [], consumed = new Set<string>(), notes: string[] = [];
    const relationMembership = new Map<string, number>();
    for (const item of relations) for (const id of item.memberObservationIds) relationMembership.set(id, (relationMembership.get(id) ?? 0) + 1);
    for (const item of relations) {
      const members = item.memberObservationIds.map(id => byObservation.get(id));
      const fresh = Date.parse(item.observedAt) <= opts.nowMs && Date.parse(item.expiresAt) > opts.nowMs &&
        Date.parse(item.expiresAt) > Date.parse(item.observedAt) && opts.nowMs - Date.parse(item.observedAt) <= maxAgeMs;
      const compatible = fresh && completeScope(item.scope) && members.every(member => member !== undefined && member.readingState === 'current' &&
        resources.get(member.resourceId)!.accountId !== null && scopeKey(member.scope) === scopeKey(item.scope)) &&
        item.memberObservationIds.every(id => relationMembership.get(id) === 1);
      if (!compatible || !opts.validatePoolProof) { notes.push('A shared-pool relation was withheld: exact current scope/members and source proof are required.'); continue; }
      const exactMembers = members as ProviderScopedObservation[];
      let proven = false;
      try { proven = opts.validatePoolProof(structuredClone(item), exactMembers.map(member => ({ resource: structuredClone(resources.get(member.resourceId)!), observation: structuredClone(member) }))) === true; }
      catch { /* Source proof failure leaves all observations independent. */ }
      if (!proven) { notes.push('A shared-pool relation was withheld by its source proof validator.'); continue; }
      const valueKey = (row: ProviderScopedObservation) => JSON.stringify([row.numerator, row.denominator, row.reportedPercent, row.observedAt]);
      const agrees = exactMembers.every(member => valueKey(member) === valueKey(exactMembers[0]!));
      if (!agrees) exactMembers.forEach(member => { member.readingState = 'conflict'; resources.get(member.resourceId)!.readingState = 'conflict'; });
      groups.push({ key: JSON.stringify(['pool', item.relationId]), relationId: item.relationId, poolId: item.poolId,
        observationIds: [...item.memberObservationIds], scope: structuredClone(item.scope), state: agrees ? 'shared-source-qualified' : 'conflict', numericTotal: null, denominator: null });
      exactMembers.forEach(member => consumed.add(member.observationId));
    }
    for (const item of observations) if (!consumed.has(item.observationId)) groups.push({ key: JSON.stringify(['observation', item.observationId]), relationId: null,
      poolId: null, observationIds: [item.observationId], scope: structuredClone(item.scope), state: item.readingState === 'conflict' ? 'conflict' : 'independent', numericTotal: null, denominator: null });
    // A fresh descriptor cannot override all of its supplied readings having ended or expired.
    // Independent current products retain their own facts; this only downgrades optimistic coverage.
    for (const row of rows) {
      const bound = observations.filter(item => item.resourceId === row.resourceId);
      if (!bound.length) continue;
      const hasCurrent = bound.some(item => item.readingState === 'current');
      if (hasCurrent && bound.some(item => item.readingState !== 'current')) {
        notes.push('A resource has independent current and noncurrent product observations; current coverage does not mean every scope is current.');
      }
      if (row.readingState !== 'current' || hasCurrent) continue;
      row.readingState = bound.every(item => item.readingState === 'stale') ? 'stale'
        : bound.some(item => item.readingState === 'conflict') ? 'conflict'
        : bound.some(item => item.readingState === 'invalid') ? 'invalid' : 'unknown';
    }
    const providers: ProviderResourceGroup[] = [...new Set(rows.map(row => row.provider))].sort().map(provider => {
      const providerRows = rows.filter(row => row.provider === provider), byAccount = new Map<string, ProviderResourceDescriptor[]>();
      for (const row of providerRows) {
        const key = JSON.stringify([provider, row.accountId, row.accountId === null ? row.resourceId : null]);
        byAccount.set(key, [...(byAccount.get(key) ?? []), row]);
      }
      const accounts: ProviderAccountGroup[] = [...byAccount.entries()].map(([key, accountRows]) => ({ key, accountId: accountRows[0]!.accountId,
        resources: structuredClone(accountRows), coverage: coverage(accountRows) }));
      return { provider, resources: structuredClone(providerRows), accounts, coverage: coverage(providerRows),
        observationIds: observations.filter(row => resources.get(row.resourceId)?.provider === provider).map(row => row.observationId), executionAuthorized: false };
    });
    return { schemaVersion: 1, sourceState: 'healthy', providers, observations, observationGroups: groups, coverage: coverage(rows), numericTotal: null,
      numericTotalState: 'unknown', executionAuthorized: false, notes: [...new Set(notes), 'Configured account references are locators, not verified provider/human identities; distinct accounts and ownership are unknown.',
        'Account coverage denominator is unknown; references do not establish the complete provider account inventory.',
        'Numeric aggregation is unsupported: percentages, balances, receipts, costs and incompatible scopes remain independent.'] };
  } catch { return invalidResponse(); }
}
