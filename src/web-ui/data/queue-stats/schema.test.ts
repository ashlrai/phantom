import { describe, expect, it } from 'vitest';
import { parseQueueStats, rhoBand, selectBottleneck, isSafePoolId, QUEUE_STATIONS, type QueueMetrics } from './schema.js';
import { QUEUE_STATS_EMPTY, QUEUE_STATS_NORMAL, QUEUE_STATS_OVERLOADED } from './fixtures.js';
import { QUEUE_NOW_FIXTURE } from './queue-now-fixture.js';
import { queueNowToStats } from './queue-now.js';

const m = (rho: number | null, queue_growth_per_h = 0, L = 1): QueueMetrics => ({
  status: 'ok', rho, queue_growth_per_h, L, lambda_per_h: 1, mu_per_h: 1, c: 1, W_h: 0, WIP: 0, little_err_pct: 0,
});
const claimed = QUEUE_STATS_NORMAL.stations.claimed;

describe('stations', () => {
  it('match CI Efficiency queue_now.v1 station ids, in order', () => {
    expect(QUEUE_STATIONS).toEqual(Object.keys(QUEUE_NOW_FIXTURE.stations));
    expect(QUEUE_STATIONS).toHaveLength(11);
  });
});

describe('parseQueueStats', () => {
  it('accepts all three fixtures', () => {
    for (const f of [QUEUE_STATS_NORMAL, QUEUE_STATS_OVERLOADED, QUEUE_STATS_EMPTY]) expect(parseQueueStats(f).ok).toBe(true);
  });
  it.each([
    ['null', null],
    ['wrong schema', { ...QUEUE_STATS_NORMAL, schema: 'queue.stats.v2' }],
    ['bad timestamp', { ...QUEUE_STATS_NORMAL, generated_utc: 'nope' }],
    ['zero window', { ...QUEUE_STATS_NORMAL, window_h: 0 }],
    ['stations as array', { ...QUEUE_STATS_NORMAL, stations: [] }],
    ['unknown station', { ...QUEUE_STATS_NORMAL, stations: { shipit: claimed } }],
    ['old station id', { ...QUEUE_STATS_NORMAL, stations: { merge_queue: claimed } }],
    ['negative rho', { ...QUEUE_STATS_NORMAL, stations: { claimed: { ...claimed, rho: -1 } } }],
    ['NaN metric', { ...QUEUE_STATS_NORMAL, stations: { claimed: { ...claimed, mu_per_h: Number.NaN } } }],
    ['string metric', { ...QUEUE_STATS_NORMAL, stations: { claimed: { ...claimed, L: '3' } } }],
    ['bad status', { ...QUEUE_STATS_NORMAL, stations: { claimed: { ...claimed, status: 'fine' } } }],
    ['missing little', { ...QUEUE_STATS_NORMAL, little: undefined }],
    ['token pool id', { ...QUEUE_STATS_NORMAL, pools: [{ ...QUEUE_STATS_NORMAL.pools[0], pool: 'ghp_abcdef123' }] }],
  ])('rejects %s', (_n, input) => {
    expect(parseQueueStats(input).ok).toBe(false);
  });
  it('drops unknown keys', () => {
    const r = parseQueueStats({ ...QUEUE_STATS_NORMAL, token: 'sk-live-xyz', stations: { claimed: { ...claimed, authHeader: 'Bearer x' } } });
    expect(r.ok).toBe(true);
    expect(JSON.stringify(r)).not.toMatch(/sk-live|Bearer/);
  });
  it('pool id safety', () => {
    expect(isSafePoolId('codex-cmp')).toBe(true);
    expect(isSafePoolId('xoxb-123')).toBe(false);
    expect(isSafePoolId('https://x')).toBe(false);
  });
});

describe('queueNowToStats', () => {
  it('maps the queue-now.json snapshot', () => {
    const r = queueNowToStats(QUEUE_NOW_FIXTURE);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.schema).toBe('queue.stats.v1');
    expect(r.value.window_h).toBe(24);
    expect(Object.keys(r.value.stations)).toHaveLength(11);
    expect(r.value.stations.router_queued?.status).toBe('no data');
    expect(r.value.stations.merge_group?.c).toBe(5);
    expect(r.value.stations.pr_ci?.rho).toBeNull();
    expect(r.value.little.drift).toBe(true);
    expect(JSON.stringify(r.value)).not.toMatch(/note|c_source|n_arrivals/);
  });
  it('rejects wrong schema and unknown stations', () => {
    expect(queueNowToStats({ ...QUEUE_NOW_FIXTURE, schema: 'queue.stats.v1' }).ok).toBe(false);
    expect(queueNowToStats({ ...QUEUE_NOW_FIXTURE, stations: { bogus: {} } }).ok).toBe(false);
    expect(queueNowToStats(null).ok).toBe(false);
  });
});

describe('rhoBand', () => {
  it.each([[0, 'green'], [0.69, 'green'], [0.7, 'amber'], [0.849, 'amber'], [0.85, 'red'], [1.4, 'red'], [Number.NaN, 'red'], [null, 'unknown']] as const)(
    'rho %s is %s', (rho, band) => expect(rhoBand(rho)).toBe(band),
  );
});

describe('selectBottleneck', () => {
  it('picks highest rho', () => expect(selectBottleneck({ claimed: m(0.5), pr_ci: m(0.95), live: m(0.2) })).toBe('pr_ci'));
  it('ignores stations with rho n/a', () => expect(selectBottleneck({ pr_open_rework: m(null, 9, 99), release: m(0.1) })).toBe('release'));
  it('breaks rho ties by fastest-growing queue', () =>
    expect(selectBottleneck({ claimed: m(0.9, 1), merge_group: m(0.9, 5), pr_ci: m(0.9, 2) })).toBe('merge_group'));
  it('then by larger L', () => expect(selectBottleneck({ claimed: m(0.9, 1, 2), review: m(0.9, 1, 7) })).toBe('review'));
  it('then by flow order', () => expect(selectBottleneck({ live: m(0.8, 1), claimed: m(0.8, 1) })).toBe('claimed'));
  it('returns null for empty or idle input', () => {
    expect(selectBottleneck({})).toBeNull();
    expect(selectBottleneck({ claimed: m(0), pr_ci: m(null) })).toBeNull();
  });
  it('fixture bottlenecks', () => {
    const o = parseQueueStats(QUEUE_STATS_OVERLOADED);
    expect(o.ok && selectBottleneck(o.value.stations)).toBe('pr_ci');
    const q = queueNowToStats(QUEUE_NOW_FIXTURE);
    expect(q.ok && selectBottleneck(q.value.stations)).toBe('merge_group');
  });
});
