import { hooksFromPlannerReport } from '../src/core/fleet/self-tick-hooks.js';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cmdFleetSelfTick } from '../src/cli/fleet-self-tick.js';
import { SELF_TICK_HISTORY, SELF_TICK_HISTORY_KEEP_LINES, SELF_TICK_LAST } from '../src/core/fleet/self-tick-last.js';
import { SELF_TICK_STEP_ORDER, runSelfTick, type SelfTickSteps } from '../src/core/fleet/self-tick.js';
import { readSelfTickStatus } from '../src/core/fleet/self-tick-status.js';

let runs = '';
beforeEach(() => { runs = mkdtempSync(join(tmpdir(), 'self-tick-record-')); });
afterEach(() => { rmSync(runs, { recursive: true, force: true }); });

const NOW = Date.parse('2026-11-20T10:00:00.000Z');
const planner = JSON.stringify({
  autofill: { runs: [{ applied: 2, drafted: 3 }], gaps: { candidates: 4, queued: 1, skipped: 3, unknown: false } },
  worktreeReap: { state: 'ran', last: { removed: 5 } },
});
const fakeSteps = (overrides: Partial<SelfTickSteps> = {}): SelfTickSteps => {
  const steps = Object.fromEntries(SELF_TICK_STEP_ORDER.map(s => [s, async () => ({ exitCode: 0, output: s === 'planner-tick' ? planner : '{}' })]));
  return { ...steps, ...overrides } as SelfTickSteps;
};
const readJson = (rel: string): any => JSON.parse(readFileSync(join(runs, rel), 'utf8'));
const lines = (): any[] => readFileSync(join(runs, SELF_TICK_HISTORY), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));

