/** Pure public-snapshot tests. No actual collector, native account, network, credential or service reads. */
import { describe, expect, it, vi } from 'vitest';
import { projectCachedProactiveResourceEvidence, projectProactiveResourceEvidence } from '../src/core/proactive/resource-evidence.js';
// Importing the pure projection must never load the live account/collector module.
vi.mock('../src/core/verse/accounts.js', () => { throw new Error('Live collectors must not be imported by resource projection'); });

const nowMs = Date.parse('2026-10-12T12:00:00.000Z');
const observedAt = '2026-10-12T11:59:30.000Z', expiresAt = '2026-10-12T12:00:30.000Z';
const options = { nowMs };
const ident = { provider: 'codex', accountId: 'account-a', agentId: null };
function account(id = 'account-a', overrides: Record<string, unknown> = {}) {
  return { id, label: id, provider: 'codex', state: 'observed', authentication: 'signed-in', health: 'reachable',
    observedAt, expiresAt, windows: [{ id: 'primary', usedPercent: 20, resetsAt: null, limitReached: false }], executionSupported: true,
    codexCredits: { hasCredits: true, unlimited: false, balance: '12.500' }, ...overrides };
}
function connections(accounts = [account()]) { return { sampledAt: observedAt, refreshing: false, accounts }; }
function capacity(overrides: Record<string, unknown> = {}) {
  return { seatId: 'account-a', engine: 'codex', label: 'Account A', free: false, windows: [{ id: 'primary', usedPercent: 20, resetsAt: null, resetDescription: null, limitReached: false }],
    signedOut: false, reachable: true, contextWindow: 100_000, observedAt, spentTodayUsd: null, ...overrides };
}
function profile(id = 'agent-a', accountId = 'a') {
  return { id, identity: { provider: 'custom-helper', accountId, agentId: id }, displayName: id, capabilityIds: ['research', 'engineering'],
    capabilityVerification: 'declared-unverified', connection: 'configured', enabled: true, updatedAt: observedAt };
}
function pool(overrides: Record<string, unknown> = {}) {
  return { poolId: 'gift-a', provider: 'claude', accountId: 'cloud-a', kind: 'gifted-cloud', amount: '200.00', total: '300.00', unit: 'USD', surface: 'cloud-session',
    capturedAt: observedAt, expiresAt: null, expiryKind: 'unknown', source: { kind: 'native-metadata', adapter: 'claude-account-ui' },
    identityState: 'matched', evidenceState: 'current-native', expiryState: 'unknown', ...overrides };
}

