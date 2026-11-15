/**
 * RQ-PHX-RECUTVERSEA61: recut of #950 (live queue station graph, RQ-QUEUE-5).
 * Exercises the real `queue.stats.v1` contract the desktop graph renders from:
 * band thresholds, bottleneck selection, whitelisting of untrusted input and
 * the CI Efficiency `queue_now.v1` adapter.
 */
import { describe, expect, it } from 'vitest';
import {
  QUEUE_STATIONS,
  parseQueueStats,
  rhoBand,
  selectBottleneck,
  type QueueMetrics,
} from '../src/web-ui/data/queue-stats/schema.js';
import { QUEUE_STATS_NORMAL, QUEUE_STATS_OVERLOADED, QUEUE_STATS_EMPTY } from '../src/web-ui/data/queue-stats/fixtures.js';
import { commandQueueStatsSource, httpQueueStatsSource, queueNowQueueStatsSource } from '../src/web-ui/data/queue-stats/source.js';
import { QUEUE_NOW_FIXTURE } from '../src/web-ui/data/queue-stats/queue-now-fixture.js';

const metrics = (rho: number | null, growth: number | null = 0, L: number | null = 1): QueueMetrics => ({
  status: 'ok', rho, queue_growth_per_h: growth, L, lambda_per_h: 1, mu_per_h: 1, c: 1, W_h: 0, WIP: 0, little_err_pct: 0,
});

describe('recut #950: queue.stats.v1 station graph data', () => {
  it('bands rho at the controller HOT/COLD thresholds', () => {
    expect(rhoBand(0.69)).toBe('green');
    expect(rhoBand(0.7)).toBe('amber');
    expect(rhoBand(0.849)).toBe('amber');
    expect(rhoBand(0.85)).toBe('red');
    expect(rhoBand(Number.POSITIVE_INFINITY)).toBe('red');
    expect(rhoBand(null)).toBe('unknown');
  });

  it('picks the highest-rho station and breaks ties by queue growth, then flow order', () => {
    expect(selectBottleneck({ claimed: metrics(0.5), review: metrics(0.9) })).toBe('review');
    expect(selectBottleneck({ claimed: metrics(0.9, 1), review: metrics(0.9, 3) })).toBe('review');
    expect(selectBottleneck({ claimed: metrics(0.9, 2, 4), review: metrics(0.9, 2, 4) })).toBe('claimed');
    expect(selectBottleneck({ claimed: metrics(0), review: metrics(null) })).toBeNull();
  });

  it('accepts every shipped fixture and drops keys outside the whitelist', () => {
    for (const fixture of [QUEUE_STATS_NORMAL, QUEUE_STATS_OVERLOADED, QUEUE_STATS_EMPTY]) {
      expect(parseQueueStats(fixture).ok).toBe(true);
    }
    const leaky = {
      ...QUEUE_STATS_NORMAL,
      note: 'free text must not survive',
      stations: { claimed: { ...QUEUE_STATS_NORMAL.stations.claimed, c_source: 'free text' } },
    };
    const parsed = parseQueueStats(leaky);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(JSON.stringify(parsed.value)).not.toContain('free text');
    expect(parseQueueStats({ ...QUEUE_STATS_NORMAL, pools: [{ pool: 'api_key-pool' }] }).ok).toBe(false);
  });

  it('maps queue_now.v1 onto every station and derives the Little drift flag', async () => {
    const r = await queueNowQueueStatsSource(() => QUEUE_NOW_FIXTURE).load();
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(Object.keys(r.value.stations)).toEqual([...QUEUE_STATIONS]);
    expect(r.value.pools).toEqual([]);
    const maxErr = Math.max(...Object.values(QUEUE_NOW_FIXTURE.stations).map((s) => (s as { little_err_pct?: number }).little_err_pct ?? 0));
    expect(r.value.little.ratio).toBeCloseTo(maxErr / 100);
    expect(r.value.little.drift).toBe(maxErr > 20);
  });

  it('reports unwired or failing sources as errors instead of throwing', async () => {
    expect((await commandQueueStatsSource().load()).ok).toBe(false);
    expect(await commandQueueStatsSource(async () => 'not json').load()).toEqual({
      ok: false,
      error: 'phm queue stats output was not valid JSON',
    });
    const down = (async () => new Response('', { status: 503 })) as typeof fetch;
    expect(await httpQueueStatsSource('/api/queue/stats', down).load()).toEqual({
      ok: false,
      error: 'queue stats route returned 503',
    });
  });
});
