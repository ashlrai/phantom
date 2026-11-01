import { describe, expect, it } from 'vitest';
import type { RunsHistory, RunsSample } from '../../../../core/fleet/runs-history.js';
import { laneSeries, MAX_GAP_MS, stallHeadline } from './capacity-model.js';

const start = Date.parse('2026-11-01T00:00:00Z');
const now = start + 60 * 60_000;
type Lane = RunsSample['lanes'][number];
const lane = (overrides: Partial<Lane> = {}): Lane => ({ lane: 'codex-personal', running: 18, target: 24, queued: 8, held: false, ...overrides });
const history = (minutes: number[], lanes: Lane[]): RunsHistory => ({
  v: 1, generatedAt: new Date(now).toISOString(), from: new Date(start).toISOString(), to: new Date(now).toISOString(), sourceState: 'healthy', dropped: 0,
  samples: minutes.map((minute) => ({ at: new Date(start + minute * 60_000).toISOString(), lanes, workers: 1, leaders: 1, paused: false })),
});

describe('launch stall minutes', () => {
  it('counts queued time with open slots once per minute, not once per slot', () => {
    const series = laneSeries(history([0, 5, 10, 15, 20, 25, 30], [lane()]), now);
    expect(series[0].stallMinutes).toBe(30);
    expect(stallHeadline(series, now)).toBe('Launch stall: codex-personal waited 30 min with 6 open slots');
  });

  it('credits held time instead of stalled time', () => {
    const [series] = laneSeries(history([0, 5], [lane({ held: true })]), now);
    expect(series).toMatchObject({ heldMinutes: 5, stallMinutes: 0 });
  });

  it('does not count a full lane or an empty queue', () => {
    const series = laneSeries(history([0, 5], [lane({ running: 24 }), lane({ lane: 'idle', queued: 0 })]), now);
    expect(series.map((item) => item.stallMinutes)).toEqual([0, 0]);
    expect(stallHeadline(series, now)).toBeNull();
    expect(stallHeadline([], now)).toBeNull();
  });

  it('caps each sample gap at MAX_GAP_MS', () => {
    const [series] = laneSeries(history([0, 30], [lane()]), now);
    expect(series.stallMinutes).toBe(MAX_GAP_MS / 60_000);
  });

  it('selects the lane with the most stalled time and uses its latest open slots', () => {
    const data = history([0, 5, 10], [lane(), lane({ lane: 'devin', running: 2, target: 4 })]);
    data.samples[1].lanes = [lane(), lane({ lane: 'devin', running: 4, target: 4 })];
    data.samples[2].lanes = [lane({ running: 25 }), lane({ lane: 'devin' })];
    const series = laneSeries(data, now);
    expect(series.map((item) => item.stallMinutes)).toEqual([10, 5]);
    expect(stallHeadline(series, now)).toBe('Launch stall: codex-personal waited 10 min with 0 open slots');
  });
});
