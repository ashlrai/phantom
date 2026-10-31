import { describe, expect, it } from 'vitest';
import { collectMergeEtas, estimateMergeEta, formatMergeEta, readMergeHistory } from '../src/core/merge-eta.js';

const history = readMergeHistory(new URL('./fixtures/merge-eta/history.json', import.meta.url).pathname);
const estimate = (position: number | null, checks = ['build', 'test']) =>
  estimateMergeEta('ashlrai/phantom', 42, position, checks, history);

describe('merge ETA', () => {
  it('reads fixture history and takes the slowest parallel check', () => {
    expect(history).toHaveLength(5);
    expect(estimate(1).rangeMinutes).toEqual([5, 8]);
    expect(estimate(3).rangeMinutes).toEqual([15, 24]);
    expect(formatMergeEta(estimate(3))).toBe('PR #42: merge ETA 15–24 min (queue #3)');
  });
  it('does not invent history, required checks or queue positions', () => {
    for (const position of [null, 0, -1, 1.5, NaN, Infinity]) expect(estimate(position).rangeMinutes).toBeNull();
    expect(estimate(1, []).rangeMinutes).toBeNull();
    expect(estimate(1, ['missing']).rangeMinutes).toBeNull();
    expect(estimateMergeEta('other/repo', 42, 1, ['test'], history).rangeMinutes).toBeNull();
    expect(estimateMergeEta('ashlrai/phantom', 42, 1, ['test'], []).rangeMinutes).toBeNull();
    expect(formatMergeEta(estimate(null))).toContain('merge ETA unknown');
  });
  it('treats unreadable or malformed history as unavailable', () => {
    expect(readMergeHistory('/nonexistent/merge-eta-history')).toEqual([]);
    expect(readMergeHistory(new URL('./status-duration-estimate.test.ts', import.meta.url).pathname)).toEqual([]);
  });
  it('collects real queue positions and required check names through read-only requests', () => {
    const calls: string[][] = [];
    const rows = collectMergeEtas('.', 'ashlrai/phantom', history, args => {
      calls.push(args);
      return args[0] === 'api' ? { data: { repository: { pullRequests: { nodes: [
        { number: 42, mergeQueueEntry: { position: 3 } }, { number: 43, mergeQueueEntry: null },
      ] } } } } : [{ name: 'build', bucket: 'pass' }, { name: 'test', bucket: 'pending' }];
    });
    expect(rows).toEqual([estimate(3), { number: 43, queuePosition: null, rangeMinutes: null }]);
    expect(calls).toHaveLength(2);
    expect(calls[1]).toContain('--required');
  });
  it('keeps unknown PR rows without history and avoids fetching checks', () => {
    let calls = 0;
    expect(collectMergeEtas('.', 'ashlrai/phantom', [], () => {
      calls++;
      return { data: { repository: { pullRequests: { nodes: [{ number: 1, mergeQueueEntry: { position: 1 } }] } } } };
    })).toEqual([{ number: 1, queuePosition: 1, rangeMinutes: null }]);
    expect(calls).toBe(1);
  });
  it('keeps a queued PR unknown when required checks cannot be read', () => {
    for (const checks of [null, [], [{ name: 17 }], [{ name: 'unobserved', bucket: 'pending' }], [{ name: 'test', bucket: 'fail' }]]) {
      const rows = collectMergeEtas('.', 'ashlrai/phantom', history, args => args[0] === 'api'
        ? { data: { repository: { pullRequests: { nodes: [{ number: 42, mergeQueueEntry: { position: 1 } }] } } } }
        : checks);
      expect(rows).toEqual([{ number: 42, queuePosition: 1, rangeMinutes: null }]);
    }
  });
  it('degrades on failed or malformed host reads without throwing', () => {
    for (const response of [null, {}, { data: { repository: null } }]) {
      expect(collectMergeEtas('.', 'ashlrai/phantom', history, () => response)).toEqual([]);
    }
    expect(collectMergeEtas('.', 'ashlrai/phantom', history, () => { throw Error('offline'); })).toEqual([]);
    expect(collectMergeEtas('.', '../bad', history, () => { throw Error('must not read'); })).toEqual([]);
  });
});
