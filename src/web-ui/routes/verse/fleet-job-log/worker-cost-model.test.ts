import { describe, expect, it } from 'vitest';
import { costHeadline, isJobCost, type FleetJobCostV1 } from './worker-cost-model.js';

const base: FleetJobCostV1 = {
  schema: 'fleet.job.cost.v1',
  generatedAt: '2026-11-02T12:00:00Z',
  job: 'RQ-COST-1',
  calls: [
    { at: '2026-11-02T08:00:00Z', model: 'claude-test-a', lane: 'claude-api', inputTokens: 100, outputTokens: 20, costUsd: 1.25, estimated: false, error: false },
    { at: '2026-11-02T09:00:00Z', model: 'claude-test-b', lane: null, inputTokens: 30, outputTokens: 5, costUsd: null, estimated: true, error: true },
  ],
  totals: { calls: 2, errors: 1, inputTokens: 130, outputTokens: 25, costUsd: 1.25, reported: { inputTokens: 2, outputTokens: 2, costUsd: 1 } },
  jobTotals: { finishes: 1, tokensTotal: 182000 },
  sources: { apiSpend: 'healthy', jobs: 'healthy' },
  truncated: false,
};

describe('isJobCost', () => {
  it('accepts a well-formed projection', () => {
    expect(isJobCost(base)).toBe(true);
    expect(isJobCost({ ...base, calls: [], totals: { calls: 0, errors: 0, inputTokens: null, outputTokens: null, costUsd: null, reported: { inputTokens: 0, outputTokens: 0, costUsd: 0 } } })).toBe(true);
  });

  it('rejects wrong schema, missing objects and malformed calls', () => {
    for (const bad of [
      null, undefined, 'x', [], { ...base, schema: 'fleet.job.v1' }, { ...base, totals: null },
      { ...base, calls: [{ at: 1 }] }, { ...base, calls: [{ ...base.calls[0]!, costUsd: 'free' }] },
      { ...base, sources: { apiSpend: 'ok', jobs: 'healthy' } }, { ...base, truncated: 'yes' },
      { ...base, jobTotals: { finishes: -1, tokensTotal: 5 } },
    ]) {
      expect(isJobCost(bad)).toBe(false);
    }
  });
});

describe('costHeadline', () => {
  it('summarizes calls, tokens, cost and partial pricing', () => {
    expect(costHeadline(base)).toBe('Cost · 2 calls · 130 in / 25 out · $1.2500 across 1 of 2 calls · 1 errored');
  });

  it('renders unknown totals without fabricating numbers', () => {
    const empty: FleetJobCostV1 = { ...base, calls: [], totals: { calls: 0, errors: 0, inputTokens: null, outputTokens: null, costUsd: null, reported: { inputTokens: 0, outputTokens: 0, costUsd: 0 } } };
    expect(costHeadline(empty)).toBe('Cost · 0 calls · unknown in / unknown out · unknown');
  });
});
