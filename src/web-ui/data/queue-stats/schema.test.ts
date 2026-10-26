import { describe, expect, it } from 'vitest';
import { parseQueueStats, rhoBand, selectBottleneck, isSafePoolId, type QueueStationStats } from './schema.js';
import { QUEUE_STATS_EMPTY, QUEUE_STATS_NORMAL, QUEUE_STATS_OVERLOADED } from './fixtures.js';

const s = (station: QueueStationStats['station'], rho: number, queueGrowthPerHour = 0, queueLength = 1): QueueStationStats => ({
  station, rho, queueGrowthPerHour, queueLength, lambda: 1, mu: 1, waitSec: 0, wip: 0,
});

describe('parseQueueStats', () => {
  it('accepts all three fixtures', () => {
    for (const f of [QUEUE_STATS_NORMAL, QUEUE_STATS_OVERLOADED, QUEUE_STATS_EMPTY]) expect(parseQueueStats(f).ok).toBe(true);
  });
  it.each([
    ['null', null],
    ['wrong schema', { ...QUEUE_STATS_NORMAL, schema: 'queue.stats.v2' }],
    ['bad timestamp', { ...QUEUE_STATS_NORMAL, generatedAt: 'nope' }],
    ['zero window', { ...QUEUE_STATS_NORMAL, windowSec: 0 }],
    ['unknown station', { ...QUEUE_STATS_NORMAL, stations: [{ ...QUEUE_STATS_NORMAL.stations[0], station: 'shipit' }] }],
    ['duplicate station', { ...QUEUE_STATS_NORMAL, stations: [QUEUE_STATS_NORMAL.stations[0], QUEUE_STATS_NORMAL.stations[0]] }],
    ['negative rho', { ...QUEUE_STATS_NORMAL, stations: [{ ...QUEUE_STATS_NORMAL.stations[0], rho: -1 }] }],
    ['NaN metric', { ...QUEUE_STATS_NORMAL, stations: [{ ...QUEUE_STATS_NORMAL.stations[0], mu: Number.NaN }] }],
    ['missing little', { ...QUEUE_STATS_NORMAL, little: undefined }],
    ['token pool id', { ...QUEUE_STATS_NORMAL, pools: [{ ...QUEUE_STATS_NORMAL.pools[0], pool: 'ghp_abcdef123' }] }],
  ])('rejects %s', (_n, input) => {
    expect(parseQueueStats(input).ok).toBe(false);
  });
  it('drops unknown keys and sorts stations into pipeline order', () => {
    const r = parseQueueStats({
      ...QUEUE_STATS_NORMAL,
      token: 'sk-live-xyz',
      stations: [{ ...QUEUE_STATS_NORMAL.stations[3], authHeader: 'Bearer x' }, QUEUE_STATS_NORMAL.stations[0]],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.stations.map((x) => x.station)).toEqual(['planned', 'pr_ci']);
    expect(JSON.stringify(r.value)).not.toMatch(/sk-live|Bearer/);
  });
  it('pool id safety', () => {
    expect(isSafePoolId('codex-cmp')).toBe(true);
    expect(isSafePoolId('xoxb-123')).toBe(false);
    expect(isSafePoolId('https://x')).toBe(false);
  });
});

describe('rhoBand', () => {
  it.each([[0, 'green'], [0.69, 'green'], [0.7, 'amber'], [0.89, 'amber'], [0.9, 'red'], [1.4, 'red'], [Number.NaN, 'red']])(
    'rho %s is %s', (rho, band) => expect(rhoBand(rho)).toBe(band),
  );
});

describe('selectBottleneck', () => {
  it('picks highest rho', () => expect(selectBottleneck([s('ready', 0.5), s('pr_ci', 0.95), s('merged', 0.2)])).toBe('pr_ci'));
  it('breaks rho ties by fastest-growing queue', () =>
    expect(selectBottleneck([s('ready', 0.9, 1), s('merge_queue', 0.9, 5), s('pr_ci', 0.9, 2)])).toBe('merge_queue'));
  it('breaks full ties by earliest station', () => expect(selectBottleneck([s('merged', 0.8, 1), s('claimed', 0.8, 1)])).toBe('claimed'));
  it('returns null for empty or idle input', () => {
    expect(selectBottleneck([])).toBeNull();
    expect(selectBottleneck([s('ready', 0, 0, 0)])).toBeNull();
  });
  it('overloaded fixture bottleneck is pr_ci', () => {
    const r = parseQueueStats(QUEUE_STATS_OVERLOADED);
    expect(r.ok && selectBottleneck(r.value.stations)).toBe('pr_ci');
  });
});
