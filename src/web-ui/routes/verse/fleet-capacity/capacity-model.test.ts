import { describe, expect, it } from 'vitest';
import type { RunsHistory, RunsSample } from '../../../../core/fleet/runs-history.js';
import { headline, laneSeries, launchGaps, sparkPath } from './capacity-model.js';
import { isRunsHistory } from './capacity-queries.js';

const base = Date.parse('2026-10-31T12:00:00Z');
const sample = (minute: number, running = 1, queued = 1, held = false): RunsSample => ({
  at: new Date(base + minute * 60_000).toISOString(), lanes: [{ lane: 'codex', running, target: 3, queued, held }], workers: 1, leaders: null, paused: false,
});
const history = (samples: RunsSample[]): RunsHistory => ({ v: 1, generatedAt: new Date(base + 60 * 60_000).toISOString(), from: new Date(base).toISOString(), to: new Date(base + 60 * 60_000).toISOString(), sourceState: 'healthy', dropped: 0, samples });

describe('capacity history', () => {
  it('calculates sampled fill, capped idle slot-minutes and held minutes', () => {
    const data = history([sample(0, 1, 1, true), sample(1, 2), sample(21, 0)]);
    const series = laneSeries(data, base + 60 * 60_000)[0];
    expect(series.fillPct).toBeCloseTo(100 / 3);
    expect(series).toMatchObject({ idleSlotMinutes: 7, heldMinutes: 1 });
    const zero = history([{ ...sample(0), lanes: [{ ...sample(0).lanes[0], target: 0 }] }]);
    expect(laneSeries(zero, base + 60 * 60_000)[0].fillPct).toBeNull();
  });
  it('finds a 45-minute flat stretch with queued work but never invents coverage', () => {
    const flat = Array.from({ length: 46 }, (_, i) => sample(i));
    expect(launchGaps(history(flat))).toEqual([{ fromMs: base, toMs: base + 45 * 60_000, minutes: 45 }]);
    const emptyQueue = flat.map((s) => ({ ...s, lanes: s.lanes.map((l) => ({ ...l, queued: 0 })) }));
    expect(launchGaps(history(emptyQueue))).toEqual([]);
    expect(launchGaps(history([sample(0), sample(45)]))).toEqual([]);
    expect(launchGaps(history(flat.map((s, i) => i === 20 ? sample(i, 2) : s)))).toEqual([]);
  });
  it('returns only the five newest gaps while counting all of them in the headline', () => {
    const samples = Array.from({ length: 6 }, (_, gap) => [
      ...Array.from({ length: 31 }, (_, minute) => sample(gap * 32 + minute)),
      sample(gap * 32 + 31, 1, 0),
    ]).flat();
    const data = { ...history(samples), to: new Date(base + 200 * 60_000).toISOString() };
    expect(launchGaps(data)).toHaveLength(5);
    expect(launchGaps(data)[0].fromMs).toBe(base + 160 * 60_000);
    expect(headline(data, base + 200 * 60_000)).toContain('6 launch gaps (longest 30 min)');
  });
  it('summarizes source quality even when no samples exist', () => {
    expect(headline({ ...history([]), sourceState: 'degraded', dropped: 2 }, base)).toContain('source degraded · 2 dropped');
    expect(headline(history([sample(0)]), base)).toContain('1 lane · 1 sample · 0 launch gaps');
  });
  it('draws deterministic paths with breaks for missing observations', () => {
    const points = [{ atMs: base, running: 1, target: 2 }, { atMs: base + 60_000, running: 2, target: 2 }, { atMs: base + 10 * 60_000, running: 0, target: 2 }];
    expect(sparkPath(points, 100, 20)).toEqual({ running: 'M0.00,10.00 L10.00,0.00 M100.00,20.00', target: 'M0.00,0.00 L10.00,0.00 M100.00,0.00' });
    expect(sparkPath([], 100, 20)).toEqual({ running: '', target: '' });
  });
  it('rejects malformed history before the pane consumes it', () => {
    expect(isRunsHistory(history([sample(0)]))).toBe(true);
    expect(isRunsHistory({ ...history([sample(0)]), samples: [{ ...sample(0), workers: -1 }] })).toBe(false);
    expect(isRunsHistory({ ...history([sample(0)]), samples: [{ ...sample(0), at: 'invalid' }] })).toBe(false);
  });
});
