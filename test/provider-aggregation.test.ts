/** Synthetic pure provider grouping; no account data, provider SDKs, runtime probes or IO. */
import { describe, expect, it, vi } from 'vitest';
import { aggregateProviderResources } from '../src/core/resources/provider-aggregation.js';
import type { ProviderObservationScope, ProviderPoolRelation, ProviderResourceDescriptor, ProviderScopedObservation } from '../src/core/resources/provider-aggregation-types.js';
import { DEFAULT_RESOURCE_OBSERVATION_MAX_AGE_MS } from '../src/core/resources/provider-aggregation-types.js';

const nowMs = Date.parse('2026-10-12T12:00:00.000Z'), observedAt = '2026-10-12T11:59:30.000Z';
const opts = { nowMs };
function resource(resourceId = 'resource-a', provider = 'provider-a', accountId: string | null = 'account-a', overrides: Partial<ProviderResourceDescriptor> = {}): ProviderResourceDescriptor {
  return { resourceId, provider, accountId, label: 'Synthetic resource', resourceKind: 'subscription', readingState: 'current', observedAt, ...overrides };
}
function scope(overrides: Partial<ProviderObservationScope> = {}): ProviderObservationScope {
  return { provider: 'provider-a', fundingProductId: 'product-subscription', fundingAccountId: 'funding-account-a', modelScope: 'account-wide',
    surface: 'coding-subscription', unit: 'requests', windowId: 'weekly-general', resetsAt: '2026-10-15T12:00:00.000Z', expiresAt: '2026-10-15T12:00:00.000Z', recordKind: 'usage', ...overrides };
}
function observation(observationId = 'observation-a', resourceId = 'resource-a', overrides: Partial<ProviderScopedObservation> = {}): ProviderScopedObservation {
  return { observationId, resourceId, scope: scope(), readingState: 'current', observedAt, numerator: null, denominator: null, reportedPercent: 25, ...overrides };
}
function relation(overrides: Partial<ProviderPoolRelation> = {}): ProviderPoolRelation {
  return { relationId: 'relation-a', poolId: 'native-pool-a', memberObservationIds: ['observation-a', 'observation-b'], scope: scope(),
    observedAt, expiresAt: '2026-10-12T12:00:30.000Z', proofReference: 'synthetic-qualified-exact-source', ...overrides };
}

