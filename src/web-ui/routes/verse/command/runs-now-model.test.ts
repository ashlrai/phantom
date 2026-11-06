import { describe, expect, it } from 'vitest';
import { describeRunsNow, readRunsNow, runsNowTiles } from './runs-now-model.js';

const now = Date.parse('2026-01-01T12:00:00Z');
const fixture = () => ({ v: 1, generatedAt: new Date(now).toISOString(), workers: [{ job: 'a' }, { job: 'b' }], mergesLastHour: { count: 2 }, codexPersonal: { usedPct: 64, resetsAt: new Date(now + 3 * 3600000).toISOString(), asOf: null }, leaders: [{ label: 'a', ageSeconds: 500 }, { label: 'b', ageSeconds: 240 }, { label: 'c', ageSeconds: null }], sources: { workers: 'healthy', merges: 'healthy', codex: 'healthy' } });

describe('runs now model', () => {
  it('accepts the needed shape and rejects malformed values', () => {
    const f = fixture();
    expect(readRunsNow(f)).not.toBeNull();
    for (const bad of [null, { ...f, v: 2 }, { ...f, workers: [{}] }, { ...f, mergesLastHour: { count: -1 } }, { ...f, codexPersonal: { ...f.codexPersonal, usedPct: NaN } }, { ...f, leaders: [{ label: 'x', ageSeconds: -1 }] }, { ...f, sources: { ...f.sources, codex: 'unknown' } }]) expect(readRunsNow(bad)).toBeNull();
  });
  it('formats nulls, resets, newest leader and the accessible sentence', () => {
    const f = fixture();
    const tiles = runsNowTiles(readRunsNow(f)!, now);
    expect(tiles.map(t => [t.value, t.caption])).toEqual([['2', null], ['2', null], ['64%', 'resets in 3 h'], ['3', 'newest 4 min ago']]);
    expect(describeRunsNow(tiles)).toBe('Right now: 2 workers, 2 merged last hour, personal Codex 64% used, 3 leader passes (newest 4 min ago).');
    const empty = runsNowTiles(readRunsNow({ ...f, mergesLastHour: { count: null }, codexPersonal: null, leaders: [{ label: 'a', ageSeconds: null }] })!, now);
    expect(empty[1]!.value).toBe('—');
    expect(empty[2]).toMatchObject({ value: '—', caption: null });
    expect(empty[3]!.caption).toBe('no pass seen');
    expect(describeRunsNow(empty)).toContain('unknown merged last hour, personal Codex unknown used');
    expect(runsNowTiles(readRunsNow({ ...f, codexPersonal: { ...f.codexPersonal, resetsAt: new Date(now - 1).toISOString() } })!, now)[2]!.caption).toBe('reset passed');
    expect(runsNowTiles(readRunsNow({ ...f, codexPersonal: { ...f.codexPersonal, resetsAt: null, asOf: new Date(now - 240000).toISOString() } })!, now)[2]!.caption).toBe('as of 4 min ago');
  });
  it('explains degraded sources', () => {
    const f = fixture();
    const tiles = runsNowTiles(readRunsNow({ ...f, sources: { workers: 'missing', merges: 'degraded', codex: 'not-landed' } })!, now);
    expect(tiles.slice(0, 3).map(t => [t.degraded, t.caption])).toEqual([[true, 'worker list missing'], [true, 'merges degraded'], [true, 'resets in 3 h · codex not-landed']]);
  });
});
