import { describe, expect, it, vi } from 'vitest';
import type { EngineId, WorkItem } from '../src/core/types.js';
import { runConcurrentDispatch, type ConcurrentDispatchCfg, type DispatchPlan } from '../src/core/fabric/concurrent-dispatch.js';

function deferred() {
  let resolve!: (value?: unknown) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<unknown>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function plan(backends: EngineId[], slots: Array<[EngineId, number]>): DispatchPlan {
  return {
    assignments: backends.map((backend, index) => ({ backend, item: {
      id: `drain-${index}`, title: 'Drain fixture', goal: 'Exercise injected dispatch',
      repo: '/tmp/drain-fixture', effort: 2, source: 'backlog', tags: [],
      createdAt: '2026-01-01T00:00:00.000Z',
    } satisfies WorkItem })),
    unassigned: [], slotsMap: new Map(slots),
  };
}

// A single event-loop turn lets promise continuations settle; no clock polling.
const turn = () => new Promise<void>(resolve => setImmediate(resolve));

for (const admitted of [false, true]) {
  const cfg = (): ConcurrentDispatchCfg => admitted ? { admission: {
    canStart: () => true, start: vi.fn(), finish: vi.fn(),
  } } : { maxSlotsPerBackend: 99 };

  describe(`completion drain (admission=${admitted})`, () => {
    it('refills a completed slot while a sibling remains pending and backends progress independently', async () => {
      const gates = Array.from({ length: 6 }, deferred);
      const dispatch = vi.fn((item: WorkItem) => gates[Number(item.id.split('-')[1])]!.promise);
      const running = runConcurrentDispatch(
        plan(['codex', 'codex', 'codex', 'codex', 'nim', 'nim'], [['codex', 2], ['nim', 1]]),
        dispatch, () => false, cfg(),
      );
      expect(dispatch.mock.calls.map(([item]) => item.id)).toEqual(['drain-0', 'drain-1', 'drain-4']);
      gates[1]!.resolve();
      gates[4]!.resolve();
      await turn();
      expect(dispatch.mock.calls.map(([item]) => item.id)).toEqual(['drain-0', 'drain-1', 'drain-4', 'drain-2', 'drain-5']);
      gates[2]!.resolve();
      await turn();
      expect(dispatch).toHaveBeenCalledTimes(6);
      for (const gate of gates) gate.resolve();
      const results = await running;
      expect(results).toHaveLength(6);
      expect(new Set(results.map(result => result.item.id)).size).toBe(6);
      expect(results.every(result => result.attempted && result.settled?.status === 'fulfilled')).toBe(true);
    });

    it.each([0, undefined, -1, NaN, Infinity, -Infinity, 1.5])('holds invalid measured slots %s explicitly', async slots => {
      const dispatch = vi.fn(async () => 'unexpected');
      const input = plan(['codex', 'codex'], slots === undefined ? [] : [['codex', slots]]);
      const options = cfg();
      const results = await runConcurrentDispatch(input, dispatch, () => false, options);
      expect(dispatch).not.toHaveBeenCalled();
      expect(results).toEqual(input.assignments.map(assignment => ({ ...assignment, attempted: false, settled: null })));
      if (options.admission) expect(options.admission.start).not.toHaveBeenCalled();
    });

    it('checks kill before every initial and queued launch', async () => {
      let killed = false;
      const gate = deferred();
      const dispatch = vi.fn(() => { killed = true; return gate.promise; });
      const running = runConcurrentDispatch(plan(['codex', 'codex', 'codex'], [['codex', 2]]), dispatch, () => killed, cfg());
      expect(dispatch).toHaveBeenCalledTimes(1);
      gate.resolve();
      const results = await running;
      expect(dispatch).toHaveBeenCalledTimes(1);
      expect(results.map(result => result.attempted)).toEqual([true, false, false]);
    });

    it('holds queued work when kill is activated while dispatch is pending', async () => {
      let killed = false;
      const gate = deferred();
      const dispatch = vi.fn(() => gate.promise);
      const running = runConcurrentDispatch(plan(['codex', 'codex'], [['codex', 1]]), dispatch, () => killed, cfg());
      expect(dispatch).toHaveBeenCalledTimes(1);
      killed = true;
      gate.resolve();
      const results = await running;
      expect(dispatch).toHaveBeenCalledTimes(1);
      expect(results.map(result => result.attempted)).toEqual([true, false]);
      expect(results[1]!.settled).toBeNull();
    });

    it('continues after synchronous throws and asynchronous rejections', async () => {
      const gate = deferred();
      const error = new Error('injected failure');
      const dispatch = vi.fn((item: WorkItem) => {
        if (item.id === 'drain-0') throw error;
        if (item.id === 'drain-1') return gate.promise;
        return Promise.resolve('done');
      });
      const options = cfg();
      const running = runConcurrentDispatch(plan(['codex', 'codex', 'codex'], [['codex', 1]]), dispatch, () => false, options);
      await turn();
      expect(dispatch).toHaveBeenCalledTimes(2);
      gate.reject(error);
      const results = await running;
      expect(results.map(result => result.settled?.status)).toEqual(['rejected', 'rejected', 'fulfilled']);
      expect(results.every(result => result.attempted)).toBe(true);
      if (options.admission) {
        expect(options.admission.start).toHaveBeenCalledTimes(3);
        expect(options.admission.finish).toHaveBeenCalledTimes(3);
      }
    });
  });
}
