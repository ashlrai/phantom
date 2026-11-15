import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runRoutinesCli } from '../src/cli/routines.js';
import { candidates, decodeConfig, history, run, scheduleMatches, type Config } from '../src/core/routines/scheduler.js';
import { importRoutines, readRoutines, rebalanceSavedRoutines, routineAdapter } from '../src/core/automations/routines.js';
import { isolateAshlrHome } from './helpers/automations-fakes.js';
import { ashlrHome } from '../src/core/cloud/store.js';

let restore: () => void;
beforeEach(() => { restore = isolateAshlrHome(); });
afterEach(() => restore());

const scheduled: Config = {
  routines: [{ id: 'morning-digest', schedule: '* * * * *', prompt: 'Summarize overnight work', capabilities: ['research'], tier: 'frontier', output: 'digest.md' }],
  executors: [
    { id: 'codex', kind: 'codex', capabilities: ['research'], tier: 'frontier', cost: 1, dailyLimit: 5 },
    { id: 'claude', kind: 'claude', capabilities: ['research'], tier: 'frontier', cost: 2, dailyLimit: 5 },
  ],
};

describe('scheduled routines dispatcher (RQ-PHX-RECUTCOREOLDC219)', () => {
  it('lists, ticks and reports real YAML definitions through the CLI', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'recut219-'));
    try {
      const file = join(dir, 'routines.yaml');
      await writeFile(file, [
        'executors:',
        '  - { id: codex, kind: codex, tier: frontier, capabilities: [research], cost: 1, dailyLimit: 5 }',
        'routines:',
        '  - { id: morning-digest, schedule: "@hourly", prompt: "Summarize", capabilities: [research], tier: frontier, output: digest.md }',
        '',
      ].join('\n'));
      const lines: string[] = [];
      expect(await runRoutinesCli(['list', '--file', file], s => lines.push(s))).toBe(0);
      expect(lines[0]).toContain('morning-digest');
      expect(await runRoutinesCli(['status', '--file', file], s => lines.push(s))).toBe(0);
      expect(lines.at(-1)).toContain('| morning-digest |');
      expect(await readFile(join(ashlrHome(), 'routines', 'STATUS.md'), 'utf8')).toContain('morning-digest');
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it('rejects bad usage and unknown verbs with exit 2', async () => {
    const errs: string[] = [];
    expect(await runRoutinesCli(['bogus'], () => {}, s => errs.push(s))).toBe(2);
    expect(await runRoutinesCli(['tick', 'extra'], () => {}, s => errs.push(s))).toBe(2);
    expect(errs.some(line => line.includes('Usage'))).toBe(true);
  });

  it('run <id> exercises the scheduler failover path end to end', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'recut219-run-'));
    try {
      const call = vi.fn(async (executor: Config['executors'][number]) => {
        if (executor.kind === 'codex') throw new Error('usage exhausted');
        return { output: 'digest body' };
      });
      const attempts = await run(scheduled, 'morning-digest', dir, call, new Date('2026-11-10T09:00:00Z'));
      expect(attempts.map(a => a.outcome)).toEqual(['quota', 'success']);
      expect(await readFile(join(dir, 'output', 'digest.md'), 'utf8')).toBe('digest body');
      expect(await history(dir)).toHaveLength(2);
      expect(candidates(scheduled, scheduled.routines[0]!, await history(dir), new Date('2026-11-10T09:00:00Z')).map(e => e.id)).toEqual(['claude']);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it('cron matching accepts lists, ranges, steps and aliases in UTC', () => {
    const at = new Date('2026-11-10T09:00:00Z'); // Tuesday 09:00 UTC.
    expect(scheduleMatches('0 9 * * *', at)).toBe(true);
    expect(scheduleMatches('*/30 8-10 * * 2', at)).toBe(true);
    expect(scheduleMatches('@daily', at)).toBe(false);
    expect(() => scheduleMatches('bad', at)).toThrow();
    expect(() => decodeConfig('routines: []')).toThrow();
  });
});

describe('portable placement registry dispatcher (RQ-PHX-RECUTCOREOLDC219)', () => {
  const row = { id: 'standup', schedule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0', prompt: 'Standup notes.', capabilities: ['report'], last_ledger_state: null };

  it('export/import/rebalance round-trip through runRoutinesCli and private storage', async () => {
    const out: string[] = [];
    await importRoutines({ schema: 'phantom-routines.v1', routines: [row] });
    expect(await runRoutinesCli(['export'], s => out.push(s))).toBe(0);
    expect(JSON.parse(out.at(-1)!)).toEqual({ schema: 'phantom-routines.v1', routines: await readRoutines() });
    const at = new Date().toISOString();
    const expires = new Date(Date.parse(at) + 60_000).toISOString();
    await writeFile(join(ashlrHome(), 'routines', 'providers.json'),
      JSON.stringify({ local: { health: 'ready', quota_state: 'available', reset_at: null, observed_at: at, expires_at: expires, cost: 0, capabilities: ['report'] } }));
    expect(await runRoutinesCli(['rebalance'], s => out.push(s))).toBe(0);
    expect((await readRoutines())[0]!.last_ledger_state!.provider).toBe('local');
  });

  it('injected adapters drive rebalanceSavedRoutines without on-disk provider evidence', async () => {
    const at = new Date().toISOString();
    const probe = { health: 'ready' as const, quota_state: 'available' as const, reset_at: null, observed_at: at, expires_at: new Date(Date.parse(at) + 60_000).toISOString(), cost: 3, capabilities: ['report'] };
    await importRoutines({ schema: 'phantom-routines.v1', routines: [row] });
    const placed = await rebalanceSavedRoutines([routineAdapter('devin', async () => probe)], new Date(at));
    expect(placed[0]!.last_ledger_state).toEqual({ provider: 'devin', at, reason: 'placed' });
  });
});
