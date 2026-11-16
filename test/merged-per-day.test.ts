import { describe, expect, it } from 'vitest';
import {
  dayBounds, latestCompleteDay, measureMergedPerDay, mergedPrNumber, metricsAppend,
  type FirstParentCommit,
} from '../src/core/drive/merged-per-day.js';

const c = (committedAt: string, subject: string, sha = 'f'.repeat(40)): FirstParentCommit => ({ sha, committedAt, subject });
const base = { repo: 'ashlrai/phantom', ref: 'refs/remotes/origin/HEAD', day: '2026-11-15', measuredAt: '2026-11-16T06:00:00Z' };

// Tip-first first-parent history spanning the day.
const history: FirstParentCommit[] = [
  c('2026-11-16T05:51:17Z', 'bridge(X): next day (#6228)', 'a'.repeat(40)),
  c('2026-11-15T23:59:59Z', 'bridge(X): late (#6220)'),
  c('2026-11-15T12:00:00Z', 'Merge pull request #6100 from fork/branch'),
  c('2026-11-15T11:00:00Z', 'docs: direct push without a PR'),
  c('2026-11-15T00:00:00Z', 'fix: first (#6050)'),
  c('2026-11-14T23:59:59Z', 'fix: previous day (#6049)'),
];

describe('mergedPrNumber', () => {
  it('reads squash and merge-commit subjects only', () => {
    expect(mergedPrNumber('feat: thing (#12)')).toBe(12);
    expect(mergedPrNumber('Merge pull request #34 from a/b')).toBe(34);
    expect(mergedPrNumber('fix (#12) in the middle')).toBeNull();
    expect(mergedPrNumber('chore: no pr')).toBeNull();
    expect(mergedPrNumber('bad (#0)')).toBeNull();
  });
});

describe('day helpers', () => {
  it('rejects non-dates and computes the last complete day from the tip', () => {
    expect(dayBounds('2026-11-15').end - dayBounds('2026-11-15').start).toBe(86_400_000);
    expect(() => dayBounds('2026-02-30')).toThrow();
    expect(() => dayBounds('yesterday')).toThrow();
    expect(latestCompleteDay('2026-11-16T05:51:17Z')).toBe('2026-11-15');
    expect(latestCompleteDay('2026-11-16T00:00:00Z')).toBe('2026-11-15');
  });
});

describe('measureMergedPerDay', () => {
  it('counts distinct PRs inside the UTC day and verifies a complete, ordered range', () => {
    const row = measureMergedPerDay({ ...base, commits: history });
    expect(row).toMatchObject({
      merged: 3, direct: 1, verified: true, unverifiedBecause: [],
      tipSha: 'a'.repeat(40), prRange: [6050, 6220], source: 'git-first-parent',
    });
  });

  it('refuses to verify a day the tip has not closed', () => {
    const row = measureMergedPerDay({ ...base, commits: history.slice(1) });
    expect(row.verified).toBe(false);
    expect(row.unverifiedBecause).toContain('day-incomplete');
  });

  it('flags duplicate PR numbers, out-of-order dates and short history', () => {
    const dup = [history[0]!, c('2026-11-15T10:00:00Z', 'a (#7)'), c('2026-11-15T09:00:00Z', 'b (#7)'), history[5]!];
    expect(measureMergedPerDay({ ...base, commits: dup }).unverifiedBecause).toEqual(['duplicate-pr']);
    const swapped = [history[0]!, c('2026-11-15T09:00:00Z', 'a (#7)'), c('2026-11-15T10:00:00Z', 'b (#8)'), history[5]!];
    expect(measureMergedPerDay({ ...base, commits: swapped }).unverifiedBecause).toEqual(['dates-not-monotonic']);
    const short = measureMergedPerDay({ ...base, commits: history.slice(0, 3) });
    expect(short.unverifiedBecause).toEqual(['history-short']);
  });

  it('reports a zero day as verified when the range proves it', () => {
    const row = measureMergedPerDay({ ...base, commits: [history[0]!, history[5]!] });
    expect(row).toMatchObject({ merged: 0, direct: 0, verified: true, prRange: null });
  });
});

describe('metricsAppend', () => {
  const verified = measureMergedPerDay({ ...base, commits: history });
  const unverified = measureMergedPerDay({ ...base, commits: history.slice(1) });

  it('appends once per verified (repo, day) and lets a verified row supersede an unverified one', () => {
    const first = metricsAppend('', [unverified]);
    expect(first).toHaveLength(1);
    const second = metricsAppend(first.join(''), [verified]);
    expect(second).toHaveLength(1);
    expect(metricsAppend(first.join('') + second.join(''), [verified, unverified])).toEqual([]);
    expect(metricsAppend('', [verified, verified])).toHaveLength(1);
  });

  it('refuses to extend a corrupted metrics file', () => {
    expect(() => metricsAppend('not json\n', [verified])).toThrow('metrics line is not JSON');
  });
});
