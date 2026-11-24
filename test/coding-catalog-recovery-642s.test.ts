import { describe, expect, it } from 'vitest';
import { parseCatalog, usableModelName, type CodingCliCatalog } from '../src/core/providers/coding-cli/catalog.js';

// Self-contained fake inventory. No real backend names, accounts, or machine facts.
function fakeInventory(): Record<string, unknown> {
  return {
    version: 1,
    observedAt: '2026-01-01T00:00:00Z',
    source: 'fake-recorded-probe',
    meteredEnabledByDefault: false,
    machine: { chip: 'fake-chip', ramGb: 16, diskUsedPercent: 50, diskFreeGiB: 100, note: 'fixture' },
    concurrency: { 'fake-sub': 2, 'fake-metered': 1 },
    backends: {
      'fake-sub': { billing: 'subscription', bin: 'fake-sub-cli', enabledByDefault: true, installed: true },
      'fake-metered': { billing: 'metered', bin: null, enabledByDefault: false, meteredReason: 'operator opt-in only' },
      'fake-local': { billing: 'loopback', bin: null, enabledByDefault: false, orgId: 'fake-org-1' },
    },
    accounts: [{ id: 'fake-primary', backend: 'fake-sub', homeEnv: 'FAKE_SUB_HOME', requiresHome: false }],
    tiers: {
      frontier: [
        { intent: 'plan', backend: 'fake-sub', candidate: 'fake-large-a', accountStatus: 'accepted' },
        { intent: 'plan', backend: 'fake-sub', candidate: 'fake-large-b', accountStatus: 'listed' },
      ],
      workhorse: [{ intent: 'edit', backend: 'fake-metered', candidate: 'fake-mid', accountStatus: 'unverified', note: 'probe first' }],
      cheap: [{ intent: 'lint', backend: 'fake-sub', candidate: 'fake-small', accountStatus: 'rejected' }],
      local: [
        { intent: 'local', backend: 'fake-local', candidate: 'fake-gen-7b', accountStatus: 'listed', sizeGb: 4.5, task: 'generate' },
        { intent: 'local', backend: 'fake-local', candidate: 'fake-embed', accountStatus: 'listed', sizeGb: 0.3, task: 'embed' },
      ],
    },
    cacheListings: { codex: ['fake-code-x'], claudeAliases: ['fake-alias'], grok: [], rejectedOnAccount: ['fake-denied'] },
  };
}

const text = (value: unknown): string => JSON.stringify(value);