describe('self-tick run record', () => {
  it('a gap note in the report is the skip reason', () => {
    const hooks = hooksFromPlannerReport({ autofill: { runs: [], gaps: null, gapsNote: 'ran 4 min ago (waits 10 min)' } });
    expect(hooks[1]).toEqual({ hook: 'gaps', state: 'skipped', items: null, count: null, note: 'ran 4 min ago (waits 10 min)' });
  });

  it('an apply run writes the last record and one history line with hook counts', async () => {
    await runSelfTick({ apply: true, runsDir: runs, now: () => NOW, steps: fakeSteps() });
    const last = readJson(SELF_TICK_LAST);
    expect(last).toMatchObject({ schema: 'fleet.self-tick-record.v1', mode: 'apply', state: 'ran', startedAt: '2026-11-20T10:00:00.000Z', finishedAt: '2026-11-20T10:00:00.000Z', failedSteps: [] });
    expect(last.hooks).toEqual([
      { hook: 'autofill', state: 'ran', items: 2, count: null, note: null },
      { hook: 'gaps', state: 'ran', items: 1, count: 4, note: null },
      { hook: 'reap', state: 'ran', items: 5, count: null, note: null },
      { hook: 'stranded-requeue', state: 'not-recorded', items: null, count: null, note: null },
    ]);
    expect(lines()).toHaveLength(1);
    expect(lines()[0]).toMatchObject({ schema: 'fleet.self-tick-record.v1', mode: 'apply' });
    expect(readSelfTickStatus(runs, NOW).line).toContain('autofill 2 items, gaps: 4 candidates, 1 queued, reap 5 items');
  });

  it('does not invent a gap candidate count from a queued-only legacy report', () => {
    const hooks = hooksFromPlannerReport({ autofill: { runs: [], gaps: { queued: 2 } } });
    expect(hooks[1]).toEqual({ hook: 'gaps', state: 'skipped', items: null, count: null, note: 'no gap note in this report (older build)' });
  });

  it('a dry run is marked dry-run and its hooks read skipped, never zero', async () => {
    await runSelfTick({ runsDir: runs, now: () => NOW, steps: fakeSteps() });
    const last = readJson(SELF_TICK_LAST);
    expect(last.mode).toBe('dry-run');
    expect(last.hooks.map((h: any) => [h.hook, h.state, h.items])).toEqual([['autofill', 'skipped', null], ['gaps', 'skipped', null], ['reap', 'ran', 5], ['stranded-requeue', 'not-recorded', null]]);
    expect(last.hooks[0].note).toBe('dry run: would draft 3 jobs, queued none');
  });

  it('a step that throws still leaves the record, naming the error', async () => {
    const out = await runSelfTick({ apply: true, runsDir: runs, now: () => NOW, steps: fakeSteps({ 'inbox-acks': async () => { throw new Error('mailbox is unreachable'); } }) });
    expect(out.exitCode).toBe(1);
    const last = readJson(SELF_TICK_LAST);
    expect(last.failedSteps).toEqual([{ step: 'inbox-acks', error: 'mailbox is unreachable' }]);
    expect(lines()[0].failedSteps).toEqual(last.failedSteps);
    expect(readSelfTickStatus(runs, NOW)).toMatchObject({ state: 'recorded', failedSteps: ['inbox-acks'] });
  });

  it('a hook that throws is named in the record and the tick still finishes', async () => {
    const code = await cmdFleetSelfTick(['--apply', '--json', '--runs-dir', runs], {
      now: () => NOW, home: runs, output: () => {}, error: () => {},
      steps: fakeSteps({ 'planner-tick': async () => ({ exitCode: 0, output: JSON.stringify({ autofill: { reason: 'autofill failed', error: 'lane read blew up' }, worktreeReap: { state: 'failed', error: 'disk went away' } }) }) }),
    });
    expect(code).toBe(0);
    const last = readJson(SELF_TICK_LAST);
    expect(last.hooks.map((h: any) => [h.hook, h.state, h.note])).toEqual([
      ['autofill', 'failed', 'lane read blew up'],
      ['gaps', 'skipped', 'autofill failed before the gap harvest'],
      ['reap', 'failed', 'disk went away'],
      ['stranded-requeue', 'not-recorded', null],
    ]);
  });

  it('a busy run joins the history but leaves the last record alone', async () => {
    await runSelfTick({ apply: true, runsDir: runs, now: () => NOW, steps: fakeSteps() });
    await runSelfTick({ apply: true, runsDir: runs, now: () => NOW + 1000, steps: fakeSteps(), acquireLock: () => ({ state: 'contended' } as never) });
    expect(readJson(SELF_TICK_LAST).state).toBe('ran');
    expect(lines().map(l => l.state)).toEqual(['ran', 'busy']);
    expect(lines()[1].hooks).toEqual([]);
  });

  it('keeps only the newest 500 history lines', async () => {
    mkdirSync(join(runs, 'queue'), { recursive: true });
    const old = Array.from({ length: SELF_TICK_HISTORY_KEEP_LINES + 20 }, (_, i) => JSON.stringify({ n: i }));
    writeFileSync(join(runs, SELF_TICK_HISTORY), `${old.join('\n')}\n`);
    await runSelfTick({ apply: true, runsDir: runs, now: () => NOW, steps: fakeSteps() });
    const all = lines();
    expect(all).toHaveLength(SELF_TICK_HISTORY_KEEP_LINES);
    expect(all[0]).toEqual({ n: 21 });
    expect(all.at(-1).schema).toBe('fleet.self-tick-record.v1');
    expect(existsSync(join(runs, `${SELF_TICK_HISTORY}.tmp`))).toBe(false);
  });
});

describe('PHM_SELF_TICK_APPLY', () => {
  const run = async (args: string[], env: Record<string, string>, isTty: boolean): Promise<string> => {
    const out: string[] = [];
    await cmdFleetSelfTick([...args, '--json', '--runs-dir', runs], { now: () => NOW, home: runs, env, isTty, output: t => out.push(t), error: () => {}, steps: fakeSteps() });
    return JSON.parse(out[0]!).mode;
  };
  it('applies without a terminal when set, and stays a dry run at a terminal or when unset', async () => {
    expect(await run([], {}, false)).toBe('dry-run');
    expect(await run([], { PHM_SELF_TICK_APPLY: '1' }, true)).toBe('dry-run');
    expect(await run([], { PHM_SELF_TICK_APPLY: '1' }, false)).toBe('apply');
    expect(await run(['--apply'], {}, true)).toBe('apply');
  });
  it('--status still works with the variable set', async () => {
    const out: string[] = [];
    expect(await cmdFleetSelfTick(['--status', '--runs-dir', runs], { now: () => NOW, home: runs, env: { PHM_SELF_TICK_APPLY: '1' }, isTty: false, output: t => out.push(t) })).toBe(0);
    expect(out[0]).toBe('no self-tick run recorded');
  });
});
