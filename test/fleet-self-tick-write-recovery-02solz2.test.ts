/**
 * RQ-PHX-SELFTICKFAILRECOVERY02SOLZ2 — a failed last-report write must not
 * strand the self-management pass. All three steps still run in order, the
 * exit code follows the steps alone, the real local-store lock is released,
 * and the next pass against the same runs dir acquires it and runs.
 */
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  runSelfTick,
  SELF_TICK_LOCK,
  type SelfTickReport,
  type SelfTickStepName,
  type SelfTickSteps,
} from '../src/core/fleet/self-tick.js';

const NOW_MS = Date.parse('2026-11-01T12:00:00Z');
const LOCK = () => join(runsDir, SELF_TICK_LOCK);

let runsDir: string;
beforeEach(() => { runsDir = mkdtempSync(join(tmpdir(), 'self-tick-write-recovery-')); });
afterEach(() => { rmSync(runsDir, { recursive: true, force: true }); });

/** Fake steps that record their call order and fail only when named. */
const recordingSteps = (order: SelfTickStepName[], failing: SelfTickStepName[] = []): SelfTickSteps => {
  const step = (name: SelfTickStepName) => async () => {
    order.push(name);
    return { exitCode: failing.includes(name) ? 1 : 0, output: JSON.stringify({ ok: name }) };
  };
  return {
    'reset-release': step('reset-release'),
    'lane-autohold': step('lane-autohold'),
    'planner-tick': step('planner-tick'),
  };
};

const throwingWrite = (writes: SelfTickReport[]) => (_dir: string, report: SelfTickReport): void => {
  writes.push(report);
  throw new Error('disk full');
};

describe('self-tick survives a failed last-report write', () => {
  it('runs all three steps in order and keeps the step failure as the exit code', async () => {
    const order: SelfTickStepName[] = [];
    const writes: SelfTickReport[] = [];
    const first = await runSelfTick({
      runsDir, steps: recordingSteps(order, ['lane-autohold']), now: () => NOW_MS,
      writeLast: throwingWrite(writes),
    });

    expect(order).toEqual(['reset-release', 'lane-autohold', 'planner-tick']);
    expect(writes).toHaveLength(1);
    expect(first.report.steps.map((s) => [s.step, s.state])).toEqual([
      ['reset-release', 'ok'], ['lane-autohold', 'failed'], ['planner-tick', 'ok'],
    ]);
    expect(first.exitCode).toBe(1);
    expect(existsSync(LOCK())).toBe(false);

    const orderAgain: SelfTickStepName[] = [];
    const second = await runSelfTick({
      runsDir, steps: recordingSteps(orderAgain), now: () => NOW_MS,
    });
    expect(second.lock).toBe('acquired');
    expect(second.report.state).toBe('ran');
    expect(second.exitCode).toBe(0);
    expect(orderAgain).toEqual(['reset-release', 'lane-autohold', 'planner-tick']);
    expect(existsSync(LOCK())).toBe(false);
  });

  it('a clean pass whose report write fails still exits 0 and a later pass runs', async () => {
    const order: SelfTickStepName[] = [];
    const writes: SelfTickReport[] = [];
    const first = await runSelfTick({
      runsDir, steps: recordingSteps(order), now: () => NOW_MS,
      writeLast: throwingWrite(writes),
    });

    expect(order).toEqual(['reset-release', 'lane-autohold', 'planner-tick']);
    expect(writes).toHaveLength(1);
    expect(first.report.steps.every((s) => s.state === 'ok')).toBe(true);
    expect(first.exitCode).toBe(0);
    expect(existsSync(LOCK())).toBe(false);

    const orderAgain: SelfTickStepName[] = [];
    const second = await runSelfTick({
      runsDir, steps: recordingSteps(orderAgain, ['planner-tick']), now: () => NOW_MS,
    });
    expect(second.lock).toBe('acquired');
    expect(second.report.state).toBe('ran');
    expect(orderAgain).toEqual(['reset-release', 'lane-autohold', 'planner-tick']);
    expect(second.exitCode).toBe(1);
    expect(existsSync(LOCK())).toBe(false);
  });
});
