import { describe, expect, it } from 'vitest';
import { replayQueueMetrics, type QueueEvent } from '../src/core/observability/queue-metrics.js';
import { littleLawLog } from './fixtures/queue/little-law.js';

const window = { startMs: 0, endMs: 20_000 };

describe('queue.v1 event replay', () => {
  it('measures lambda, mu, rho, L, W and WIP from a hand-calculated log', () => {
    const result = replayQueueMetrics(littleLawLog, window);
    expect(result.schema).toBe('queue.v1');
    expect(result.lambda).toBeCloseTo(3 / 20, 12);
    expect(result.mu).toBeCloseTo(3 / 12, 12);
    expect(result.rho).toBeCloseTo(0.6, 12);
    expect(result.L).toBeCloseTo(18 / 20, 12);
    expect(result.W).toBe(6);
    expect(result.WIP).toBe(0);
  });

  it("satisfies Little's law within five percent using independent occupancy and latency", () => {
    const { L, lambda, W } = replayQueueMetrics(littleLawLog, window);
    expect(W).not.toBeNull();
    if (W === null) throw new Error('Fixture must have completed jobs');
    expect(L).toBeGreaterThan(0);
    expect(Math.abs(L - lambda * W) / L).toBeLessThanOrEqual(0.05);
  });

  it('replays deterministically without mutating the fixture', () => {
    const before = structuredClone(littleLawLog);
    expect(replayQueueMetrics(littleLawLog, window)).toEqual(replayQueueMetrics(littleLawLog, window));
    expect(littleLawLog).toEqual(before);
  });

  it('preserves units under timestamp translation and time scaling', () => {
    const translated = littleLawLog.map(event => ({ ...event, atMs: event.atMs + 100_000 }));
    expect(replayQueueMetrics(translated, { startMs: 100_000, endMs: 120_000 }))
      .toEqual(replayQueueMetrics(littleLawLog, window));
    const scaled = replayQueueMetrics(littleLawLog.map(event => ({ ...event, atMs: event.atMs * 2 })),
      { startMs: 0, endMs: 40_000 });
    expect(scaled).toEqual({ schema: 'queue.v1', lambda: 0.075, mu: 0.125, rho: 0.6, L: 0.9, W: 12, WIP: 0 });
  });

  it('reports an empty queue without NaN or invented service evidence', () => {
    expect(replayQueueMetrics([], window)).toEqual({
      schema: 'queue.v1', lambda: 0, mu: null, rho: null, L: 0, W: null, WIP: 0,
    });
  });

  it('counts waiting work without inventing a service rate or latency', () => {
    expect(replayQueueMetrics([littleLawLog[0]], window)).toEqual({
      schema: 'queue.v1', lambda: 0.05, mu: null, rho: null, L: 0.95, W: null, WIP: 1,
    });
  });

  it('includes queued and running unfinished jobs through the window end', () => {
    const result = replayQueueMetrics(littleLawLog.slice(0, 6), window);
    // A contributes 4s, B contributes 18s, C contributes 14s.
    expect(result.L).toBe(36 / 20);
    expect(result.WIP).toBe(2);
    expect(result.W).toBe(4);
    expect(result.mu).toBeCloseTo(1 / 19, 12);
    expect(result.rho).toBeCloseTo(2.85, 12);
  });

  it('handles boundary events and zero-duration service in log order', () => {
    expect(replayQueueMetrics([
      { jobId: 'a', kind: 'arrival', atMs: 0 },
      { jobId: 'a', kind: 'start', atMs: 0 },
      { jobId: 'a', kind: 'complete', atMs: 20_000 },
      { jobId: 'b', kind: 'arrival', atMs: 20_000 },
      { jobId: 'b', kind: 'start', atMs: 20_000 },
      { jobId: 'b', kind: 'complete', atMs: 20_000 },
    ], window)).toEqual({ schema: 'queue.v1', lambda: 0.1, mu: 0.1, rho: 1, L: 1, W: 10, WIP: 0 });
    expect(replayQueueMetrics(littleLawLog.slice(0, 2).map(event => ({ ...event, atMs: 20_000 })), window).mu)
      .toBeNull();
  });

  it.each([0, -1, NaN, Infinity])('rejects an invalid window end %s', endMs => {
    expect(() => replayQueueMetrics([], { startMs: 0, endMs })).toThrow(/window/);
  });

  it.each([-1, 20_001, NaN, Infinity])('rejects invalid event time %s', atMs => {
    expect(() => replayQueueMetrics([{ jobId: 'a', kind: 'arrival', atMs }], window)).toThrow(/chronological/);
  });

  it('rejects out-of-order logs rather than silently sorting them', () => {
    expect(() => replayQueueMetrics([
      littleLawLog[0], { ...littleLawLog[1], atMs: 500 },
    ], window)).toThrow(/chronological/);
  });

  const invalidLogs: QueueEvent[][] = [
    [{ jobId: 'a', kind: 'start', atMs: 0 }],
    [{ jobId: 'a', kind: 'complete', atMs: 0 }],
    [littleLawLog[0], littleLawLog[0]],
    [...littleLawLog, { jobId: 'a', kind: 'arrival', atMs: 14_000 }],
    [littleLawLog[0], littleLawLog[1], littleLawLog[1]],
    [...littleLawLog.slice(0, 3), { jobId: 'b', kind: 'start', atMs: 3_000 }],
    [...littleLawLog.slice(0, 3), { jobId: 'b', kind: 'complete', atMs: 3_000 }],
    [{ jobId: '', kind: 'arrival', atMs: 0 }],
  ];
  it.each(invalidLogs.map(events => [events]))('rejects invalid job lifecycles %#', events => {
    expect(() => replayQueueMetrics(events, window)).toThrow();
  });
});
