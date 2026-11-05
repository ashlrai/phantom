import { describe, expect, it } from 'vitest';
import { deriveCiNeedsYou } from './ci-needs-you.js';
import { ciNeedsYouCount, ciRunsToday } from './ci-runs-facts.js';
import type { CiRunFactsV1 } from './fleet-ci-runs-query.js';

const NOW = Date.parse('2026-11-04T12:00:00Z');

function facts(over: Partial<CiRunFactsV1> = {}): CiRunFactsV1 {
  return {
    v: 1, generatedAt: '2026-11-04T11:30:00Z', repo: 'ashlrai/phantom', windowHours: 24, available: true, reason: null, total: 6,
    byEvent: { pull_request: 3, push: 2, schedule: 1, merge_group: 0, workflow_dispatch: 0, other: 0 },
    byWorkflow: [], failures: { total: 2, bindArtifact: 1, code: 1, unclassified: 0 }, daily: null, recent: [],
    ...over,
  };
}

describe('ciRunsToday / ciNeedsYouCount', () => {
  it('counts PR and push runs, and raises one item', () => {
    expect(ciRunsToday(facts(), NOW)).toEqual({ runs: 5, failures: { total: 2, bindArtifact: 1, code: 1, unclassified: 0 } });
    expect(ciNeedsYouCount(facts(), NOW)).toBe(1);
  });

  it('raises nothing for absent, unavailable, stale, future, empty or malformed facts', () => {
    expect(ciNeedsYouCount(undefined, NOW)).toBe(0);
    expect(ciNeedsYouCount(facts({ available: false }), NOW)).toBe(0);
    expect(ciNeedsYouCount(facts({ generatedAt: '2026-11-04T09:00:00Z' }), NOW)).toBe(0);
    expect(ciNeedsYouCount(facts({ generatedAt: '2026-11-04T13:00:00Z' }), NOW)).toBe(0);
    expect(ciNeedsYouCount(facts({ byEvent: { pull_request: 0, push: 0, schedule: 4, merge_group: 0, workflow_dispatch: 0, other: 0 } }), NOW)).toBe(0);
    expect(ciNeedsYouCount(facts({ total: 0 }), NOW)).toBe(0);
    expect(ciNeedsYouCount(facts({ failures: { total: -1, bindArtifact: 0, code: 0, unclassified: 0 } }), NOW)).toBe(0);
    expect(ciNeedsYouCount(facts(), Number.NaN)).toBe(0);
  });

  it('always agrees with the item the Needs-you list builds', () => {
    for (const f of [facts(), facts({ available: false }), facts({ total: 0 }), undefined]) {
      expect(ciNeedsYouCount(f, NOW)).toBe(deriveCiNeedsYou(f, NOW).length);
    }
  });
});
