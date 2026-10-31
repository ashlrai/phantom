import { describe, expect, it } from 'vitest';
import { funnelCaveat, funnelStages, joinPublishes, mergeRateText, readFunnelInput } from './publish-funnel-model.js';

const fixture = () => ({
  v: 1, generatedAt: '2026-10-31T10:00:00Z', workers: [{ job: 'running' }],
  publishesLastHour: [
    { job: 'RQ-ONE', lane: 'codex', url: null, at: '2026-10-31T09:10:00Z' },
    { job: 'RQ-TWO', lane: null, url: 'https://github.com/example/repo/pull/2', at: '2026-10-31T09:30:00Z' },
    { job: 'RQ-THREE', lane: null, url: null, at: '2026-10-31T09:20:00Z' },
  ],
  mergesLastHour: { count: 2 as number | null, items: [
    { repo: 'example/repo', number: 1, title: 'bridge: RQ-ONE' },
    { repo: 'example/repo', number: 2, title: 'Other title' },
  ] }, sources: { merges: 'healthy' },
});

describe('publish funnel model', () => {
  it('strictly narrows the fields it consumes', () => {
    const value = fixture();
    expect(readFunnelInput(value)).toEqual(value);
    for (const invalid of [null, {}, { ...value, v: 2 }, { ...value, workers: [{}] },
      { ...value, publishesLastHour: [{ ...value.publishesLastHour[0], lane: 4 }] },
      { ...value, mergesLastHour: { count: -1, items: [] } },
      { ...value, mergesLastHour: { count: null, items: [{ repo: 'x', number: '2', title: 'x' }] } },
      { ...value, sources: {} }]) expect(readFunnelInput(invalid)).toBeNull();
  });
  it('preserves unknown merge counts', () => {
    const value = fixture(); value.mergesLastHour.count = null;
    expect(funnelStages(value).map(s => s.value)).toEqual([1, 3, null]);
  });
  it('joins titles and PR numbers and sorts newest first', () => {
    expect(joinPublishes(fixture()).map(({ job, state, number }) => [job, state, number])).toEqual([
      ['RQ-TWO', 'merged', 2], ['RQ-THREE', 'waiting', null], ['RQ-ONE', 'merged', 1],
    ]);
  });
  it('reports degraded sources and merge rate wording', () => {
    const value = fixture();
    expect(funnelCaveat(value)).toBeNull();
    value.sources.merges = 'degraded';
    expect(funnelCaveat(value)).toBe('Merge count from GitHub is degraded; waiting rows may already be merged.');
    expect(mergeRateText(5, 2)).toBe('2 of 5 published merged');
    expect(mergeRateText(0, 0)).toBe('no publishes yet');
    expect(mergeRateText(0, null)).toBe('merged count unknown');
  });
});
