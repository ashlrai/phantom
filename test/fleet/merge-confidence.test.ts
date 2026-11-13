import { describe, expect, it } from 'vitest';
import { scoreDiffRisk } from '../../src/fleet/risk.js';
import {
  formatMergeConfidenceLine,
  historyFromEvalReport,
  leaderReviewReason,
  scoreMergeConfidence,
  type MergeHistoryEvidence,
} from '../../src/fleet/merge-confidence.js';
import type { FleetEvalReport } from '../../src/core/fleet/eval-report.js';
import { patch } from './risk-fixtures.js';

const good: MergeHistoryEvidence = { scope: 'repo', resolved: 40, rate: 0.97, lowerBound: 0.87 };
const tested = patch('src/widget.ts', ['a', 'b'], ['x']) + patch('test/widget.test.ts', ['a', 'b', 'c'], []);

describe('merge confidence', () => {
  it('lets a small tested change with healthy history through', () => {
    const result = scoreMergeConfidence({ diff: scoreDiffRisk(tested), history: good });
    expect(result).toMatchObject({ decision: 'auto-merge', blockers: [], components: { diff: 70, history: 92, ci: null } });
    expect(result.score).toBeGreaterThanOrEqual(55);
  });

  it('does not penalise missing history, but still judges the diff alone', () => {
    expect(scoreMergeConfidence({ diff: scoreDiffRisk(patch('docs/guide.md', ['a'], [])) }))
      .toMatchObject({ score: 100, decision: 'auto-merge', components: { history: null, ci: null } });
    // Plain small untested source change: G3 already ran the tests, so it still lands.
    expect(scoreMergeConfidence({ diff: scoreDiffRisk(patch('src/widget.ts', ['a'], [])) }))
      .toMatchObject({ score: 55, decision: 'auto-merge' });
  });

  it('routes large untested source changes to leader review', () => {
    const big = patch('src/widget.ts', Array(120).fill('a'), []);
    const result = scoreMergeConfidence({ diff: scoreDiffRisk(big) });
    expect(result).toMatchObject({ score: 40, decision: 'leader-review', blockers: [] });
    expect(leaderReviewReason(result)).toMatch(/below the 55 auto-merge threshold/);
  });

  it('blocks unmeasurable and high-risk diffs whatever else says', () => {
    const bad = scoreMergeConfidence({ diff: scoreDiffRisk('not a diff'), history: good, ci: 'clean' });
    expect(bad).toMatchObject({ decision: 'leader-review', components: { diff: 0 } });
    expect(bad.blockers[0]).toMatch(/^diff-unmeasurable:/);
    expect(bad.score).toBeLessThan(70);
    const high = scoreMergeConfidence({ diff: scoreDiffRisk(patch('src/auth/login.ts', ['a'], []), { selfRepo: false }), history: good, ci: 'clean' });
    expect(high).toMatchObject({ decision: 'leader-review', blockers: ['diff-risk-high'] });
  });

  it('treats failed checks as a blocker and clean CI as supporting evidence', () => {
    const diff = scoreDiffRisk(tested);
    expect(scoreMergeConfidence({ diff, history: good, ci: 'failed-checks' }))
      .toMatchObject({ decision: 'leader-review', blockers: ['ci-failed-checks'] });
    expect(scoreMergeConfidence({ diff, history: good, ci: 'clean' }).score)
      .toBeGreaterThan(scoreMergeConfidence({ diff, history: good }).score);
  });

  it('blocks on a durably poor history once enough merges resolved', () => {
    const diff = scoreDiffRisk(patch('docs/guide.md', ['a'], []));
    const poor = { scope: 'repo', resolved: 12, rate: 0.7, lowerBound: 0.42 } as const;
    expect(scoreMergeConfidence({ diff, history: poor })).toMatchObject({ decision: 'leader-review', blockers: ['history-repo-durability-low'] });
    expect(scoreMergeConfidence({ diff, history: { ...poor, resolved: 6 } }).decision).toBe('auto-merge');
  });

  it('clamps the threshold and formats PR metadata', () => {
    const result = scoreMergeConfidence({ diff: scoreDiffRisk(tested), history: good, threshold: 1000 });
    expect(result.threshold).toBe(100);
    expect(result.decision).toBe('leader-review');
    expect(formatMergeConfidenceLine(scoreMergeConfidence({ diff: scoreDiffRisk(tested), history: good })))
      .toBe('Merge confidence: 78/100 (threshold 55) · auto-merge eligible · diff 70 · history 92 · ci —');
  });
});

describe('historyFromEvalReport', () => {
  const report = (repoResolved: number): FleetEvalReport => ({
    merges: { resolved: 30, fleetIQ: 90, fleetIqCi95: [0.75, 0.96] },
    byRepo: [{ name: 'Acme/Widget', durability: { resolved: repoResolved, rate: 0.95, ci95: [0.8, 0.99] } }],
  } as unknown as FleetEvalReport);

  it('prefers the repo group, falls back to fleet, else null', () => {
    expect(historyFromEvalReport(report(8), 'acme/widget')).toEqual({ scope: 'repo', resolved: 8, rate: 0.95, lowerBound: 0.8 });
    expect(historyFromEvalReport(report(2), 'acme/widget')).toEqual({ scope: 'fleet', resolved: 30, rate: 0.9, lowerBound: 0.75 });
    expect(historyFromEvalReport({ merges: { resolved: 2, fleetIQ: 100, fleetIqCi95: [0.3, 1] }, byRepo: [] } as unknown as FleetEvalReport, 'x/y')).toBeNull();
    expect(historyFromEvalReport(null, 'x/y')).toBeNull();
  });
});
