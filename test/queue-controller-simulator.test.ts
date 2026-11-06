import { describe, expect, it } from 'vitest';
import {
  decideQueueCapacity, evaluateQueueController, simulateQueueController,
  type ControllerQueueEvent, type QueueSimulationOptions, type StationPressure,
} from '../src/core/queue/controller-simulator.js';
import { controllerRecording } from './fixtures/queue/controller-recording.js';

const options: QueueSimulationOptions = {
  stations: [{ station: 'PLAN', slots: 3 }, { station: 'READY', slots: 1 }],
  planningStation: 'PLAN', readyStation: 'READY',
};
const pressure = (overrides: Partial<StationPressure> = {}): StationPressure => ({
  station: 'PLAN', slots: 3, waiting: 0, running: 0, lambda: 1, mu: 2, ...overrides,
});
const ready = (overrides: Partial<StationPressure> = {}) => pressure({
  station: 'READY', slots: 1, waiting: 10, lambda: 1, mu: 0.1, ...overrides,
});
const event = (kind: ControllerQueueEvent['kind'], atMs: number, station = 'PLAN', jobId = 'a'): ControllerQueueEvent =>
  ({ jobId, kind, atMs, station });

function assertSchedule(events: readonly ControllerQueueEvent[], decisions: ReturnType<typeof simulateQueueController>['decisions']) {
  const slots = new Map(options.stations.map(s => [s.station, s.slots]));
  const active = new Map<string, number>();
  let decisionIndex = 0;
  for (const e of events) {
    // Decisions occur after completions/arrivals and before starts at this instant.
    if (e.kind === 'start') {
      while (decisions[decisionIndex] && decisions[decisionIndex].atMs <= e.atMs) {
        const d = decisions[decisionIndex++];
        expect(Object.values(d.slots).reduce((a, b) => a + b, 0)).toBe(4);
        for (const [name, n] of Object.entries(d.slots)) {
          expect(n).toBeGreaterThanOrEqual(1);
          slots.set(name, n);
        }
      }
      active.set(e.station, (active.get(e.station) ?? 0) + 1);
      expect(active.get(e.station)).toBeLessThanOrEqual(slots.get(e.station)!);
    } else if (e.kind === 'complete') active.set(e.station, active.get(e.station)! - 1);
  }
  expect([...active.values()].every(n => n === 0)).toBe(true);
}

describe('pure capacity decisions', () => {
  it('moves one idle slot to max-rho, preserving capacity', () => {
    const d = decideQueueCapacity([pressure(), ready()], 'READY');
    expect(d.rho).toEqual({ PLAN: 1 / 6, READY: 10 });
    expect(d.transfer).toEqual({ from: 'PLAN', to: 'READY' });
    expect(d.slots).toEqual({ PLAN: 2, READY: 2 });
    expect(d.planningThrottled).toBe(true);
  });
  it('uses capacity-adjusted rho and deterministic ties', () => {
    const rows = [pressure({ station: 'z', slots: 1, waiting: 1 }), pressure({ station: 'a', slots: 1, waiting: 1 }),
      ready({ waiting: 0, slots: 3, lambda: 0.1, mu: 2 })];
    expect(decideQueueCapacity(rows, 'READY').transfer).toEqual({ from: 'READY', to: 'a' });
    expect(decideQueueCapacity([...rows].reverse(), 'READY')).toEqual(decideQueueCapacity(rows, 'READY'));
  });
  it.each([2, 3])('does not preempt busy workers or cross donor floors (%s)', running => {
    expect(decideQueueCapacity([pressure({ running, minSlots: 3 }), ready()], 'READY').transfer).toBeNull();
    expect(decideQueueCapacity([pressure({ running: 3 }), ready()], 'READY').transfer).toBeNull();
  });
  it('keeps unknown rates unknown and never shifts without waiting demand', () => {
    expect(decideQueueCapacity([pressure({ mu: null }), ready()], 'READY').transfer).toBeNull();
    expect(decideQueueCapacity([pressure(), ready({ mu: null })], 'READY').rho.READY).toBeNull();
    expect(decideQueueCapacity([pressure(), ready({ waiting: 0 })], 'READY').transfer).toBeNull();
  });
  it('avoids transfers that would merely reverse the bottleneck', () => {
    const d = decideQueueCapacity([pressure({ slots: 2, lambda: 2, mu: 1 }), ready({ lambda: 1.5, mu: 1 })], 'READY');
    expect(d.transfer).toBeNull();
  });
  it.each([0, 4, 5])('throttles only strictly above twice READY slots (%s waiting)', waiting => {
    const d = decideQueueCapacity([pressure({ slots: 1 }), ready({ slots: 2, waiting })], 'READY');
    expect(d.planningThrottled).toBe(waiting > 4);
  });
  it.each([NaN, Infinity, -1, 1.5, 0])('rejects invalid slot count %s', slots => {
    expect(() => decideQueueCapacity([pressure({ slots }), ready()], 'READY')).toThrow();
  });
  it('rejects invalid pressure, duplicate stations, unknown READY and invalid floors', () => {
    for (const bad of [{ lambda: NaN }, { mu: 0 }, { mu: Infinity }, { waiting: -1 }, { running: 4 }, { minSlots: 0 }]) {
      expect(() => decideQueueCapacity([pressure(bad), ready()], 'READY')).toThrow();
    }
    expect(() => decideQueueCapacity([ready(), ready()], 'READY')).toThrow();
    expect(() => decideQueueCapacity([pressure()], 'missing')).toThrow();
    expect(() => decideQueueCapacity([pressure({ mu: Number.MIN_VALUE }), ready()], 'READY')).toThrow();
  });
});