describe('recorded coding CLI catalog parser (PR #5952 recovery)', () => {
  it('round-trips a valid fake inventory with every field preserved', () => {
    const parsed = parseCatalog(text(fakeInventory()));
    expect(parsed.version).toBe(1);
    expect(parsed.backends['fake-local']).toEqual({ billing: 'loopback', bin: null, enabledByDefault: false, orgId: 'fake-org-1' });
    expect(parsed.accounts).toEqual([{ id: 'fake-primary', backend: 'fake-sub', homeEnv: 'FAKE_SUB_HOME', requiresHome: false }]);
    expect(parsed.tiers.local[1]).toEqual({ intent: 'local', backend: 'fake-local', candidate: 'fake-embed', accountStatus: 'listed', sizeGb: 0.3, task: 'embed' });
    // Re-serialising the parsed value and parsing again yields the same contract.
    const again = parseCatalog(JSON.stringify(parsed));
    expect(again).toEqual(parsed);
  });

  it('keeps listed, unverified and rejected distinct from accepted and never grants eligibility', () => {
    const parsed: CodingCliCatalog = parseCatalog(text(fakeInventory()));
    expect(parsed.tiers.frontier.map((row) => row.accountStatus)).toEqual(['accepted', 'listed']);
    expect(parsed.tiers.workhorse[0]?.accountStatus).toBe('unverified');
    expect(parsed.tiers.cheap[0]?.accountStatus).toBe('rejected');
    expect(parsed.meteredEnabledByDefault).toBe(false);
    // Only accepted yields a named flag.
    expect(usableModelName(parsed.tiers.frontier[0])).toBe('fake-large-a');
    expect(usableModelName(parsed.tiers.frontier[1])).toBeNull();
    expect(usableModelName(parsed.tiers.workhorse[0])).toBeNull();
    expect(usableModelName(parsed.tiers.cheap[0])).toBeNull();
    expect(usableModelName(undefined)).toBeNull();
    // Cache listings are kept as names only; they carry no status.
    expect(parsed.cacheListings.codex).toEqual(['fake-code-x']);
  });

  it('rejects malformed JSON and non-object roots', () => {
    expect(() => parseCatalog('{ not json')).toThrow('coding CLI catalog: invalid JSON');
    expect(() => parseCatalog('[]')).toThrow('coding CLI catalog: root');
    expect(() => parseCatalog('null')).toThrow('coding CLI catalog: root');
  });

  it('rejects an invalid or missing version', () => {
    expect(() => parseCatalog(text({ ...fakeInventory(), version: 2 }))).toThrow('coding CLI catalog: version');
    const { version: _omit, ...noVersion } = fakeInventory();
    expect(() => parseCatalog(text(noVersion))).toThrow('coding CLI catalog: version');
  });

  it('names the missing required field', () => {
    const noMachine = fakeInventory();
    delete noMachine['machine'];
    expect(() => parseCatalog(text(noMachine))).toThrow('coding CLI catalog: machine');

    expect(() => parseCatalog(text({ ...fakeInventory(), observedAt: '   ' }))).toThrow('coding CLI catalog: observedAt');

    const noGrok = fakeInventory();
    (noGrok['cacheListings'] as Record<string, unknown>)['grok'] = undefined;
    expect(() => parseCatalog(text(noGrok))).toThrow('coding CLI catalog: cacheListings.grok');

    const noTier = fakeInventory();
    delete (noTier['tiers'] as Record<string, unknown>)['cheap'];
    expect(() => parseCatalog(text(noTier))).toThrow('coding CLI catalog: tiers.cheap');

    const noCandidate = fakeInventory();
    const row = ((noCandidate['tiers'] as Record<string, unknown[]>)['local']?.[0] ?? {}) as Record<string, unknown>;
    delete row['candidate'];
    expect(() => parseCatalog(text(noCandidate))).toThrow('coding CLI catalog: tiers.local[0].candidate');
  });

  it('rejects an unknown account status instead of guessing', () => {
    const bad = fakeInventory();
    ((bad['tiers'] as Record<string, Record<string, unknown>[]>)['frontier'] ?? [])[0]!['accountStatus'] = 'ok';
    expect(() => parseCatalog(text(bad))).toThrow('coding CLI catalog: tiers.frontier[0].accountStatus');
  });

  it('rejects backend references that do not exist in backends', () => {
    const badCandidate = fakeInventory();
    ((badCandidate['tiers'] as Record<string, Record<string, unknown>[]>)['cheap'] ?? [])[0]!['backend'] = 'fake-missing';
    expect(() => parseCatalog(text(badCandidate))).toThrow('tiers.cheap[0].backend references unknown backend "fake-missing"');

    const badAccount = fakeInventory();
    (badAccount['accounts'] as Record<string, unknown>[])[0]!['backend'] = 'fake-ghost';
    expect(() => parseCatalog(text(badAccount))).toThrow('accounts[0].backend references unknown backend "fake-ghost"');

    const badConcurrency = fakeInventory();
    (badConcurrency['concurrency'] as Record<string, number>)['fake-ghost'] = 1;
    expect(() => parseCatalog(text(badConcurrency))).toThrow('concurrency.fake-ghost references unknown backend "fake-ghost"');
  });

  it('rejects unknown billing classes and out-of-range concurrency', () => {
    const badBilling = fakeInventory();
    (badBilling['backends'] as Record<string, Record<string, unknown>>)['fake-sub']!['billing'] = 'credit';
    expect(() => parseCatalog(text(badBilling))).toThrow('coding CLI catalog: backends.fake-sub.billing');

    for (const value of [0, 9, 1.5]) {
      const bad = fakeInventory();
      (bad['concurrency'] as Record<string, number>)['fake-sub'] = value;
      expect(() => parseCatalog(text(bad))).toThrow('coding CLI catalog: concurrency.fake-sub');
    }
  });

  it('rejects secret-looking or lowercase home env names and duplicate account ids', () => {
    for (const homeEnv of ['FAKE_API_KEY', 'FAKE_TOKEN_HOME', 'lowercase_home']) {
      const bad = fakeInventory();
      (bad['accounts'] as Record<string, unknown>[])[0]!['homeEnv'] = homeEnv;
      expect(() => parseCatalog(text(bad))).toThrow('coding CLI catalog: accounts[0].homeEnv');
    }
    const dup = fakeInventory();
    const first = (dup['accounts'] as Record<string, unknown>[])[0]!;
    dup['accounts'] = [first, { ...first }];
    expect(() => parseCatalog(text(dup))).toThrow('coding CLI catalog: accounts[1].id');
  });
});