describe('provider-neutral public resource evidence', () => {
  it('preserves several same-provider accounts and arbitrary declared agents without authorizing them', () => {
    const response = projectProactiveResourceEvidence({ connections: connections([account(), account('account-b')]), profiles: [profile(), profile('agent-b', 'b')] }, options);
    expect(response.sourceState).toBe('snapshot'); expect(response.resources).toHaveLength(4);
    expect(new Set(response.resources.map(row => row.resourceId)).size).toBe(4);
    expect(response.resources.filter(row => row.kind === 'personal-agent').map(row => row.identity.accountId)).toEqual(['a', 'b']);
    expect(response.resources.filter(row => row.kind === 'personal-agent').every(row => row.connectionState === 'configured' && row.capabilityState === 'declared-unverified' && row.readinessState === 'unverified')).toBe(true);
    expect(response.resources.every(row => row.executionAuthorized === false && row.entitlementState === 'unknown')).toBe(true);
  });
  it('keeps subscription percentages, native credit units, API gifts and costs independent', () => {
    const response = projectProactiveResourceEvidence({ connections: connections(), creditPools: { v: 1, sourceState: 'healthy', rows: [pool()] },
      capacities: [{ identity: { provider: 'claude-api', accountId: null, agentId: null }, capacity: capacity({ seatId: 'claude-api', engine: 'claude-api', windows: [],
        claudeApiGrant: { v: 1, state: 'recorded', remainingUsdMicros: '120000000', totalUsdMicros: '200000000', capturedAt: observedAt, expiryDate: '2026-11-01',
          admissionCutoff: '2026-11-01T00:00:00.000Z', cutoffPolicy: 'expiry-day-start/v1', automaticAdmission: 'held' } }) }] }, options);
    const subscription = response.resources.find(row => row.kind === 'native-subscription')!;
    expect(subscription.usageWindows[0]?.usedPercent).toBe(20);
    expect(subscription.credits[0]).toMatchObject({ amount: '12.500', unit: 'provider-credit', expiresAt: null, expiryState: 'unknown' });
    const gift = response.resources.find(row => row.source === 'credit-pool-snapshot')!;
    expect(gift.kind).toBe('funding-pool'); expect(gift.credits[0]).toMatchObject({ amount: '200.00', unit: 'USD', surface: 'cloud-session', expiresAt: null, expiryState: 'unknown' });
    const api = response.resources.find(row => row.source === 'seat-capacity-snapshot')!;
    expect(api.credits[0]).toMatchObject({ amount: '120000000', unit: 'USD-micros', expiryDate: '2026-11-01', expiresAt: null });
    expect(response.resources.every(row => row.cost.state === 'unknown' && row.cost.value === null && row.entitlementState === 'unknown')).toBe(true);
  });
  it('marks stale, missing and future measurements unknown and preserves nullable provider reset times', () => {
    const rows = projectProactiveResourceEvidence({ connections: connections([
      account('stale', { observedAt: '2026-10-12T11:00:00.000Z', expiresAt: '2026-10-12T11:01:00.000Z' }),
      account('missing', { observedAt: null, expiresAt: null, windows: [{ id: 'primary', usedPercent: null, resetsAt: null, limitReached: false }] }),
      account('future', { observedAt: '2026-10-12T12:01:00.000Z', expiresAt: '2026-10-12T12:02:00.000Z' }),
    ]) }, options).resources;
    expect(rows.map(row => row.evidenceState)).toEqual(['stale', 'missing', 'invalid']);
    expect(rows.every(row => row.usageWindows[0]?.usedPercent === null && row.usageWindows[0]?.resetsAt === null && row.credits[0]?.amount === null && row.connectionState === 'unknown')).toBe(true);
    expect(projectProactiveResourceEvidence({}, options).sourceState).toBe('missing');
    const unmeasured = projectProactiveResourceEvidence({ connections: connections([account('flagged', {
      windows: [{ id: 'primary', usedPercent: 100, resetsAt: null, measured: false, limitReached: true }],
    })]) }, options).resources[0]!.usageWindows[0]!;
    expect(unmeasured).toMatchObject({ usedPercent: null, limitReached: true, evidenceState: 'missing' });
    const denied = projectProactiveResourceEvidence({ connections: connections([account('signed-out', { state: 'signed-out', authentication: 'signed-out' })]) }, options).resources[0]!;
    expect(denied.readinessState).toBe('blocked'); expect(denied.usageWindows[0]?.usedPercent).toBeNull(); expect(denied.credits[0]?.amount).toBeNull();
  });
  it('distinguishes actual zero, explicit estimates and unknown cost without assuming free local operation', () => {
    const initial = projectProactiveResourceEvidence({ capacities: [{ identity: ident, capacity: capacity({ spentTodayUsd: 0 }) },
      { identity: { provider: 'local', accountId: null, agentId: null }, capacity: capacity({ seatId: 'local-model', engine: 'local', free: true }) }] }, options);
    expect(initial.resources[0]?.cost).toMatchObject({ state: 'actual', value: 0, currency: 'USD', units: 'today' });
    expect(initial.resources[1]?.cost).toMatchObject({ state: 'unknown', value: null });
    const estimate = { resourceId: initial.resources[0]!.resourceId, identity: ident, state: 'estimated', value: 0.25, currency: 'USD', units: 'one-task', source: 'explicit-host-estimate', asOf: observedAt };
    const estimated = projectProactiveResourceEvidence({ capacities: [{ identity: ident, capacity: capacity() }], costs: [estimate] }, options);
    expect(estimated.resources[0]?.cost).toMatchObject({ state: 'estimated', value: 0.25, source: 'explicit-host-estimate' });
    const invalid = projectProactiveResourceEvidence({ capacities: [{ identity: ident, capacity: capacity() }], costs: [{ ...estimate, value: null }] }, options);
    expect(invalid.sourceState).toBe('invalid'); expect(invalid.resources[0]?.cost.state).toBe('unknown');
  });
  it('refuses mismatched account capacity and cost attribution, and conflicting duplicate readings', () => {
    const mismatch = projectProactiveResourceEvidence({ capacities: [{ identity: { ...ident, accountId: 'account-b' }, capacity: capacity({ spentTodayUsd: 4 }) }] }, options).resources[0]!;
    expect(mismatch.evidenceState).toBe('conflict'); expect(mismatch.cost.state).toBe('unknown'); expect(mismatch.usageWindows[0]?.usedPercent).toBeNull();
    const response = projectProactiveResourceEvidence({ connections: connections([account(), account('account-a', { codexCredits: { hasCredits: true, unlimited: false, balance: '999' } })]) }, options);
    expect(response.resources.every(row => row.evidenceState === 'conflict' && row.credits[0]?.amount === null)).toBe(true);
    const initial = projectProactiveResourceEvidence({ capacities: [{ identity: ident, capacity: capacity() }] }, options);
    const wrongCost = projectProactiveResourceEvidence({ capacities: [{ identity: ident, capacity: capacity() }], costs: [{ resourceId: initial.resources[0]!.resourceId,
      identity: { ...ident, accountId: 'other' }, state: 'actual', value: 2, currency: 'USD', units: 'task', source: 'receipt', asOf: observedAt }] }, options);
    expect(wrongCost.resources[0]?.cost).toMatchObject({ state: 'unknown', evidenceState: 'conflict' });
    const mixed = projectProactiveResourceEvidence({ connections: connections(), capacities: [{ identity: ident, capacity: capacity({ windows: [{ id: 'primary', usedPercent: 40, resetsAt: null, limitReached: false }] }) }] }, options);
    expect(mixed.resources.every(row => row.evidenceState === 'conflict' && row.usageWindows[0]?.usedPercent === null)).toBe(true);
  });
  it('keeps expiry and identity failures explicit; gifts never become subscription entitlement', () => {
    const response = projectProactiveResourceEvidence({ creditPools: { v: 1, sourceState: 'healthy', rows: [
      pool({ poolId: 'expired', expiresAt: '2026-10-11T12:00:00.000Z' }), pool({ poolId: 'mismatch', identityState: 'mismatch', evidenceState: 'identity-mismatch' }),
      pool({ poolId: 'unknown', identityState: 'unknown', evidenceState: 'identity-unknown', amount: null }),
    ] } }, options);
    expect(response.resources[0]?.credits[0]?.expiryState).toBe('expired');
    expect(response.resources[1]?.credits[0]).toMatchObject({ evidenceState: 'conflict', amount: null });
    expect(response.resources[2]?.credits[0]).toMatchObject({ evidenceState: 'missing', amount: null, expiryState: 'unknown' });
    expect(response.resources.every(row => row.entitlementState === 'unknown' && row.executionAuthorized === false)).toBe(true);
    expect(response.resources[0]?.credits[0]?.amount).toBeNull();
    expect(response.resources[0]?.credits[0]).toMatchObject({ fundingProductId: null, fundingAccountId: null, eligibilityState: 'unknown',
      eligibleSurfaces: [], excludedSurfaces: [], recordKind: 'balance', receiptAmount: null });
  });
  it('preserves synthetic API organization funding and product exclusions without borrowing subscription access', () => {
    const funding = { poolId: 'promotion-org-a', identity: { provider: 'example-api', accountId: 'api-organization-a', agentId: null },
      kind: 'promotional-api', recordKind: 'balance', amount: '25.00', total: '100.00', unit: 'USD', surface: 'api', source: 'synthetic-fixture',
      asOf: observedAt, expiresAt: '2026-11-01T12:00:00.000Z', fundingProductId: 'organization-api', fundingAccountId: 'api-organization-a',
      eligibilityState: 'declared', eligibleSurfaces: ['organization-api'], excludedSurfaces: ['coding-subscription', 'consumer-app'] };
    const rows = projectProactiveResourceEvidence({ fundingEvidence: [funding], profiles: [profile()] }, options).resources;
    const promotion = rows.find(row => row.kind === 'funding-pool')!;
    expect(promotion.identity).toEqual(funding.identity);
    expect(promotion.credits[0]).toMatchObject({ fundingProductId: 'organization-api', fundingAccountId: 'api-organization-a', amount: '25.00',
      eligibilityState: 'declared', eligibleSurfaces: ['organization-api'], excludedSurfaces: ['coding-subscription', 'consumer-app'], receiptAmount: null });
    expect(rows.every(row => row.entitlementState === 'unknown' && row.executionAuthorized === false)).toBe(true);
    expect(rows.find(row => row.kind === 'personal-agent')?.credits).toEqual([]);
    const mismatched = projectProactiveResourceEvidence({ fundingEvidence: [{ ...funding, fundingAccountId: 'different-org' }] }, options).resources[0]!;
    expect(mismatched).toMatchObject({ evidenceState: 'conflict', identityState: 'conflict' }); expect(mismatched.credits[0]?.amount).toBeNull();
    const unknown = projectProactiveResourceEvidence({ fundingEvidence: [{ ...funding, amount: null }] }, options).resources[0]!.credits[0]!;
    expect(unknown.amount).toBeNull(); expect(unknown.excludedSurfaces).toEqual(['coding-subscription', 'consumer-app']);
  });
  it('keeps synthetic historical top-up purchases and grants as receipts, never balances or consumed spend', () => {
    const purchase = { poolId: 'historical-top-up', identity: { provider: 'example-api', accountId: 'org-a', agentId: null }, kind: 'purchased-usage',
      recordKind: 'purchase', amount: '100.00', unit: 'USD', surface: 'organization-api', source: 'synthetic-receipt', asOf: '2026-09-01T12:00:00.000Z',
      fundingProductId: 'organization-api', fundingAccountId: 'org-a' };
    const response = projectProactiveResourceEvidence({ fundingEvidence: [purchase, { ...purchase, poolId: 'grant', kind: 'promotional-api', recordKind: 'grant' }] }, options);
    expect(response.resources).toHaveLength(2);
    for (const row of response.resources) {
      expect(row.credits[0]).toMatchObject({ amount: null, total: null, receiptAmount: '100.00', evidenceState: 'stale', expiryState: 'unknown' });
      expect(row.cost).toMatchObject({ state: 'unknown', value: null }); expect(row.usageWindows).toEqual([]); expect(row.executionAuthorized).toBe(false);
    }
    const explicitMislabel = projectProactiveResourceEvidence({ fundingEvidence: [purchase], costs: [{ resourceId: response.resources[0]!.resourceId,
      identity: purchase.identity, state: 'actual', value: 100, currency: 'USD', units: 'spent', source: 'synthetic-receipt', asOf: observedAt }] }, options);
    expect(explicitMislabel.resources[0]?.cost.state).toBe('unknown');
    const expired = projectProactiveResourceEvidence({ fundingEvidence: [{ ...purchase, recordKind: 'balance', asOf: observedAt, expiresAt: '2026-10-11T12:00:00.000Z' }] }, options).resources[0]!;
    expect(expired.credits[0]).toMatchObject({ amount: null, receiptAmount: null, expiryState: 'expired', evidenceState: 'stale' });
  });
  it('withholds malformed and unbounded snapshots without evaluating accessors', () => {
    let reads = 0;
    const getter = { ...account(), get authentication() { reads++; return 'signed-in'; } };
    expect(projectProactiveResourceEvidence({ connections: connections([getter]) }, options).sourceState).toBe('invalid'); expect(reads).toBe(0);
    expect(projectProactiveResourceEvidence({ connections: connections(Array.from({ length: 513 }, (_, i) => account(`${i}`))) }, options).sourceState).toBe('invalid');
    const sparse = Array(3); sparse[1] = profile();
    expect(projectProactiveResourceEvidence({ profiles: sparse }, options).sourceState).toBe('invalid');
    expect(projectProactiveResourceEvidence({ connections: connections([account('a', { windows: [{ id: 'x', usedPercent: 101 }] })]) }, options).resources).toEqual([]);
    expect(projectProactiveResourceEvidence({ profiles: [{ ...profile(), capabilityVerification: 'verified' }] }, options).resources).toEqual([]);
    const envelope = { get profiles() { reads++; return [profile()]; } };
    expect(projectProactiveResourceEvidence(envelope, options).sourceState).toBe('invalid'); expect(reads).toBe(0);
  });
  it('reads only an injected captured public cache and never refreshes a collector or attempts fallback', () => {
    const read = vi.fn(() => ({ profiles: [profile()] }));
    const response = projectCachedProactiveResourceEvidence(read, options);
    expect(read).toHaveBeenCalledTimes(1); expect(response.resources).toHaveLength(1);
    const failure = projectCachedProactiveResourceEvidence(() => { throw new Error('no cache'); }, options);
    expect(failure).toMatchObject({ sourceState: 'invalid', resources: [], executionAuthorized: false });
  });
});
