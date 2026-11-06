import { describe, expect, it } from 'vitest';
import { readMerges } from './fleet-merges-model.js';

describe('fleet merges model', () => {
  it('joins publishes by title and orders merges, waiting publishes, and lanes', () => {
    const data = readMerges({
      mergesLastHour: { count: 2, items: [{ repo: 'ashlrai/phantom', number: 3, title: 'bridge: RQ-ONE' }, { repo: 'ashlrai/other', number: 20, title: 'Fix' }] },
      publishesLastHour: [
        { job: 'RQ-ONE', lane: 'a', at: '2026-01-03T00:00:00Z', url: 'https://github.com/ashlrai/phantom/pull/3' },
        { job: 'RQ-TWO', lane: null, at: '2026-01-01T00:00:00Z', url: 'https://github.com/ashlrai/phantom/pull/4' },
        { job: 'RQ-THREE', lane: 'b', at: '2026-01-02T00:00:00Z', url: 'https://github.com/ashlrai/phantom/pull/5' },
        { job: 'RQ-BAD', at: 'invalid', url: null },
      ],
      lanes: [{ lane: 'unknown', merged24h: null, mergeRate24h: null }, { lane: 'low', merged24h: 1, mergeRate24h: 0 }, { lane: 'high', merged24h: 4, mergeRate24h: 75 }],
      sources: { merges: 'healthy' },
    });
    expect(data.merged.map(item => item.number)).toEqual([20, 3]);
    expect(data.merged[1].href).toBe('https://github.com/ashlrai/phantom/pull/3');
    expect(data.pending.map(item => item.job)).toEqual(['RQ-THREE', 'RQ-TWO', 'RQ-BAD']);
    expect(data.pending[1]).toMatchObject({ lane: null, href: 'https://github.com/ashlrai/phantom/pull/4' });
    expect(data.lanes.map(item => item.lane)).toEqual(['high', 'low', 'unknown']);
    expect(data).toMatchObject({ count: 2, sourceState: 'healthy' });
  });

  it('only creates canonical GitHub pull request links', () => {
    const urls = ['https://github.com/owner/repo/pull/1', 'https://github.com/owner/repo/pull/1?x=1', 'https://github.com/owner/repo/pull/1#x', 'https://evil.com/owner/repo/pull/1', 'https://github.com.evil.com/owner/repo/pull/1', 'https://github.com/owner/repo/issues/1', 'https://github.com/owner/repo/pull/0', 'https://user@github.com/owner/repo/pull/1'];
    const data = readMerges({ publishesLastHour: urls.map((url, index) => ({ job: `job-${index}`, at: 'bad', url })), mergesLastHour: { items: [{ repo: 'evil.com/owner/repo', number: 1, title: 'unsafe' }, { repo: 'owner/repo?x=1', number: 2, title: 'unsafe' }] } });
    expect(data.pending.map(item => item.href)).toEqual([urls[0], ...urls.slice(1).map(() => null)]);
    expect(data.merged.every(item => item.href === null)).toBe(true);
  });

  it('keeps missing or invalid values unknown and skips malformed entries', () => {
    expect(readMerges(null)).toEqual({ merged: [], pending: [], lanes: [], count: null, sourceState: null });
    expect(readMerges({ mergesLastHour: { count: -1, items: [null, { repo: 'a/b', number: 0, title: 'bad' }] }, publishesLastHour: [null, { job: '', at: 'x' }], lanes: [null, { lane: 'a', merged24h: NaN, mergeRate24h: Infinity }] })).toEqual({ merged: [], pending: [], lanes: [{ lane: 'a', merged24h: null, mergeRate24h: null }], count: null, sourceState: null });
  });
});
