import { describe, expect, it } from 'vitest';

import { type AccountStatus, type CodingCliCatalog, parseCatalog, usableModelName } from '../src/core/providers/coding-cli/catalog.js';
import { HISTORICAL_RECORDED_MEMORY_FRACTION, selectRecordedLocalFit } from '../src/core/providers/coding-cli/recorded-local-candidate.js';

// Recovered from PR #5952 (3d6c8fb7c7f7d52655fb3e0f13ef239686f7b886). All names and values are synthetic.
type Row = { candidate: string; accountStatus?: AccountStatus; sizeGb?: number; task?: 'generate' | 'embed' };

const OBSERVED = '2026-01-01T00:00:00.000Z';
const SOURCE = 'synthetic-recorded-catalog';

/** Builds a catalog through the real parser so the rows carry the same validation as production. */
function catalogOf(local: Row[]): CodingCliCatalog {
  const tier = (r: Row) => ({
    intent: 'synthetic-intent', backend: 'synthetic-local', candidate: r.candidate,
    accountStatus: r.accountStatus ?? 'listed', ...(r.sizeGb === undefined ? {} : { sizeGb: r.sizeGb }),
    ...(r.task === undefined ? {} : { task: r.task }),
  });
  return parseCatalog(JSON.stringify({
    version: 1, observedAt: OBSERVED, source: SOURCE, meteredEnabledByDefault: false,
    machine: { chip: 'synthetic-chip', ramGb: 999, diskUsedPercent: 1, diskFreeGiB: 1, note: 'synthetic' },
    concurrency: { 'synthetic-local': 1 },
    backends: { 'synthetic-local': { billing: 'loopback', bin: null, enabledByDefault: true } },
    accounts: [],
    tiers: { frontier: [], workhorse: [], cheap: [], local: local.map(tier) },
    cacheListings: { codex: [], claudeAliases: [], grok: [], rejectedOnAccount: [] },
  }));
}

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

const fit = (cat: CodingCliCatalog, ramGb: number, memoryFraction = 0.5) => selectRecordedLocalFit(cat, { ramGb, memoryFraction });

