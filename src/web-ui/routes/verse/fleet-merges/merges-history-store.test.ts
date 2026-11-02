import { afterEach, describe, expect, it } from 'vitest';
import { MAX_SAMPLES, mergeHistory, recordMergeSample, resetMergeHistory, summariseMerges } from './merges-history-store.js';

afterEach(resetMergeHistory);

describe('merge history', () => {
  it('records distinct readings at least one minute apart and skips null counts', () => {
    recordMergeSample('first', 12, 0);
    recordMergeSample('first', 11, 60_000);
    recordMergeSample('close', 10, 59_999);
    recordMergeSample('missing', null, 60_000);
    recordMergeSample('second', 8, 60_000);
    recordMergeSample('first', 1, 120_000);
    expect(mergeHistory()).toEqual([
      { generatedAt: 'first', at: 0, count: 12 },
      { generatedAt: 'second', at: 60_000, count: 8 },
    ]);
  });

  it('retains at most 180 samples', () => {
    for (let i = 0; i < MAX_SAMPLES + 3; i++) recordMergeSample(`reading-${i}`, i, i * 60_000);
    expect(mergeHistory()).toHaveLength(180);
    expect(mergeHistory()[0]?.count).toBe(3);
    expect(mergeHistory().at(-1)?.count).toBe(182);
  });

  it('scales all eight glyphs to the maximum and reports the observed span', () => {
    for (let i = 0; i < 8; i++) recordMergeSample(`reading-${i}`, i, i * 60_000);
    expect(summariseMerges(mergeHistory(), 20 * 60_000)).toEqual({ spark: '▁▂▃▄▅▆▇█', first: 0, last: 7, spanMinutes: 7 });
    resetMergeHistory();
    recordMergeSample('first', 12, 0);
    expect(summariseMerges(mergeHistory(), 0)).toBeNull();
    recordMergeSample('last', 3, 90 * 60_000);
    expect(summariseMerges(mergeHistory(), 100 * 60_000)).toEqual({ spark: '█▃', first: 12, last: 3, spanMinutes: 90 });
  });

  it('renders zero readings and clears history on reset', () => {
    recordMergeSample('first', 0, 0);
    recordMergeSample('second', 0, 60_000);
    expect(summariseMerges(mergeHistory(), 60_000)?.spark).toBe('▁▁');
    resetMergeHistory();
    expect(mergeHistory()).toEqual([]);
    expect(summariseMerges(mergeHistory(), 60_000)).toBeNull();
  });
});