describe('qualitative provider grouping and scoped observations', () => {
  it('groups arbitrary providers with exact reference drilldown; matching names do not establish account identities', () => {
    const rows = [resource(), resource('resource-b', 'provider-a', 'account-b'), resource('resource-c', 'provider-a', 'account-a'),
      resource('resource-d', 'another-provider', 'account-a'), resource('unbound-a', 'provider-a', null), resource('unbound-b', 'provider-a', null)];
    const result = aggregateProviderResources(rows, opts);
    expect(result.sourceState).toBe('healthy'); expect(result.providers.map(group => group.provider)).toEqual(['another-provider', 'provider-a']);
    const provider = result.providers[1]!;
    expect(provider.coverage).toMatchObject({ resources: 5, accounts: null, accountReferences: 2, unboundResources: 2, current: 5, totalExpectedAccounts: null, coverageState: 'unknown' });
    expect(provider.accounts).toHaveLength(4); expect(provider.accounts.find(account => account.accountId === 'account-a')?.resources).toHaveLength(2);
    expect(provider.accounts.filter(account => account.accountId === null)).toHaveLength(2);
    expect(new Set(provider.accounts.map(account => account.key)).size).toBe(4);
    expect(result.coverage.accounts).toBeNull(); expect(result.coverage.accountReferences).toBe(3); expect(result.executionAuthorized).toBe(false);
  });
  it('counts two configured aliases of one synthetic login as references while distinct verified accounts remain unknown', () => {
    const result = aggregateProviderResources([resource('view-a', 'provider-a', 'configured-alias-a', { label: 'Synthetic same login' }),
      resource('view-b', 'provider-a', 'configured-alias-b', { label: 'Synthetic same login' })], opts);
    expect(result.coverage).toMatchObject({ resources: 2, current: 2, accountReferences: 2, accounts: null, coverageState: 'unknown' });
    expect(result.providers[0]?.accounts).toHaveLength(2);
    expect(result.providers[0]?.accounts.every(group => group.coverage.accounts === null && group.coverage.accountReferences === 1)).toBe(true);
    expect(result.observationGroups).toEqual([]); expect(result.numericTotal).toBeNull(); expect(result.executionAuthorized).toBe(false);
  });
  it('keeps declared Bot references distinct without qualifying identity, ownership, readiness or pool sharing', () => {
    const result = aggregateProviderResources([resource('bot-a', 'custom-provider', 'declared-bot-ref-a', { resourceKind: 'personal-agent', readingState: 'declared' }),
      resource('bot-b', 'custom-provider', 'declared-bot-ref-b', { resourceKind: 'personal-agent', readingState: 'declared' })], opts);
    expect(result.coverage).toMatchObject({ resources: 2, current: 0, unknown: 2, accountReferences: 2, accounts: null });
    expect(result.providers[0]?.resources.map(row => row.readingState)).toEqual(['declared', 'declared']);
    expect(result.providers[0]?.accounts).toHaveLength(2); expect(result.observationGroups).toEqual([]);
    expect(result.providers[0]?.executionAuthorized).toBe(false); expect(result.numericTotal).toBeNull();
  });
  it('preserves freshness without promoting unknown, declared or historical readings', () => {
    const result = aggregateProviderResources([
      resource(), resource('stale', 'provider-a', 'a', { observedAt: '2026-10-12T11:00:00.000Z' }),
      resource('unknown', 'provider-a', 'b', { readingState: 'unknown' }), resource('declared', 'provider-a', 'c', { readingState: 'declared' }),
      resource('missing-time', 'provider-a', 'd', { observedAt: null }), resource('future', 'provider-a', 'e', { observedAt: '2026-10-12T12:01:00.000Z' }),
    ], opts);
    expect(result.providers[0]?.resources.map(row => row.readingState)).toEqual(['current', 'stale', 'unknown', 'declared', 'unknown', 'invalid']);
    expect(result.coverage).toMatchObject({ resources: 6, current: 1, stale: 1, unknown: 4 });
  });
  it('uses the shared default to refuse year-old current claims, future observations and invalid calendar timestamps', () => {
    expect(DEFAULT_RESOURCE_OBSERVATION_MAX_AGE_MS).toBe(15 * 60_000);
    const result = aggregateProviderResources([resource('old', 'provider-a', 'old-account', { observedAt: '2025-10-12T11:59:30.000Z' }),
      resource('future', 'provider-a', 'future-account', { observedAt: '2027-10-12T11:59:30.000Z' })], { nowMs });
    expect(result.providers[0]?.resources.map(row => row.readingState)).toEqual(['stale', 'invalid']);
    expect(result.coverage.current).toBe(0);
    expect(aggregateProviderResources([resource('calendar', 'provider-a', 'calendar-account', { observedAt: '2026-02-30T12:00:00.000Z' })], { nowMs }).sourceState).toBe('invalid');
  });
  it('never averages percentages or reconstructs denominators, including when absolute quantities are provided', () => {
    const result = aggregateProviderResources([resource(), resource('resource-b', 'provider-a', 'account-b')], { ...opts,
      observations: [observation('observation-a', 'resource-a', { numerator: '80', denominator: '100', reportedPercent: 80 }),
        observation('observation-b', 'resource-b', { numerator: '20', denominator: '50', reportedPercent: 40 })] });
    expect(result.observations.map(row => [row.numerator, row.denominator, row.reportedPercent])).toEqual([['80', '100', 80], ['20', '50', 40]]);
    expect(result.observationGroups).toHaveLength(2);
    expect(result.numericTotal).toBeNull(); expect(result.numericTotalState).toBe('unknown');
    expect(result.observationGroups.every(group => group.numericTotal === null && group.denominator === null)).toBe(true);
    expect(result.coverage.totalExpectedAccounts).toBeNull();
  });
  it('keeps subscription windows, model sublimits, API currency, native credits and cloud promotions independent', () => {
    const variations: Partial<ProviderObservationScope>[] = [
      {}, { modelScope: 'model-specific', windowId: 'weekly-model' }, { resetsAt: '2026-10-16T12:00:00.000Z' },
      { surface: 'organization-api', unit: 'USD', fundingProductId: 'product-api', recordKind: 'balance' },
      { surface: 'over-plan-usage', unit: 'provider-credit', recordKind: 'balance' },
      { surface: 'cloud-session', fundingProductId: 'product-cloud', unit: 'USD', expiresAt: '2026-11-01T12:00:00.000Z', recordKind: 'grant' },
    ];
    const observations = variations.map((variation, i) => observation(`observation-${i}`, 'resource-a', { scope: scope(variation), numerator: '1.00', reportedPercent: null }));
    const result = aggregateProviderResources([resource()], { ...opts, observations });
    expect(result.observationGroups).toHaveLength(6); expect(result.observations.map(row => row.scope)).toEqual(observations.map(row => row.scope));
    expect(result.observationGroups.every(group => group.state === 'independent' && group.numericTotal === null)).toBe(true);
  });
  it('defaults to denying shared pools and rejects a deserialized verified flag', () => {
    const rows = [resource(), resource('resource-b', 'provider-a', 'account-b')];
    const observations = [observation(), observation('observation-b', 'resource-b')];
    expect(aggregateProviderResources(rows, { ...opts, observations, poolRelations: [relation()] }).observationGroups).toHaveLength(2);
    const rejected = aggregateProviderResources(rows, { ...opts, observations, poolRelations: [{ ...relation(), verified: true }] });
    expect(rejected.sourceState).toBe('invalid'); expect(rejected.observationGroups).toEqual([]);
  });
  it('groups shared direct and linked views only through fresh source-qualified exact scope/member proof, without inferring zero cash', () => {
    const rows = [resource(), resource('resource-b', 'linked-execution-view', 'linked-account-b')];
    const observations = [observation(), observation('observation-b', 'resource-b')];
    const validate = vi.fn((proof: Readonly<ProviderPoolRelation>, members: readonly { resource: ProviderResourceDescriptor; observation: ProviderScopedObservation }[]) =>
      proof.proofReference === 'synthetic-qualified-exact-source' && members.map(member => member.resource.accountId).join(',') === 'account-a,linked-account-b');
    const result = aggregateProviderResources(rows, { ...opts, observations, poolRelations: [relation()], validatePoolProof: validate });
    expect(validate).toHaveBeenCalledTimes(1); expect(result.providers).toHaveLength(2);
    expect(result.observationGroups).toHaveLength(1); expect(result.observationGroups[0]).toMatchObject({ state: 'shared-source-qualified', numericTotal: null, denominator: null });
    expect(result.observations).toHaveLength(2); expect(result.executionAuthorized).toBe(false);
    expect(result.observations.every(row => row.numerator === null && row.denominator === null)).toBe(true);
  });
  it('withholds stale, partial, mismatched and conflicting relations rather than selecting an optimistic pool', () => {
    const rows = [resource(), resource('resource-b', 'provider-a', 'account-b')], observations = [observation(), observation('observation-b', 'resource-b')];
    const validator = vi.fn(() => true);
    for (const proof of [relation({ expiresAt: '2026-10-12T11:59:59.000Z' }), relation({ memberObservationIds: ['observation-a', 'absent'] }),
      relation({ scope: scope({ fundingAccountId: 'different-funding-account' }) }), relation({ scope: scope({ modelScope: null }) })]) {
      const result = aggregateProviderResources(rows, { ...opts, observations, poolRelations: [proof], validatePoolProof: validator });
      expect(result.observationGroups).toHaveLength(2); expect(result.observationGroups.every(group => group.state === 'independent')).toBe(true);
    }
    expect(validator).not.toHaveBeenCalled();
    const conflicts = aggregateProviderResources(rows, { ...opts, observations: [observations[0]!, { ...observations[1]!, reportedPercent: 75 }],
      poolRelations: [relation()], validatePoolProof: () => true });
    expect(conflicts.observationGroups[0]?.state).toBe('conflict'); expect(conflicts.observations.every(row => row.readingState === 'conflict')).toBe(true);
    expect(conflicts.coverage.current).toBe(0); expect(conflicts.coverage.unknown).toBe(2); expect(conflicts.numericTotal).toBeNull();
  });
  it('does not qualify a passed usage reset even when the capture and proof expiry are current', () => {
    const rows = [resource(), resource('resource-b', 'provider-a', 'account-b')], expiredScope = scope({ resetsAt: '2026-10-10T12:00:00.000Z' });
    const proof = vi.fn(() => true);
    const result = aggregateProviderResources(rows, { ...opts, observations: [observation('observation-a', 'resource-a', { scope: expiredScope }),
      observation('observation-b', 'resource-b', { scope: expiredScope })], poolRelations: [relation({ scope: expiredScope })], validatePoolProof: proof });
    expect(result.observations.map(row => row.readingState)).toEqual(['stale', 'stale']);
    expect(result.observationGroups.every(group => group.state === 'independent')).toBe(true); expect(proof).not.toHaveBeenCalled();
    expect(result.coverage).toMatchObject({ current: 0, stale: 2 });
  });
  it('downgrades current descriptor coverage when all bound product observations are expired or noncurrent', () => {
    const result = aggregateProviderResources([resource()], { ...opts, observations: [observation('expired-usage', 'resource-a', {
      scope: scope({ expiresAt: '2026-10-12T11:59:00.000Z' }),
    })] });
    expect(result.observations[0]?.readingState).toBe('stale');
    expect(result.coverage).toMatchObject({ current: 0, stale: 1 }); expect(result.providers[0]?.accounts[0]?.coverage.current).toBe(0);
    const conflict = aggregateProviderResources([resource()], { ...opts, observations: [observation('conflict', 'resource-a', { readingState: 'conflict' })] });
    expect(conflict.coverage).toMatchObject({ current: 0, unknown: 1 });
  });
  it('retains independent current product facts while reporting partial scopes, and never promotes unknown descriptors', () => {
    const independent = [observation('ended-window', 'resource-a', { scope: scope({ resetsAt: '2026-10-10T12:00:00.000Z' }), reportedPercent: 75 }),
      observation('current-model', 'resource-a', { scope: scope({ modelScope: 'another-model', windowId: 'model-window' }), reportedPercent: 10 })];
    const result = aggregateProviderResources([resource()], { ...opts, observations: independent });
    expect(result.observations.map(row => [row.readingState, row.reportedPercent])).toEqual([['stale', 75], ['current', 10]]);
    expect(result.coverage.current).toBe(1); expect(result.notes.some(note => note.includes('independent current and noncurrent'))).toBe(true);
    const unqualifiedDescriptor = aggregateProviderResources([resource('resource-a', 'provider-a', 'account-a', { readingState: 'unknown' })], { ...opts, observations: independent });
    expect(unqualifiedDescriptor.coverage.current).toBe(0);
    const alreadyConflicted = aggregateProviderResources([resource()], { ...opts, observations: [observation('alias-a', 'resource-a', { reportedPercent: 25 }),
      observation('alias-b', 'resource-a', { reportedPercent: 75 }), independent[1]!] });
    expect(alreadyConflicted.coverage).toMatchObject({ current: 0, unknown: 1 });
    expect(alreadyConflicted.observations.at(-1)).toMatchObject({ readingState: 'current', reportedPercent: 10 });
  });
  it('marks contradictory aliases for one exact scoped capture as conflict without inferring a shared pool', () => {
    const result = aggregateProviderResources([resource()], { ...opts, observations: [observation('alias-a', 'resource-a', { reportedPercent: 25 }),
      observation('alias-b', 'resource-a', { reportedPercent: 75 })] });
    expect(result.observations.map(row => row.readingState)).toEqual(['conflict', 'conflict']);
    expect(result.observationGroups).toHaveLength(2); expect(result.observationGroups.every(group => group.state === 'conflict' && group.poolId === null)).toBe(true);
    expect(result.coverage).toMatchObject({ current: 0, unknown: 1 }); expect(result.numericTotal).toBeNull();
    const independentPeriods = aggregateProviderResources([resource()], { ...opts, observations: [observation('old-period', 'resource-a', { reportedPercent: 25 }),
      observation('new-period', 'resource-a', { scope: scope({ resetsAt: '2026-10-16T12:00:00.000Z' }), reportedPercent: 75 })] });
    expect(independentPeriods.observations.every(row => row.readingState === 'current')).toBe(true);
  });
  it('preserves unknown balances/denominators and purchase versus grant observations without deriving cost or entitlement', () => {
    const result = aggregateProviderResources([resource('resource-a', 'provider-a', 'account-a', { resourceKind: 'funding-pool', readingState: 'unknown', observedAt: null })], {
      ...opts, observations: [observation('balance', 'resource-a', { scope: scope({ recordKind: 'balance', surface: 'organization-api', unit: 'USD' }), numerator: null, reportedPercent: null }),
        observation('purchase', 'resource-a', { scope: scope({ recordKind: 'purchase', surface: 'organization-api', unit: 'USD' }), numerator: '15.00', reportedPercent: null }),
        observation('grant', 'resource-a', { scope: scope({ recordKind: 'grant', surface: 'cloud-session', unit: 'USD' }), numerator: '30.00', reportedPercent: null })],
    });
    expect(result.observations.map(row => [row.scope.recordKind, row.numerator, row.denominator])).toEqual([['balance', null, null], ['purchase', '15.00', null], ['grant', '30.00', null]]);
    expect(result.numericTotal).toBeNull(); expect(result.providers[0]?.resources[0]?.readingState).toBe('unknown');
    expect(result.providers[0]?.executionAuthorized).toBe(false);
  });
  it('does not mutate caller snapshots even when a source validator changes its supplied copies', () => {
    const rows = [resource(), resource('resource-b', 'provider-a', 'account-b')], observations = [observation(), observation('observation-b', 'resource-b')], proof = relation();
    const before = JSON.stringify([rows, observations, proof]);
    aggregateProviderResources(rows, { ...opts, observations, poolRelations: [proof], validatePoolProof: (copy, members) => {
      members[0]!.resource.label = 'Changed by validator'; members[0]!.observation.numerator = '999'; copy.memberObservationIds.push('extra'); return false;
    } });
    expect(JSON.stringify([rows, observations, proof])).toBe(before);
  });
  it('bounds and rejects malformed inputs without reading getters or importing any host runtime', () => {
    let reads = 0;
    const getter = { ...resource(), get provider() { reads++; return 'provider-a'; } };
    expect(aggregateProviderResources([getter], opts).sourceState).toBe('invalid'); expect(reads).toBe(0);
    expect(aggregateProviderResources([resource(), resource()], opts).sourceState).toBe('invalid');
    expect(aggregateProviderResources(Array.from({ length: 513 }, (_, i) => resource(`${i}`)), opts).sourceState).toBe('invalid');
    expect(aggregateProviderResources([resource()], { ...opts, observations: [observation('unbound', 'absent')] }).sourceState).toBe('invalid');
    expect(aggregateProviderResources([resource()], { nowMs: NaN }).sourceState).toBe('invalid');
    expect(aggregateProviderResources([], opts)).toMatchObject({ sourceState: 'healthy', providers: [], numericTotal: null, executionAuthorized: false });
  });
});
