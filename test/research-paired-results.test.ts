import { describe, expect, it } from 'vitest';
// @ts-expect-error Standalone offline research tool has no declaration output.
import { evaluatePairs } from '../scripts/research/paired-results.mjs';

function dataset(count = 100) {
  return {
    schemaVersion: 1, evidence: 'measured',
    pairs: Array.from({ length: count }, (_, i) => ({
      id: `task-${i}`, baseline: { elapsedMs: 100, tokens: 10, success: true, unsafeAccepts: 0, staleAccepts: 0 },
      candidate: { elapsedMs: 80, tokens: 9, success: true, unsafeAccepts: 0, staleAccepts: 0 },
    })),
  };
}

describe('offline paired research accounting', () => {
  it('reports a bounded pilot screen, including all work and nearest-rank p95', () => {
    expect(evaluatePairs(dataset())).toMatchObject({
      verdict: 'pilot-screen-pass', pairs: 100, p95Ratio: 0.8, totalTimeRatio: 0.8,
      tokenRatio: 0.9, baseline: { tokensPerSuccess: 10 }, candidate: { tokensPerSuccess: 9 },
      lostSuccesses: 0, gainedSuccesses: 0, reasons: [],
    });
  });
  it('does not mistake synthetic or undersized data for measured evidence', () => {
    const data = dataset(2);
    data.evidence = 'synthetic';
    expect(evaluatePairs(data).reasons).toEqual(['synthetic-evidence', 'insufficient-pairs']);
  });
  it('counts failed attempt tokens and prevents fast failure from winning', () => {
    const data = dataset();
    data.pairs[0].candidate = { elapsedMs: 1, tokens: 100, success: false, unsafeAccepts: 0, staleAccepts: 0 };
    const result = evaluatePairs(data);
    expect(result.candidate.tokens).toBe(991);
    expect(result.candidate.tokensPerSuccess).toBeCloseTo(991 / 99);
    expect(result.lostSuccesses).toBe(1);
    expect(result.reasons).toContain('success-regression');
  });
  it.each(['unsafeAccepts', 'staleAccepts'] as const)('holds any %s, including in the baseline', (field) => {
    const data = dataset();
    data.pairs[0].baseline[field] = 1;
    expect(evaluatePairs(data).reasons).toContain('unsafe-or-stale-accept');
    data.pairs[0].baseline[field] = 0;
    data.pairs[0].candidate[field] = 1;
    expect(evaluatePairs(data).reasons).toContain('unsafe-or-stale-accept');
  });
  it('counts extra speculative work against the shared token budget', () => {
    const data = dataset();
    data.pairs[0].candidate.tokens = 200;
    expect(evaluatePairs(data).reasons).toContain('token-budget-regression');
  });
  it('holds tail gains that conceal a total latency regression', () => {
    const data = dataset();
    data.pairs[0].candidate.elapsedMs = 10000;
    expect(evaluatePairs(data)).toMatchObject({ p95Ratio: 0.8, reasons: ['total-time-regression'] });
  });
  it('uses nearest-rank p95 and rejects a marginal tail improvement', () => {
    const data = dataset();
    data.pairs.slice(94).forEach((row) => { row.candidate.elapsedMs = 99; });
    expect(evaluatePairs(data)).toMatchObject({ p95Ratio: 0.99, reasons: ['insufficient-tail-improvement'] });
  });
  it('represents zero successes and zero baseline tokens without Infinity', () => {
    const data = dataset();
    data.pairs.forEach((row) => { row.baseline.tokens = 0; row.candidate.success = false; });
    const result = evaluatePairs(data);
    expect(result.tokenRatio).toBeNull();
    expect(result.candidate.tokensPerSuccess).toBeNull();
    expect(result.reasons).toContain('no-successful-comparison');
    expect(result.reasons).toContain('token-budget-regression');
  });
  it.each([null, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])('rejects unknown or invalid counters: %s', (value) => {
    const data = dataset();
    Object.assign(data.pairs[0].candidate, { tokens: value });
    expect(() => evaluatePairs(data)).toThrow('Invalid paired experiment data');
  });
  it('rejects incomplete arms, duplicate IDs, empty data and unsafe sums', () => {
    const data = dataset();
    expect(() => evaluatePairs({ ...data, pairs: [] })).toThrow();
    expect(() => evaluatePairs({ ...data, pairs: [data.pairs[0], data.pairs[0]] })).toThrow();
    expect(() => evaluatePairs({ ...data, pairs: [{ id: 'missing', baseline: data.pairs[0].baseline }] })).toThrow();
    data.pairs.forEach((row) => { row.candidate.tokens = Number.MAX_SAFE_INTEGER; });
    expect(() => evaluatePairs(data)).toThrow();
  });
});
