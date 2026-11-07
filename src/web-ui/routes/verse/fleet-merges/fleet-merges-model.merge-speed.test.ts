import { describe, expect, it } from 'vitest';
import { openToMergeText, readMerges, readMergeSpeed } from './fleet-merges-model.js';
import { mergesMarkdown } from './merges-markdown.js';

const item = (number: number, extra: Record<string, unknown> = {}) => ({ repo: 'org/repo', number, title: `PR ${number}`, ...extra });
const openedAt = '2026-11-01T04:00:00Z';
const mergedAt = '2026-11-01T05:05:00Z';

describe('merge speed', () => {
  it('prefers server durations and aggregate values, including zero', () => {
    const snapshot = { mergesLastHour: { perHour: 42, medianOpenToMergeMs: 0, items: [item(1, { openedAt, mergedAt, openToMergeMs: 720_000 })] } };
    expect(readMerges(snapshot).merged[0]).toMatchObject({ openedAt, mergedAt, openToMergeMs: 720_000 });
    expect(readMergeSpeed(snapshot)).toEqual({ perHour: 42, medianOpenToMergeMs: 0, sample: 1 });
    expect(mergesMarkdown(readMerges(snapshot), Date.parse(mergedAt))).toContain('open → merge 12 min');
  });

  it('computes from stamps, falling back to the matching publish time', () => {
    const snapshot = { mergesLastHour: { items: [item(1, { openedAt, mergedAt }), item(2, { mergedAt }), item(3, { mergedAt })] }, publishesLastHour: [
      { at: openedAt, url: 'https://github.com/org/repo/pull/2' },
      { at: openedAt, url: 'https://github.com/org/repo/pull/4' },
    ] };
    const merged = readMerges(snapshot).merged;
    expect(merged.find(pr => pr.number === 1)).toMatchObject({ openedAt, mergedAt, openToMergeMs: 3_900_000 });
    expect(merged.find(pr => pr.number === 2)).toMatchObject({ openedAt, mergedAt, openToMergeMs: 3_900_000 });
    expect(merged.find(pr => pr.number === 3)).toMatchObject({ openedAt: null, mergedAt, openToMergeMs: null });
  });

  it('takes the median of valid mixed durations and excludes invalid times', () => {
    const snapshot = { mergesLastHour: { perHour: -1, medianOpenToMergeMs: NaN, items: [
      item(1, { openToMergeMs: 120_000 }), item(2, { openedAt, mergedAt: '2026-11-01T04:04:00Z' }),
      item(3, { openToMergeMs: 600_000 }), item(4, { openToMergeMs: 480_000 }),
      item(5, { openedAt: 'bad', mergedAt }), item(6, { openedAt: mergedAt, mergedAt: openedAt }), item(7),
    ] } };
    expect(readMergeSpeed(snapshot)).toEqual({ perHour: null, medianOpenToMergeMs: 360_000, sample: 4 });
  });

  it('formats durations in minutes and hours', () => {
    expect(openToMergeText(720_000)).toBe('12 min');
    expect(openToMergeText(3_900_000)).toBe('1 h 05 min');
    expect(openToMergeText(0)).toBe('0 min');
    expect(openToMergeText(null)).toBe('—');
    expect(openToMergeText(Infinity)).toBe('—');
  });

  it('leaves timing unknown when the snapshot has no merge timing', () => {
    const snapshot = { mergesLastHour: { count: 1, items: [item(1)] }, publishesLastHour: [{ at: openedAt, url: 'https://github.com/org/repo/pull/1' }] };
    expect(readMerges(snapshot).merged[0]).toMatchObject({ openedAt, mergedAt: null, openToMergeMs: null });
    expect(readMergeSpeed(snapshot)).toEqual({ perHour: null, medianOpenToMergeMs: null, sample: 0 });
    expect(readMergeSpeed(null)).toEqual({ perHour: null, medianOpenToMergeMs: null, sample: 0 });
  });
});
