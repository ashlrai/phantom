import { describe, expect, it } from 'vitest';
import { ciNeedsItem, type CiRunFactsV1 } from './needs-ci-model.js';

const now = Date.parse('2026-11-01T12:00:00Z');
const facts: CiRunFactsV1 = {
  v: 1, generatedAt: '2026-11-01T11:00:00Z', repo: 'ashlrai/phantom', available: true,
  byEvent: { pull_request: 17 }, failures: { total: 8, bindArtifact: 5, code: 2 },
};

describe('ciNeedsItem', () => {
  it('summarizes PR runs and classified failures in a read-only warning', () => {
    expect(ciNeedsItem(facts, now)).toMatchObject({
      id: 'fleet:owner-hold:ci-runs', source: 'fleet', severity: 'warn', actions: [],
      title: 'CI ran 17 times on PRs today',
      detail: '8 reds: 5 rebase artifacts (not code), 2 code\nOrder: once a day. On the Mac: ashlr fleet ci-plan --patch | git apply',
    });
  });

  it('suppresses unavailable, zero, invalid, future and stale facts', () => {
    expect(ciNeedsItem(undefined, now)).toBeNull();
    expect(ciNeedsItem({ ...facts, available: false }, now)).toBeNull();
    expect(ciNeedsItem({ ...facts, byEvent: { pull_request: 0 } }, now)).toBeNull();
    expect(ciNeedsItem({ ...facts, generatedAt: 'invalid' }, now)).toBeNull();
    expect(ciNeedsItem({ ...facts, generatedAt: new Date(now + 1).toISOString() }, now)).toBeNull();
    expect(ciNeedsItem({ ...facts, generatedAt: new Date(now - 2 * 60 * 60_000 - 1).toISOString() }, now)).toBeNull();
    expect(ciNeedsItem({ ...facts, generatedAt: new Date(now - 2 * 60 * 60_000).toISOString() }, now)).not.toBeNull();
  });
});
