import { expect, it } from 'vitest';
import type { ThroughputCounts, ThroughputGroup } from '../../../../core/fleet/throughput.js';
import { groupLabel, groupWords, mergedShare } from './throughput-share-model.js';

const NONE: ThroughputCounts = { launched: null, published: null, merged: null, finished: null, empty: null, empty_rate: null, median_publish_to_merge_s: null, merge_time_unknown: null };
const ZERO: ThroughputCounts = { ...NONE, launched: 0, published: 0, merged: 0, finished: 0, empty: 0, merge_time_unknown: 0 };
const group = (name: string, merged: number | null): ThroughputGroup => ({ name, totals: { ...ZERO, merged }, buckets: [] });

it('splits the merged PRs between the groups that merged, most first, and leaves out the ones that merged none', () => {
  const share = mergedShare([group('claude', 30), group('codex', 8), group('grok', 0), group('local', 2)], 'lane')!;
  expect(share.total).toBe(40);
  expect(share.segments.map(s => [s.label, s.merged, s.percent, s.kind])).toEqual([['claude', 30, '75%', 'named'], ['codex', 8, '20%', 'named'], ['local', 2, '5%', 'named']]);
  expect(share.segments.reduce((sum, s) => sum + s.share, 0)).toBeCloseTo(1);
  expect(share.words).toBe('40 merged PRs by lane: claude 30 (75%), codex 8 (20%), local 2 (5%).');
});

it('gives a group its colour by name, so two groups trading places keep theirs', () => {
  const slots = (groups: ThroughputGroup[]) => Object.fromEntries(mergedShare(groups, 'repo')!.segments.map(s => [s.name, s.slot]));
  expect(slots([group('phantom', 9), group('atlas', 4)])).toEqual({ atlas: 0, phantom: 1 });
  expect(slots([group('phantom', 3), group('atlas', 4)])).toEqual({ atlas: 0, phantom: 1 });
});

it('folds everything past six named groups into one neutral part, and says how many', () => {
  const repos = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map((name, i) => group(name, 20 - i));
  const share = mergedShare(repos, 'repo')!;
  expect(share.segments).toHaveLength(7);
  expect(share.segments.slice(0, 6).map(s => s.slot)).toEqual([0, 1, 2, 3, 4, 5]);
  const tail = share.segments[6]!;
  expect([tail.name, tail.label, tail.merged, tail.slot, tail.kind]).toEqual([null, '2 other repos', 14 + 13, null, 'others']);
  expect(mergedShare([...repos.slice(0, 7)], 'tier')!.segments[6]!.label).toBe('1 other tier');
});

it('keeps merges with no name in the record apart, last, with no colour of their own', () => {
  const share = mergedShare([group('phantom', 1), group('unknown', 199)], 'repo')!;
  expect(share.segments.map(s => [s.label, s.kind, s.slot, s.percent])).toEqual([['phantom', 'named', 0, '<1%'], ['repo unknown', 'unnamed', null, '99%']]);
  expect(share.words).toBe('200 merged PRs by repo: phantom 1 (<1%), repo unknown 199 (99%).');
  expect(mergedShare([group('unknown', 1)], 'lane')!.words).toBe('1 merged PR by lane: lane unknown 1 (100%).');
});

it('draws no split when a count is unknown or nothing merged', () => {
  expect(mergedShare([group('claude', 4), { name: 'grok', totals: NONE, buckets: [] }], 'lane')).toBeNull();
  expect(mergedShare([group('claude', 0), group('grok', 0)], 'lane')).toBeNull();
  expect(mergedShare([], 'lane')).toBeNull();
});

it('words a report that names no grouping as lanes', () => {
  expect(groupWords(undefined).title).toBe('Lanes');
  expect([groupLabel('unknown', 'tier'), groupLabel('unknown', undefined), groupLabel('codex', 'lane')]).toEqual(['tier unknown', 'lane unknown', 'codex']);
});
