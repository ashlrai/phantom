/**
 * model.test.ts — parseQueueStats / rhoBand / selectBottleneck against the
 * exact shape `phm queue stats --json` emits (estimateQueueStats output).
 */
import { describe, expect, it } from 'vitest';
import {
  parseQueueStats,
  rhoBand,
  selectBottleneck,
  type QueueStationMetrics,
} from './model.js';

const NOW = 1_761_488_400_000; // 2026-10-26T07:00:00Z

function win(over: Partial<Record<string, number | null>> = {}) {
  return {
    windowMs: 3_600_000,
    since: NOW - 3_600_000,
    until: NOW,
    arrivals: 6,
    departures: 6,
    lambda: 6 / 3600,
    mu: 10 / 3600,
    rho: 0.6,
    queueLength: 1.5,
    wait: 900,
    wip: 2.5,
    currentQueueLength: 2,
    currentWip: 3,
    littleLaw: { L: 2.5, W: 1500, lambdaW: 2.5, drift: 0, flagged: false },
    ...over,
  };
}

function station(name: string, over: Partial<Record<string, number | null>> = {}, windows?: unknown[]) {
  return { station: name, windows: windows ?? [win(over)] };
}

function payload(over: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    generatedAt: NOW,
    units: { rates: 'per-second', durations: 'seconds' },
    stations: [
      station('planned', { rho: 0.4, currentQueueLength: 1 }),
      station('pr-ci', { rho: 0.95, currentQueueLength: 7 }),
      station('merged', { rho: 0.2, currentQueueLength: 0, arrivals: 2 }),
    ],
    pools: [{ pool: 'codex-personal', windows: [win({ rho: 0.8 })] }],
    ...over,
  };
}

const metrics = (station: string, over: Partial<QueueStationMetrics> = {}): QueueStationMetrics => ({
  station,
  label: station,
  windowMs: 3_600_000,
  arrivals: 1,
  departures: 1,
  lambda: 1 / 3600,
  mu: 1 / 3600,
  rho: 0.5,
  queueLength: 1,
  wait: 60,
  wip: 1,
  currentQueueLength: 1,
  currentWip: 1,
  littleDrift: false,
  ...over,
});

describe('parseQueueStats', () => {
  it('accepts the real payload and orders stations by pipeline position', () => {
    const r = parseQueueStats(payload());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.stations.map((s) => s.station)).toEqual(['planned', 'pr-ci', 'merged']);
    expect(r.value.stations[1]!.label).toBe('PR CI');
    expect(r.value.stations[1]!.rho).toBe(0.95);
    expect(r.value.stations[1]!.currentQueueLength).toBe(7);
    expect(r.value.pools[0]!.pool).toBe('codex-personal');
    expect(r.value.windowMs).toBe(3_600_000);
  });

  it('keeps unknown-but-safe station ids after the canonical pipeline', () => {
    const r = parseQueueStats(payload({ stations: [station('custom-stage'), station('planned')] }));
    expect(r.ok && r.value.stations.map((s) => s.station)).toEqual(['planned', 'custom-stage']);
    if (r.ok) expect(r.value.stations[1]!.label).toBe('custom-stage');
  });

  it.each([
    ['non-object', null],
    ['wrong schema', payload({ schemaVersion: 2 })],
    ['missing generatedAt', payload({ generatedAt: 'x' })],
    ['stations not an array', payload({ stations: {} })],
    ['pools not an array', payload({ pools: 'x' })],
  ])('rejects %s', (_name, input) => {
    expect(parseQueueStats(input).ok).toBe(false);
  });

  it('drops malformed windows, duplicate stations and unsafe identifiers silently', () => {
    const r = parseQueueStats(payload({
      stations: [
        station('planned'),
        station('planned'), // duplicate
        station('ghp_leakyleakyleaky'), // secret-shaped id
        { station: 'pr-ci', windows: [{ windowMs: -1 }] }, // bad window
      ],
      token: 'sk-smuggled',
    }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.stations.map((s) => s.station)).toEqual(['planned']);
    expect(JSON.stringify(r.value)).not.toMatch(/sk-smuggled|ghp_/);
  });

  it('picks the requested window when several are present', () => {
    const wide = win({ rho: 0.1, windowMs: 86_400_000 });
    const r = parseQueueStats(payload({ stations: [station('merged', {}, [win({ rho: 0.9 }), wide])] }), 86_400_000);
    expect(r.ok && r.value.stations[0]!.rho).toBe(0.1);
  });

  it('preserves null mu/rho/wait rather than inventing zeros', () => {
    const r = parseQueueStats(payload({ stations: [station('claimed', { mu: null, rho: null, wait: null })] }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.stations[0]!.rho).toBeNull();
    expect(r.value.stations[0]!.mu).toBeNull();
  });
});

describe('rhoBand', () => {
  it.each([
    [{ rho: 0 }, 'green'],
    [{ rho: 0.69 }, 'green'],
    [{ rho: 0.7 }, 'amber'],
    [{ rho: 0.9 }, 'red'],
    [{ rho: 1.4 }, 'red'],
    [{ rho: null }, 'unknown'],
  ] as const)('active station with %o is %s', (over, band) => {
    expect(rhoBand(metrics('x', over))).toBe(band);
  });

  it('marks a station with no arrivals and no work as idle', () => {
    expect(rhoBand(metrics('x', { arrivals: 0, currentQueueLength: 0, currentWip: 0, rho: 0 }))).toBe('idle');
  });
});

describe('selectBottleneck', () => {
  it('picks the highest rho', () =>
    expect(selectBottleneck([metrics('a', { rho: 0.4 }), metrics('b', { rho: 0.95 })])).toBe('b'));

  it('treats active stations with no measured service as saturated', () =>
    expect(selectBottleneck([metrics('a', { rho: 0.99 }), metrics('b', { rho: null, mu: null })])).toBe('b'));

  it('breaks rho ties on the larger current queue, then pipeline order', () => {
    expect(selectBottleneck([
      metrics('merged', { rho: 0.9, currentQueueLength: 1 }),
      metrics('claimed', { rho: 0.9, currentQueueLength: 1 }),
    ])).toBe('claimed');
    expect(selectBottleneck([
      metrics('a', { rho: 0.9, currentQueueLength: 2 }),
      metrics('b', { rho: 0.9, currentQueueLength: 9 }),
    ])).toBe('b');
  });

  it('returns null when nothing is active', () => {
    const idle = metrics('a', { arrivals: 0, currentQueueLength: 0, currentWip: 0, rho: 0 });
    expect(selectBottleneck([])).toBeNull();
    expect(selectBottleneck([idle])).toBeNull();
  });
});