describe('offline queue.v1 replay', () => {
  it('reduces full-cohort W on the checked-in recording without losing jobs', () => {
    const { baseline, controlled, reductionSeconds } = evaluateQueueController(controllerRecording, options);
    const recordedW = controllerRecording.filter(e => e.station === 'READY' && e.kind === 'complete')
      .reduce((sum, e) => sum + e.atMs - controllerRecording.find(a => a.jobId === e.jobId && a.kind === 'arrival')!.atMs, 0) / 13000;
    expect(baseline.W).toBeCloseTo(recordedW);
    expect(controlled.W!).toBeLessThan(baseline.W! * 0.7);
    expect(reductionSeconds).toBeCloseTo(baseline.W! - controlled.W!);
    for (const result of [baseline, controlled]) {
      expect(result.jobs).toBe(13);
      expect(result.completed).toBe(13);
      expect(result.WIP).toBe(0);
      expect(result.events).toHaveLength(controllerRecording.length);
      expect(result.stations.map(s => s.completed)).toEqual([13, 13]);
      assertSchedule(result.events, result.decisions);
      for (const completion of result.events.filter(e => e.kind === 'complete')) {
        const start = result.events.find(e => e.kind === 'start' && e.jobId === completion.jobId && e.station === completion.station)!;
        expect(completion.atMs - start.atMs).toBe(completion.station === 'PLAN' ? 1000 : 10000);
      }
    }
    expect(controlled.decisions.some(d => d.transfer !== null)).toBe(true);
    expect(controlled.decisions.some(d => d.planningThrottled)).toBe(true);
    expect(controlled.decisions.at(-1)!.planningThrottled).toBe(false);
  });
  it('retains throttle time in W and leaves already running planning jobs alone', () => {
    const fixed = { ...options, stations: options.stations.map(s => ({ ...s, minSlots: s.slots })) };
    const { controlled, baseline } = evaluateQueueController(controllerRecording, fixed);
    expect(controlled.decisions.some(d => d.planningThrottled)).toBe(true);
    expect(controlled.decisions.every(d => d.transfer === null)).toBe(true);
    expect(controlled.W).toBe(baseline.W); // READY is the same bottleneck, no hidden admission-clock reset.
    const finalJob = controlled.events.find(e => e.jobId === 'job-11' && e.kind === 'start' && e.station === 'PLAN')!;
    expect(finalJob.atMs).toBeGreaterThan(15000);
  });
  it('is deterministic and does not mutate deeply frozen inputs', () => {
    const events = Object.freeze(controllerRecording.map(e => Object.freeze({ ...e })));
    const config = Object.freeze({ ...options, stations: Object.freeze(options.stations.map(s => Object.freeze({ ...s }))) });
    expect(evaluateQueueController(events, config)).toEqual(evaluateQueueController(events, config));
  });
  it('handles empty logs, zero-duration work and idle gaps', () => {
    const empty = simulateQueueController([], options);
    expect(empty).toMatchObject({ W: null, wait: null, WIP: 0, completed: 0, makespanMs: 0 });
    expect(evaluateQueueController([], options).reductionSeconds).toBeNull();
    const zero = simulateQueueController([event('arrival', 10), event('start', 10), event('complete', 10)], options);
    expect(zero).toMatchObject({ W: 0, wait: 0, completed: 1 });
    const delayedZero = simulateQueueController([event('arrival', 1), event('start', 1e20), event('complete', 1e20)], options);
    expect(delayedZero).toMatchObject({ W: 0, wait: 0, completed: 1 });
    const gap = simulateQueueController([event('arrival', 100), event('start', 200), event('complete', 1200),
      event('arrival', 2200, 'READY'), event('start', 2200, 'READY'), event('complete', 3200, 'READY')], options);
    expect(gap.W).toBe(3); // 2s service + 1s handoff; observed queue wait is replaced.
  });
  it('learns rates only from simulated completed service, without future leakage', () => {
    const r = simulateQueueController(controllerRecording, options);
    expect(r.decisions[0].rho).toEqual({ PLAN: null, READY: null });
    expect(r.decisions.filter(d => d.atMs < 11000).every(d => d.transfer === null)).toBe(true);
  });
  it.each([
    [event('start', 0)],
    [event('arrival', 0)],
    [event('arrival', 0), event('complete', 1)],
    [event('arrival', 2), event('start', 1)],
    [event('arrival', NaN)],
    [event('arrival', 0, 'unknown')],
    [event('arrival', 0), event('arrival', 1)],
    [event('arrival', 0), event('start', 1), event('start', 2)],
    [event('arrival', 0), event('start', 1, 'READY')],
    [event('arrival', 0), event('start', 1), event('complete', 2), event('arrival', 3)],
    [{ ...event('arrival', 0), kind: 'unknown' }],
  ])('rejects malformed, overlapping or incomplete recordings %#', (...events) => {
    expect(() => simulateQueueController(events as ControllerQueueEvent[], options)).toThrow();
  });
  it('rejects missing or identical planning/READY configuration', () => {
    expect(() => simulateQueueController([], { ...options, planningStation: 'READY' })).toThrow();
    expect(() => simulateQueueController([], { ...options, readyStation: 'unknown' })).toThrow();
  });
});
