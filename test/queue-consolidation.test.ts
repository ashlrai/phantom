import { describe, expect, it } from 'vitest';
import { replayQueueMetrics } from '../src/core/observability/queue-metrics.js';
import { queueReportFromText } from '../src/core/queue-metrics.js';
import { simulateQueueController, type ControllerQueueEvent } from '../src/core/queue/controller-simulator.js';

// One complete cohort, replayed through each offline measurement contract.
const events: ControllerQueueEvent[] = [
  { jobId: 'a', station: 'READY', kind: 'arrival', atMs: 0 },
  { jobId: 'a', station: 'READY', kind: 'start', atMs: 0 },
  { jobId: 'b', station: 'READY', kind: 'arrival', atMs: 1000 },
  { jobId: 'a', station: 'READY', kind: 'complete', atMs: 2000 },
  { jobId: 'b', station: 'READY', kind: 'start', atMs: 2000 },
  { jobId: 'b', station: 'READY', kind: 'complete', atMs: 4000 },
];
const iso = (ms: number) => new Date(Date.UTC(2026, 9, 26) + ms).toISOString();

describe('consolidated queue measurements', () => {
  it('agrees on rates and residence time after converting hours to seconds', () => {
    const metrics = replayQueueMetrics(events, { startMs: 0, endMs: 4000 });
    const report = queueReportFromText(JSON.stringify({ start: iso(0), end: iso(4000), events:
      ['a', 'b'].map(jobId => {
        const visit = events.filter(e => e.jobId === jobId);
        return { station: 'READY', arrivedAt: iso(visit[0].atMs),
          startedAt: iso(visit[1].atMs), completedAt: iso(visit[2].atMs) };
      }),
    }));
    const station = report.stations[0];
    expect(station.lambda / 3600).toBeCloseTo(metrics.lambda);
    expect(station.mu! / 3600).toBeCloseTo(metrics.mu!);
    expect(station.rho).toBeCloseTo(metrics.rho!);
    expect(station.W! * 3600).toBeCloseTo(metrics.W!);
    expect(metrics.L).toBeCloseTo(metrics.lambda * metrics.W!);
  });

  it('replays simulator output through single-server metrics without changing the cohort', () => {
    const simulated = simulateQueueController(events, {
      stations: [{ station: 'PLAN', slots: 1 }, { station: 'READY', slots: 1 }],
      planningStation: 'PLAN', readyStation: 'READY', controller: false,
    });
    const metrics = replayQueueMetrics(simulated.events, { startMs: 0, endMs: simulated.makespanMs });
    expect(simulated.events).toEqual(events);
    expect(metrics.W).toBe(simulated.W);
    expect(metrics.WIP).toBe(simulated.WIP);
    expect(simulated.completed).toBe(2);
  });
});
