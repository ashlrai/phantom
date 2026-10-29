import { describe, expect, it, vi, afterEach } from 'vitest';
import { estimateQueueStats, isQueueVisit, type QueueVisit } from '../src/core/queue/stats.js';
import { cmdQueue } from '../src/cli/queue.js';
import { readQueueVisits } from '../src/core/queue/journal.js';

vi.mock('../src/core/queue/journal.js', () => ({ readQueueVisits: vi.fn(async () => []) }));
afterEach(() => vi.restoreAllMocks());

function metric(visits: QueueVisit[], now = 100000, window = 100000) {
  return estimateQueueStats(visits, now, [window]).stations[0]!.windows[0]!;
}

describe('queue estimator synthetic arrival properties', () => {
  // Deterministic generated traces, including overlapping service and heterogeneous waits.
  for (let seed = 1; seed <= 100; seed++) {
    it(`conserves occupancy, Little's law and scaling for trace ${seed}`, () => {
      let state = seed;
      const random = () => { state = (state * 1664525 + 1013904223) >>> 0; return state / 2 ** 32; };
      const visits = Array.from({ length: 1 + seed }, (_, i): QueueVisit => {
        const arrivedAt = Math.floor(random() * 70000);
        const startedAt = arrivedAt + Math.floor(random() * 5000);
        return { id: String(i), station: 'work', pool: i % 2 ? 'a' : 'b', arrivedAt, startedAt, completedAt: startedAt + 1 + Math.floor(random() * 5000) };
      });
      const m = metric(visits);
      const residence = visits.reduce((s, v) => s + v.completedAt! - v.arrivedAt, 0) / 100000;
      expect(m.wip).toBeCloseTo(residence, 10);
      expect(m.littleLaw.lambdaW).toBeCloseTo(m.wip, 10);
      expect(m.littleLaw.flagged).toBe(false);
      expect(m.queueLength).toBeLessThanOrEqual(m.wip);
      const scaled = metric(visits.map(v => ({ ...v, arrivedAt: v.arrivedAt * 3, startedAt: v.startedAt! * 3, completedAt: v.completedAt! * 3 })), 300000, 300000);
      expect(scaled.wip).toBeCloseTo(m.wip, 10);
      expect(scaled.lambda * 3).toBeCloseTo(m.lambda, 10);
      expect(scaled.mu! * 3).toBeCloseTo(m.mu!, 10);
      expect(scaled.rho).toBeCloseTo(m.rho!, 10);
      const pools = estimateQueueStats(visits, 100000, [100000]).pools;
      expect(pools.reduce((s, p) => s + p.windows[0]!.wip, 0)).toBeCloseTo(m.wip, 10);
      expect(metric([...visits].reverse())).toEqual(m);
    });
  }

  it('reports known rates, wait and total occupancy', () => {
    const m = metric([{ id: 'x', station: 'work', pool: 'a', arrivedAt: 1000, startedAt: 3000, completedAt: 5000 }], 10000, 10000);
    expect(m.lambda).toBe(0.1);
    expect(m.mu).toBe(0.5);
    expect(m.rho).toBe(0.2);
    expect(m.wait).toBe(2);
    expect(m.queueLength).toBe(0.2);
    expect(m.wip).toBe(0.4);
    expect(m.littleLaw.flagged).toBe(false);
  });

  it('clips carry-in visits, unfinished service and half-open boundaries', () => {
    const visits: QueueVisit[] = [
      { id: 'old', station: 'work', pool: 'a', arrivedAt: 0, startedAt: 15000, completedAt: 25000 },
      { id: 'waiting', station: 'work', pool: 'a', arrivedAt: 10000 },
      { id: 'future', station: 'work', pool: 'a', arrivedAt: 20000 },
    ];
    const m = metric(visits, 20000, 10000);
    expect(m.arrivals).toBe(1);
    expect(m.wip).toBe(2);
    expect(m.queueLength).toBe(1.5);
    expect(m.currentQueueLength).toBe(1);
    expect(m.currentWip).toBe(2);
    expect(m.mu).toBeNull();
    expect(m.wait).toBeNull();
    expect(m.littleLaw.flagged).toBeNull();
  });

  it('flags nonstationary drift and deduplicates visit snapshots', () => {
    const v = { id: 'x', station: 'work', pool: 'a', arrivedAt: 0, startedAt: 1000, completedAt: 15000 };
    const m = metric([{ ...v, completedAt: undefined }, v], 20000, 10000);
    expect(m.departures).toBe(1);
    expect(m.wip).toBe(0.5);
    expect(m.littleLaw.flagged).toBe(true);
    expect(m.littleLaw.lambdaW).toBe(0);
  });

  it('keeps independent sliding windows and zero-duration service honest', () => {
    const visits = [{ id: 'x', station: 'work', pool: 'a', arrivedAt: 10000, startedAt: 10000, completedAt: 10000 }];
    const windows = estimateQueueStats(visits, 20000, [5000, 20000]).stations[0]!.windows;
    expect(windows[0]!.arrivals).toBe(0);
    expect(windows[1]!.arrivals).toBe(1);
    expect(windows[1]!.mu).toBeNull();
    expect(windows[1]!.littleLaw.drift).toBe(0);
  });

  it('rejects invalid timestamps and windows', () => {
    expect(isQueueVisit({ id: 'a', station: 'b', pool: 'c', arrivedAt: 5, completedAt: 6 })).toBe(false);
    expect(() => estimateQueueStats([], 0, [0])).toThrow();
    expect(() => estimateQueueStats([], NaN)).toThrow();
    expect(estimateQueueStats([], 0).stations).toEqual([]);
  });
});

it('CLI emits JSON and validates options before reading', async () => {
  const output = vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  expect(await cmdQueue(['stats', '--json', '--window', '60'])).toBe(0);
  expect(JSON.parse(output.mock.calls[0]![0]).schemaVersion).toBe(1);
  vi.mocked(readQueueVisits).mockClear();
  expect(await cmdQueue(['stats', '--window', '-1'])).toBe(2);
  expect(readQueueVisits).not.toHaveBeenCalled();
  vi.mocked(readQueueVisits).mockRejectedValueOnce(new Error('Cannot read queue journal'));
  expect(await cmdQueue(['stats', '--json'])).toBe(1);
});
