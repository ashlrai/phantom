import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cmdFleetSelfTick } from '../src/cli/fleet-self-tick.js';
import { writeSelfTickLast } from '../src/core/fleet/self-tick-last.js';
import { SELF_TICK_STEP_ORDER, type SelfTickReport } from '../src/core/fleet/self-tick.js';
import { readSelfTickStatus, selfTickStatusLines } from '../src/core/fleet/self-tick-status.js';

let runs = '';
beforeEach(() => { runs = mkdtempSync(join(tmpdir(), 'self-tick-status-')); });
afterEach(() => { rmSync(runs, { recursive: true, force: true }); });

const AT = '2026-11-20T10:00:00.000Z';
const NOW = Date.parse('2026-11-20T10:30:00.000Z');

function record(planner: unknown, mode: 'apply' | 'dry-run' = 'apply'): void {
  const report: SelfTickReport = {
    at: AT, mode, state: 'ran',
    steps: SELF_TICK_STEP_ORDER.map(step => ({ step, state: 'ok', exitCode: 0, report: step === 'planner-tick' ? planner : {} })),
  } as SelfTickReport;
  writeSelfTickLast(runs, report);
}

describe('phm fleet self-tick --status', () => {
  it('says so when no run is recorded', () => {
    const s = readSelfTickStatus(runs, NOW);
    expect(s).toMatchObject({ schema: 'fleet.self-tick-status.v1', state: 'none', line: 'no self-tick run recorded' });
    expect(selfTickStatusLines(s)).toEqual(['no self-tick run recorded']);
  });

  it('reports when it ran and what each hook produced', () => {
    record({
      autofill: { runs: [{ applied: 2 }, { applied: 1 }], gaps: { candidates: 5, queued: 2, skipped: 3, unknown: false } },
      worktreeReap: { state: 'ran', last: { removed: 7 } },
    });
    const s = readSelfTickStatus(runs, NOW);
    expect(s).toMatchObject({ state: 'recorded', at: AT, ageSeconds: 1800, mode: 'apply' });
    if (s.state !== 'recorded') throw new Error('expected a record');
    expect(s.hooks).toEqual([
      { hook: 'autofill', state: 'ran', items: 3, count: null, note: null },
      { hook: 'gaps', state: 'ran', items: 2, count: 5, note: null },
      { hook: 'reap', state: 'ran', items: 7, count: null, note: null },
      { hook: 'stranded-requeue', state: 'not-recorded', items: null, count: null, note: null },
    ]);
    expect(selfTickStatusLines(s)).toEqual([
      `self-tick last ran ${AT} (30 min ago, apply)`, '  autofill 3 items', '  gaps: 5 candidates, 2 queued', '  reap 7 items', '  stranded-requeue not recorded',
    ]);
  });

  it('a gap hook that ran and found no candidates says zero candidates, and JSON carries count 0', () => {
    record({ autofill: { runs: [], reason: 'No lane is starved.', gaps: { candidates: 0, queued: 0, skipped: 0, unknown: false } } });
    const s = readSelfTickStatus(runs, NOW);
    if (s.state !== 'recorded') throw new Error('expected a record');
    expect(s.hooks[1]).toEqual({ hook: 'gaps', state: 'ran', items: 0, count: 0, note: null });
    expect(selfTickStatusLines(s)[2]).toBe('  gaps: 0 candidates (no Remaining gaps found)');
    expect(JSON.parse(JSON.stringify(s)).hooks[1]).toMatchObject({ count: 0 });
  });

  it('a gap hook that did not run is skipped with its reason, never a zero', () => {
    record({ autofill: { reason: 'custom-runs-dir-no-autofill' }, worktreeReap: { state: 'skipped', reason: 'below the warn line' } });
    const s = readSelfTickStatus(runs, NOW);
    if (s.state !== 'recorded') throw new Error('expected a record');
    expect(s.hooks.map(h => [h.hook, h.state, h.items, h.count])).toEqual([
      ['autofill', 'skipped', null, null], ['gaps', 'skipped', null, null], ['reap', 'skipped', null, null], ['stranded-requeue', 'not-recorded', null, null],
    ]);
    expect(selfTickStatusLines(s)[2]).toBe('  gaps: skipped (custom-runs-dir-no-autofill)');
    expect(selfTickStatusLines(s)[3]).toBe('  reap skipped (below the warn line)');
  });

  it('a record with autofill but no gap numbers reads the gap hook as skipped for the reason given', () => {
    record({ autofill: { runs: [], reason: 'No lane is starved.', gaps: null } });
    const s = readSelfTickStatus(runs, NOW);
    if (s.state !== 'recorded') throw new Error('expected a record');
    expect(selfTickStatusLines(s)[2]).toBe('  gaps: skipped (no gap note in this report (older build))');
  });

  it('a record without hook numbers reads not recorded', () => {
    record({});
    const s = readSelfTickStatus(runs, NOW);
    if (s.state !== 'recorded') throw new Error('expected a record');
    expect(s.hooks.every(h => h.state === 'not-recorded' && h.items === null)).toBe(true);
  });

  it('the CLI prints plain words and typed JSON, reads only, and refuses --apply', async () => {
    record({ autofill: { runs: [], reason: 'No lane is starved.' } });
    const out: string[] = [];
    const deps = { output: (t: string) => { out.push(t); }, error: () => {}, now: () => NOW };
    expect(await cmdFleetSelfTick(['--status', '--runs-dir', runs], deps)).toBe(0);
    expect(out[0]).toContain('self-tick last ran');
    out.length = 0;
    expect(await cmdFleetSelfTick(['--status', '--json', '--runs-dir', runs], deps)).toBe(0);
    expect(JSON.parse(out[0]!)).toMatchObject({ schema: 'fleet.self-tick-status.v1', state: 'recorded' });
    expect(await cmdFleetSelfTick(['--status', '--apply', '--runs-dir', runs], deps)).toBe(2);
    expect(await cmdFleetSelfTick(['--status', '--last', '--runs-dir', runs], deps)).toBe(2);
  });
});
