import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DecisionEntry, Proposal } from '../src/core/types.js';
import { computeCrossReviewShare, selectCrossReviewer } from '../src/core/fleet/cross-review-metrics.js';

const sources = vi.hoisted(() => ({ proposals: [] as Proposal[], decisions: [] as DecisionEntry[], complete: true }));
vi.mock('../src/core/inbox/store.js', () => ({
  listProposalsDetailed: () => ({ proposals: sources.proposals, complete: sources.complete, sourceState: 'snapshot' }),
}));
vi.mock('../src/core/fleet/decisions-ledger.js', () => ({ readDecisions: () => sources.decisions }));

const allArms = ['claude-cli', 'codex', 'grok-cli'] as const;

describe('cross-review selection', () => {
  it('offers only independent arms to the hook in the existing preference order', () => {
    const hook = vi.fn(() => 'grok-cli' as const);
    expect(selectCrossReviewer('codex:gpt-6-sol', allArms, hook)).toBe('grok-cli');
    expect(hook).toHaveBeenCalledWith(['claude-cli', 'grok-cli']);
    expect(selectCrossReviewer('claude:claude-opus', allArms)).toBe('codex');
    expect(selectCrossReviewer('grok-cli:grok-4.7', allArms)).toBe('claude-cli');
  });

  it('falls back when an arm is held or the hook chooses a forbidden arm', () => {
    expect(selectCrossReviewer('codex:gpt-6-sol', ['codex', 'grok-cli'], () => 'codex')).toBe('grok-cli');
    expect(selectCrossReviewer('codex:gpt-6-sol', ['codex'])).toBeNull();
    expect(selectCrossReviewer('unknown', allArms)).toBeNull();
    expect(selectCrossReviewer('codex:claude-opus', allArms)).toBeNull();
    expect(selectCrossReviewer('codex:gpt-6-sol', allArms, () => null)).toBe('claude-cli');
  });

  it('uses Devin as a producer without making it a reviewer or changing the two-judge rule', () => {
    expect(selectCrossReviewer('devin:swe-2', allArms)).toBe('grok-cli');
  });
});

function decision(proposalId: string, engine: string, extras: Partial<DecisionEntry> = {}): DecisionEntry {
  return { ts: '2026-01-01T00:00:00.000Z', proposalId, action: 'judged', engine, ...extras };
}

describe('cross-review share', () => {
  it('counts completed review events and exposes unknown identities separately', () => {
    const proposals = [
      { id: 'a', engineModel: 'codex:gpt-6-sol' },
      { id: 'b', engineModel: 'claude:claude-opus' },
      { id: 'c', engineModel: undefined },
    ];
    const reviews = [
      decision('a', 'claude:claude-opus'),
      decision('a', 'codex:gpt-6-sol'),
      decision('b', 'grok-cli:grok-4.7'),
      decision('c', 'codex:gpt-6-sol'),
      decision('a', 'mystery'),
      decision('a', 'codex', { model: 'claude-opus' }),
      decision('a', 'claude:claude-opus', { judgeReasonCode: 'judge-parse-failure' }),
      decision('a', 'claude:claude-opus', { detail: 'judge-network-failure' }),
      decision('a', 'claude:claude-opus', { action: 'escalated' }),
      decision('missing', 'claude:claude-opus'),
    ];
    expect(computeCrossReviewShare(proposals, reviews)).toEqual({ comparable: 3, crossProvider: 2, unknown: 3, share: 2 / 3 });
    expect(computeCrossReviewShare(proposals, [])).toEqual({ comparable: 0, crossProvider: 0, unknown: 0, share: null });
  });

  beforeEach(() => { sources.proposals = []; sources.decisions = []; sources.complete = true; });

  it('reports reviews within the requested window even when the proposal is older', async () => {
    const { computeQualityMetrics } = await import('../src/core/fleet/quality-metrics.js');
    const now = Date.now();
    sources.proposals = [{ id: 'a', title: 'A', status: 'pending', repo: 'repo', engineModel: 'codex:gpt-6-sol', createdAt: new Date(now - 40 * 86400000).toISOString() } as Proposal];
    sources.decisions = [
      decision('a', 'claude:claude-opus', { ts: new Date(now - 86400000).toISOString() }),
      decision('a', 'codex:gpt-6-sol', { ts: new Date(now - 40 * 86400000).toISOString() }),
      decision('a', 'codex:gpt-6-sol', { ts: new Date(now + 86400000).toISOString() }),
    ];
    expect(computeQualityMetrics('7d', { repo: 'repo' }).crossReview).toEqual({ comparable: 1, crossProvider: 1, unknown: 0, share: 1 });
    expect(computeQualityMetrics('7d', { repo: 'other' }).crossReview?.share).toBeNull();
    sources.complete = false;
    expect(computeQualityMetrics('7d').crossReview).toBeNull();
  });
});
