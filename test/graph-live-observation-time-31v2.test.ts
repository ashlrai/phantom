import { describe, expect, it, vi } from 'vitest';
import { joinGraphLive, readGraphLive, type GraphLiveSources } from '../src/core/fleet/graph-live.js';
import * as subscription from '../src/core/fleet/subscription-usage.js';
import type { RegistryGraph } from '../src/core/graph/types.js';
import type { SeatCapacity } from '../src/core/routing/headroom.js';

const NOW = Date.parse('2026-10-31T12:00:00.000Z');
const MAX_AGE = 60_000;
const graph: RegistryGraph = {
  schema: 'graph.v1', readOnly: true, complete: true,
  sources: { fleet: 'loaded', seats: 'loaded' }, issues: [], edges: [],
  nodes: [{ id: 'account', kind: 'engine-account', engine: 'codex', accountId: 'work', seatIds: ['seat'] }],
};
const usage = { usedPercent: 20, windowLabel: '5h' };

function seat(observedAt: string | null, usedPercent = 30, extra: Partial<SeatCapacity> = {}): SeatCapacity {
  return {
    seatId: 'seat', engine: 'codex', label: 'seat', free: false, signedOut: false,
    reachable: true, contextWindow: null, observedAt, spentTodayUsd: null,
    windows: [{ id: 'window', usedPercent, resetsAt: null, resetDescription: null, limitReached: false }],
    ...extra,
  };
}

function project(sources: GraphLiveSources) {
  return joinGraphLive(graph, sources, { nowMs: NOW, readingMaxAgeMs: MAX_AGE });
}

function live(sources: GraphLiveSources) {
  return project(sources).nodes[0]!.live;
}

describe('graph live observation times', () => {
  it.each([
    ['missing', undefined], ['NaN', NaN], ['Infinity', Infinity],
    ['negative Infinity', -Infinity], ['future', NOW + 1],
  ])('treats a %s wrapper timestamp as unknown', (_label, observedAtMs) => {
    const result = live({ seats: [], usage: { codex: { usage, observedAtMs } } });
    expect(result).toMatchObject({ state: 'unknown', readingAgeMs: null, usedPercent: null, stale: false });
    expect(result.reasons).toContain('codex subscription 5h: reading undated or timestamp invalid');
  });

  it('accepts exact-now wrappers and direct legacy current snapshots', () => {
    for (const input of [{ usage, observedAtMs: NOW }, usage]) {
      expect(live({ seats: [], usage: { codex: input } }))
        .toMatchObject({ state: 'ready', readingAgeMs: 0, usedPercent: 20, stale: false });
    }
  });

  it('marks an old wrapper stale without reporting its percentage as fresh', () => {
    expect(live({ seats: [], usage: { codex: { usage, observedAtMs: NOW - MAX_AGE - 1 } } }))
      .toMatchObject({ state: 'stale', readingAgeMs: MAX_AGE + 1, usedPercent: null, stale: true });
  });

  it('keeps fresh evidence when mixed with stale evidence', () => {
    const result = live({
      seats: [seat(new Date(NOW - MAX_AGE - 1).toISOString(), 90)],
      usage: { codex: { usage, observedAtMs: NOW - 500 } },
    });
    expect(result).toMatchObject({ state: 'ready', readingAgeMs: 500, usedPercent: 20, stale: false });
    expect(result.reasons).toContain('seat seat: reading stale');
  });

  it('does not let a future high timestamp mask an old seat or imply headroom', () => {
    const result = live({
      seats: [seat(new Date(NOW - MAX_AGE - 1).toISOString())],
      usage: { codex: { usage: { ...usage, usedPercent: 99 }, observedAtMs: NOW + 1_000_000 } },
    });
    expect(result).toMatchObject({ state: 'stale', readingAgeMs: MAX_AGE + 1, usedPercent: null, stale: true });
    expect(result.reasons).toContain('codex subscription 5h: reading undated or timestamp invalid');
  });

  it.each([null, 'invalid', new Date(NOW + 1).toISOString()])(
    'does not treat a seat with timestamp %s as fresh', (observedAt) => {
      expect(live({ seats: [seat(observedAt)] }))
        .toMatchObject({ state: 'unknown', readingAgeMs: null, usedPercent: null, stale: false });
    },
  );

  it('preserves held and saturation signals without inventing an age or measurement', () => {
    expect(live({ seats: [seat(new Date(NOW + 1).toISOString(), 30, { signedOut: true })] }))
      .toMatchObject({ state: 'held', readingAgeMs: null, usedPercent: null });
    expect(live({ seats: [], usage: { codex: { usage: { ...usage, usedPercent: 100 }, observedAtMs: NOW } } }))
      .toMatchObject({ state: 'exhausted', readingAgeMs: 0, usedPercent: 100 });
    const unknownAge = live({ seats: [], usage: { codex: { usage: { ...usage, usedPercent: 100 } } } });
    expect(unknownAge).toMatchObject({ state: 'exhausted', readingAgeMs: null, usedPercent: null });
    expect(unknownAge.reasons).toContain('codex subscription 5h: reading undated or timestamp invalid');
    expect(live({ seats: [seat(null, 10, {
      windows: [{ id: 'window', usedPercent: null, resetsAt: null, resetDescription: null, limitReached: true }],
    })] })).toMatchObject({ state: 'exhausted', readingAgeMs: null, usedPercent: null });
  });

  it('uses the explicit clock for readGraphLive collected usage', () => {
    const spy = vi.spyOn(subscription, 'subscriptionUsage').mockReturnValue(usage);
    try {
      const result = readGraphLive(graph, {
        nowMs: NOW, seats: [], verdicts: {}, quota: { events: [] },
      }).nodes[0]!.live;
      expect(result).toMatchObject({ state: 'ready', readingAgeMs: 0, usedPercent: 20 });
      expect(spy).toHaveBeenCalledOnce();
    } finally {
      spy.mockRestore();
    }
  });

  it('is deterministic and leaves malformed timestamps and all inputs unchanged', () => {
    const sources: GraphLiveSources = {
      seats: [seat(new Date(NOW - MAX_AGE - 1).toISOString())],
      usage: { codex: { usage: { ...usage }, observedAtMs: NaN } },
    };
    const before = structuredClone({ graph, sources });
    expect(project(sources)).toEqual(project(sources));
    expect({ graph, sources }).toEqual(before);
  });
});
