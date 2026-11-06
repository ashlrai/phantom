import { describe, expect, it } from 'vitest';
import { mergeWaitHref, mergeWaits, mergeWaitSummary } from './merge-wait-model.js';

const now = Date.parse('2026-11-01T05:00:00Z');
const ago = (minutes: number) => new Date(now - minutes * 60_000).toISOString();
const publish = (job: string, number: number, minutes: number, repo = 'ashlrai/phantom') =>
  ({ job, lane: 'codex', url: `https://github.com/${repo}/pull/${number}`, at: ago(minutes) });

describe('merge waits', () => {
  it('joins by full repository and number and sorts waiting, merged, then unknown', () => {
    const runs = { publishesLastHour: [publish('merged-fast', 1, 35), publish('waiting-young', 2, 20),
      publish('merged-slow', 3, 55), publish('waiting-old', 1, 70, 'other/repo'),
      { job: 'no-pr', lane: null, url: 'https://github.com/ashlrai/phantom/issues/4', at: ago(10) }],
    mergesLastHour: { items: [{ repo: 'ASHLRAI/PHANTOM', number: 1, mergedAt: ago(17) },
      { repo: 'ashlrai/phantom', number: 3, mergedAt: ago(10) }] } };
    const rows = mergeWaits(runs, now);
    expect(rows.map(row => [row.job, row.state, row.text])).toEqual([
      ['waiting-old', 'waiting', 'waiting 70m'], ['waiting-young', 'waiting', 'waiting 20m'],
      ['merged-slow', 'merged', 'merged after 45m'], ['merged-fast', 'merged', 'merged after 18m'],
      ['no-pr', 'unknown', 'no PR'],
    ]);
    expect(rows[0]).toMatchObject({ lane: 'codex', repo: 'other/repo', number: 1, waitMs: 70 * 60_000 });
    expect(mergeWaitHref(runs, rows[0]!)).toBe('https://github.com/other/repo/pull/1');
    expect(mergeWaitHref(runs, rows[4]!)).toBeNull();
    expect(mergeWaitSummary(rows)).toEqual({ merged: 2, waiting: 2, medianMergedMs: 31.5 * 60_000, oldestWaitingMs: 70 * 60_000 });
  });

  it('handles missing or invalid timestamps, clamps future times, and counts untimed rows', () => {
    const runs = { publishesLastHour: [publish('no-merge-time', 1, 10),
      { ...publish('bad-published', 2, 10), at: 'invalid' }, publish('future-merge', 3, 10),
      publish('future-publish', 4, -5), { ...publish('bad-wait', 5, 10), at: null }],
    mergesLastHour: { items: [{ repo: 'ashlrai/phantom', number: 1 },
      { repo: 'ashlrai/phantom', number: 2, mergedAt: ago(1) },
      { repo: 'ashlrai/phantom', number: 3, mergedAt: ago(20) }] } };
    const rows = mergeWaits(runs, now);
    expect(rows.map(({ job, text, waitMs }) => [job, text, waitMs])).toEqual([
      ['future-publish', 'waiting 0m', 0], ['bad-wait', 'waiting', null],
      ['future-merge', 'merged after 0m', 0], ['no-merge-time', 'merged', null], ['bad-published', 'merged', null],
    ]);
    expect(mergeWaitSummary(rows)).toEqual({ merged: 3, waiting: 2, medianMergedMs: 0, oldestWaitingMs: 0 });
    expect(mergeWaits(runs, NaN).find(row => row.job === 'future-publish')?.waitMs).toBeNull();
  });

  it('rejects unsafe and malformed PR links and handles missing data', () => {
    const urls = [null, 'javascript:alert(1)', 'http://github.com/a/b/pull/1', 'https://evil.com/a/b/pull/1',
      'https://github.com/a/b/pull/0', 'https://github.com/a/b/pull/1/files', 'https://github.com/a/b/pull/9007199254740992'];
    const rows = mergeWaits({ publishesLastHour: [...urls.map((url, i) => ({ job: `job-${i}`, url })), null, {}], mergesLastHour: null }, now);
    expect(rows).toHaveLength(urls.length);
    expect(rows.every(row => row.state === 'unknown' && row.text === 'no PR')).toBe(true);
    expect(mergeWaits(null, now)).toEqual([]);
    expect(mergeWaitSummary(rows)).toEqual({ merged: 0, waiting: 0, medianMergedMs: null, oldestWaitingMs: null });
    expect(mergeWaitHref(null, rows[0]!)).toBeNull();
  });

  it('preserves a valid published URL and handles an odd median', () => {
    const url = 'https://github.com/a/b/pull/1?source=fleet';
    const runs = { publishesLastHour: [{ job: 'job', lane: '', url, at: ago(18) }],
      mergesLastHour: { items: [{ repo: 'a/b', number: 1, mergedAt: ago(0) }] } };
    const rows = mergeWaits(runs, now);
    expect(rows[0]).toMatchObject({ lane: null, text: 'merged after 18m' });
    expect(mergeWaitHref(runs, rows[0]!)).toBe(url);
    expect(mergeWaitSummary(rows)).toEqual({ merged: 1, waiting: 0, medianMergedMs: 18 * 60_000, oldestWaitingMs: null });
  });
});
