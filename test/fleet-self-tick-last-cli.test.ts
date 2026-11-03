/**
 * RQ-PHX-SELFTICKLASTRUN02 — `ashlr fleet self-tick --last`: the run records
 * itself to queue/self-tick-last.json while holding the lock, a throwing
 * write changes nothing, a busy run records nothing, and --last prints the
 * recorded pass without running a step or taking the lock.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cmdFleetSelfTick } from '../src/cli/fleet-self-tick.js';
import {
  acquireLocalStoreLockWithOutcome, releaseLocalStoreLock,
} from '../src/core/fleet/local-store-lock.js';
import { runSelfTick, SELF_TICK_LOCK, type SelfTickSteps } from '../src/core/fleet/self-tick.js';
import { SELF_TICK_LAST, writeSelfTickLast } from '../src/core/fleet/self-tick-last.js';

const NOW_MS = Date.parse('2026-11-01T12:00:00Z');
const AT = new Date(NOW_MS).toISOString();
const LAST = () => join(runsDir, SELF_TICK_LAST);
const LOCK = () => join(runsDir, SELF_TICK_LOCK);

let runsDir: string;
beforeEach(() => { runsDir = mkdtempSync(join(tmpdir(), 'self-tick-last-cli-')); });
afterEach(() => { rmSync(runsDir, { recursive: true, force: true }); });

const steps = (fails: string[] = []): SelfTickSteps => ({
  'reset-release': async () => ({ exitCode: fails.includes('reset-release') ? 1 : 0, output: '{"ok":"reset-release"}' }),
  'lane-autohold': async () => ({ exitCode: fails.includes('lane-autohold') ? 1 : 0, output: '{"ok":"lane-autohold"}' }),
  'planner-tick': async () => ({ exitCode: fails.includes('planner-tick') ? 1 : 0, output: '{"ok":"planner-tick"}' }),
  'landed-sweep': async () => ({ exitCode: fails.includes('landed-sweep') ? 1 : 0, output: '{"ok":"landed-sweep"}' }),
});

describe('fleet self-tick --last', () => {
  it('a run with a failing step writes the record and still exits 1', async () => {
    const { exitCode } = await runSelfTick({ runsDir, steps: steps(['lane-autohold']), now: () => NOW_MS });
    expect(exitCode).toBe(1);
    const stored = JSON.parse(readFileSync(LAST(), 'utf8')) as {
      at: string; mode: string; state: string;
      steps: { step: string; state: string }[];
    };
    expect(stored).toMatchObject({ at: AT, mode: 'dry-run', state: 'ran' });
    expect(stored.steps.map((s) => [s.step, s.state])).toEqual([
      ['reset-release', 'ok'], ['lane-autohold', 'failed'], ['planner-tick', 'ok'], ['landed-sweep', 'ok'],
    ]);
  });

  it('a throwing writeLast leaves the exit code and the lock release intact', async () => {
    let writes = 0;
    const first = await runSelfTick({
      runsDir, steps: steps(['planner-tick']), now: () => NOW_MS,
      writeLast: () => { writes += 1; throw new Error('disk full'); },
    });
    expect(writes).toBe(1);
    expect(first.report.steps.every((s) => s.step !== 'planner-tick' || s.state === 'failed')).toBe(true);
    expect(first.exitCode).toBe(1); // the step's failure, not the write's
    expect(existsSync(LOCK())).toBe(false);
    // The lock was released: a second run acquires it, is not busy, writes.
    const second = await runSelfTick({ runsDir, steps: steps(), now: () => NOW_MS });
    expect(second.lock).toBe('acquired');
    expect(second.report.state).toBe('ran');
    expect(second.exitCode).toBe(0);
    expect(existsSync(LAST())).toBe(true);
  });

  it('a busy run writes nothing', async () => {
    const held = acquireLocalStoreLockWithOutcome(LOCK(), 0, { anchorPath: runsDir, exactPrivateStorage: true });
    expect(held.state).toBe('acquired');
    try {
      let writes = 0;
      const { report, exitCode } = await runSelfTick({
        runsDir, steps: steps(), now: () => NOW_MS, writeLast: () => { writes += 1; },
      });
      expect(report.state).toBe('busy');
      expect(exitCode).toBe(0);
      expect(writes).toBe(0);
      expect(existsSync(LAST())).toBe(false);
    } finally {
      releaseLocalStoreLock(held.state === 'acquired' ? held.lock : null);
    }
  });

  it('--last --json prints the recorded view and runs no step seam', async () => {
    writeSelfTickLast(runsDir, {
      v: 1, at: AT, mode: 'apply', state: 'ran',
      steps: [
        { step: 'reset-release', state: 'ok', exitCode: 0, report: {} },
        { step: 'lane-autohold', state: 'failed', exitCode: 1, report: {} },
        { step: 'planner-tick', state: 'ok', exitCode: 0, report: {} },
      ],
    });
    let stepCalls = 0;
    const spy = async () => { stepCalls += 1; return { exitCode: 0, output: '{}' }; };
    const out: string[] = [], err: string[] = [];
    const code = await cmdFleetSelfTick(['--last', '--json', '--runs-dir', runsDir], {
      now: () => NOW_MS + 300_000,
      output: (t) => out.push(t), error: (t) => err.push(t),
      steps: { 'reset-release': spy, 'lane-autohold': spy, 'planner-tick': spy, 'landed-sweep': spy },
      acquireLock: () => { throw new Error('--last must not take the lock'); },
    });
    expect(code).toBe(0);
    expect(stepCalls).toBe(0);
    expect(err).toEqual([]);
    expect(JSON.parse(out[0]!)).toEqual({
      state: 'ok', at: AT, mode: 'apply', ranState: 'ran',
      ageSeconds: 300, failedSteps: ['lane-autohold'],
    });
  });

  it('--last prints the human line, and "no recorded run" when empty', async () => {
    writeSelfTickLast(runsDir, {
      v: 1, at: AT, mode: 'dry-run', state: 'ran',
      steps: [{ step: 'reset-release', state: 'ok', exitCode: 0, report: {} }],
    });
    const out: string[] = [];
    const code = await cmdFleetSelfTick(['--last', '--runs-dir', runsDir], {
      now: () => NOW_MS + 600_000, output: (t) => out.push(t), error: () => {},
    });
    expect(code).toBe(0);
    expect(out[0]).toBe(`fleet self-tick: last run ${AT} (10m ago) dry-run failed=none`);

    const empty = mkdtempSync(join(tmpdir(), 'self-tick-last-empty-'));
    try {
      const out2: string[] = [];
      const code2 = await cmdFleetSelfTick(['--last', '--runs-dir', empty], {
        output: (t) => out2.push(t), error: () => {},
      });
      expect(code2).toBe(0);
      expect(out2).toEqual(['no recorded run']);
      const out3: string[] = [];
      const code3 = await cmdFleetSelfTick(['--last', '--json', '--runs-dir', empty], {
        output: (t) => out3.push(t), error: () => {},
      });
      expect(code3).toBe(0);
      expect(out3).toEqual(['null']);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  it('--last --apply exits 2 and records nothing', async () => {
    const out: string[] = [], err: string[] = [];
    const code = await cmdFleetSelfTick(['--last', '--apply', '--runs-dir', runsDir], {
      output: (t) => out.push(t), error: (t) => err.push(t),
    });
    expect(code).toBe(2);
    expect(err.join('\n')).toContain('Usage: ashlr fleet self-tick');
    expect(existsSync(LAST())).toBe(false);
  });
});