describe('recorded local fit (PR #5952 recovery)', () => {
  it('pins the historical fraction as a labelled constant', () => {
    expect(HISTORICAL_RECORDED_MEMORY_FRACTION).toBe(0.6);
  });

  it('prefers the largest recorded size that fits', () => {
    const cat = catalogOf([{ candidate: 'synthetic-small', sizeGb: 2 }, { candidate: 'synthetic-large', sizeGb: 8 }, { candidate: 'synthetic-mid', sizeGb: 4 }]);
    const result = fit(cat, 20);
    expect(result.selected?.candidate.candidate).toBe('synthetic-large');
    expect(result.selected?.evidence).toBe('recorded-size-within-budget');
  });

  it('breaks equal-size ties by name, independent of input order', () => {
    const forward = catalogOf([{ candidate: 'synthetic-beta', sizeGb: 4 }, { candidate: 'synthetic-alpha', sizeGb: 4 }]);
    const reverse = catalogOf([{ candidate: 'synthetic-alpha', sizeGb: 4 }, { candidate: 'synthetic-beta', sizeGb: 4 }]);
    expect(fit(forward, 20).selected?.candidate.candidate).toBe('synthetic-alpha');
    expect(fit(reverse, 20).selected?.candidate.candidate).toBe('synthetic-alpha');
  });

  it('excludes embedding rows even when they are larger and would fit', () => {
    const result = fit(catalogOf([{ candidate: 'synthetic-embed', sizeGb: 5, task: 'embed' }, { candidate: 'synthetic-gen', sizeGb: 3, task: 'generate' }]), 20);
    expect(result.selected?.candidate.candidate).toBe('synthetic-gen');
    expect(result.excluded.embedding).toBe(1);
    const embedOnly = fit(catalogOf([{ candidate: 'synthetic-embed', sizeGb: 1, task: 'embed' }]), 20);
    expect(embedOnly.selected).toBeNull();
    expect(embedOnly.indeterminate).toBeNull();
  });

  it('accepts a row exactly at the budget and excludes one just above it', () => {
    expect(fit(catalogOf([{ candidate: 'synthetic-exact', sizeGb: 5 }]), 10).selected?.candidate.candidate).toBe('synthetic-exact');
    const over = fit(catalogOf([{ candidate: 'synthetic-over', sizeGb: 5.001 }]), 10);
    expect(over.selected).toBeNull();
    expect(over.excluded.oversized).toBe(1);
  });

  it('treats oversized-only input as no fit', () => {
    const result = fit(catalogOf([{ candidate: 'synthetic-huge', sizeGb: 100 }]), 8);
    expect(result.selected).toBeNull();
    expect(result.indeterminate).toBeNull();
    expect(result.excluded.oversized).toBe(1);
  });

  it('reports unknown size as indeterminate, never as a fit or as zero', () => {
    const result = fit(catalogOf([{ candidate: 'synthetic-unsized' }]), 8);
    expect(result.selected).toBeNull();
    expect(result.indeterminate?.candidate.candidate).toBe('synthetic-unsized');
    expect(result.indeterminate?.candidate.sizeGb).toBeUndefined();
    expect(result.indeterminate?.evidence).toBe('recorded-size-unknown');
    expect(result.explanation).toContain('size unknown, not treated as fitting');
  });

  it('keeps a verified fit and an indeterminate row separate when both exist', () => {
    const result = fit(catalogOf([{ candidate: 'synthetic-unsized' }, { candidate: 'synthetic-sized', sizeGb: 2 }]), 8);
    expect(result.selected?.candidate.candidate).toBe('synthetic-sized');
    expect(result.indeterminate?.candidate.candidate).toBe('synthetic-unsized');
  });

  it('applies the caller-supplied fraction, so a different fraction changes the answer', () => {
    const cat = catalogOf([{ candidate: 'synthetic-gen', sizeGb: 6 }]);
    expect(fit(cat, 10, HISTORICAL_RECORDED_MEMORY_FRACTION).selected).not.toBeNull();
    const tighter = fit(cat, 10, 0.5);
    expect(tighter.selected).toBeNull();
    expect(tighter.memoryBudgetGb).toBe(5);
  });

  it('rejects invalid RAM and fraction values', () => {
    const cat = catalogOf([{ candidate: 'synthetic-gen', sizeGb: 1 }]);
    for (const ramGb of [Number.NaN, Number.POSITIVE_INFINITY, -1]) expect(() => fit(cat, ramGb)).toThrow(/ramGb/);
    for (const memoryFraction of [0, -0.1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => fit(cat, 8, memoryFraction)).toThrow(/memoryFraction/);
    }
  });

  it('rejects nonfinite or negative recorded sizes and a missing tiers.local instead of coercing', () => {
    const withSize = (sizeGb: number) => ({
      tiers: { local: [{ intent: 'i', backend: 'synthetic-local', candidate: 'synthetic-gen', accountStatus: 'listed', sizeGb }] },
    }) as unknown as CodingCliCatalog;
    for (const sizeGb of [Number.NaN, Number.POSITIVE_INFINITY, -2]) expect(() => fit(withSize(sizeGb), 8)).toThrow(/sizeGb/);
    expect(() => fit({ version: 1 } as unknown as CodingCliCatalog, 8)).toThrow(/tiers\.local/);
  });

  it('records source and observedAt as provenance and states the result is not live', () => {
    const result = fit(catalogOf([{ candidate: 'synthetic-gen', sizeGb: 1 }]), 8);
    expect(result.provenance).toEqual({ source: SOURCE, observedAt: OBSERVED, live: false });
    expect(result.explanation).toContain(OBSERVED);
    expect(result.explanation).toContain(SOURCE);
    expect(result.explanation).toContain('not installed, accepted or live');
    expect(result.memoryBudgetGb).toBe(4);
  });

  it('does not mutate a frozen catalog and returns copies of rows', () => {
    const cat = deepFreeze(catalogOf([{ candidate: 'synthetic-gen', sizeGb: 2 }]));
    const before = JSON.stringify(cat);
    const result = fit(cat, 8);
    expect(JSON.stringify(cat)).toBe(before);
    expect(result.selected?.candidate).not.toBe(cat.tiers.local[0]);
    if (result.selected) result.selected.candidate.candidate = 'synthetic-changed';
    expect(cat.tiers.local[0]?.candidate).toBe('synthetic-gen');
  });

  it('preserves accountStatus and never makes a listed, unverified or rejected selection usable', () => {
    for (const status of ['listed', 'unverified', 'rejected'] as const) {
      const result = fit(catalogOf([{ candidate: 'synthetic-gen', sizeGb: 1, accountStatus: status }]), 8);
      expect(result.selected?.candidate.accountStatus).toBe(status);
      expect(usableModelName(result.selected?.candidate)).toBeNull();
    }
  });

  it('exposes a model name only for a row already recorded as accepted', () => {
    const result = fit(catalogOf([{ candidate: 'synthetic-gen', sizeGb: 1, accountStatus: 'accepted' }]), 8);
    expect(result.selected?.candidate.accountStatus).toBe('accepted');
    expect(usableModelName(result.selected?.candidate)).toBe('synthetic-gen');
  });

  it('reports empty input as no fit', () => {
    const result = fit(catalogOf([]), 8);
    expect(result.selected).toBeNull();
    expect(result.indeterminate).toBeNull();
    expect(result.explanation).toContain('No recorded size fits the budget.');
  });
});
