import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as cli from '../src/cli/fleet-empty-why.js';
import * as why from '../src/core/fleet/empty-why-classify.js';
import { classifyEmpty, classifyEmptyLog, readEmptyJobs } from '../src/core/fleet/empty-jobs.js';

let dir: string; let runs: string; let wt: string;
const NOW = Date.parse('2026-11-12T00:00:00Z');
const HOUR = 3_600_000;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'empty-reasons-orig-'));
  runs = join(dir, 'runs'); wt = join(dir, 'wt');
  await mkdir(join(runs, 'metrics'), { recursive: true });
  await mkdir(wt, { recursive: true });
});
afterEach(async () => { vi.restoreAllMocks(); await rm(dir, { recursive: true, force: true }); });

// Ledger order is chronological: index 0 is oldest, last is newest.
const seed = (ids: string[], stepMinutes = 1) => writeFile(join(runs, 'metrics/jobs.jsonl'),
  ids.map((job, i) => JSON.stringify({
    event: 'outcome', empty: true, job, lane: 'claude',
    ts: new Date(NOW - (ids.length - i) * stepMinutes * 60_000).toISOString(),
  })).join('\n'));
const log = (id: string, text: string) => writeFile(join(runs, `${id}.log`), text);
const notes = (id: string, text: string) => mkdir(join(wt, id), { recursive: true }).then(() => writeFile(join(wt, id, 'BRIDGE_NOTES.md'), text));

describe('readEmptyJobs reasons (original PR #4386 recovery)', () => {
  it('counts reasons with zero counts and treats a missing log as other', async () => {
    await seed(['A', 'B', 'C']);
    await log('A', 'usage limit reached');
    await log('B', 'eslint crashed');
    const r = await readEmptyJobs(24, runs, wt, NOW);
    expect(r?.reasons?.by_reason).toEqual({ 'lint-env': 1, interrupted: 0, blocked: 0, limit: 1, other: 1 });
    expect(r?.reasons?.recent.map(j => j.id)).toEqual(['C', 'B', 'A']);
    expect(r?.reasons?.recent[2]).toEqual({ id: 'A', lane: 'claude', reason: 'limit' });
  });

  it('classifies only the newest 50 logs and lists at most 20 newest first', async () => {
    const ids = Array.from({ length: 60 }, (_, i) => `J${i}`);
    await seed(ids);
    for (const id of ids) await log(id, 'rate limit');
    const r = await readEmptyJobs(24, runs, wt, NOW);
    expect(r?.total).toBe(60);
    expect(r?.reasons?.by_reason).toEqual({ 'lint-env': 0, interrupted: 0, blocked: 0, limit: 50, other: 0 });
    expect(r?.reasons?.recent).toHaveLength(20);
    expect(r?.reasons?.recent[0]).toEqual({ id: 'J59', lane: 'claude', reason: 'limit' });
    expect(r?.reasons?.recent[19]?.id).toBe('J40');
  });

  it('reads only the last 64 KiB of a log', async () => {
    await seed(['T', 'U']);
    await log('T', `usage limit\n${'x'.repeat(70_000)}\n`);
    await log('U', `${'x'.repeat(70_000)}\nusage limit\n`);
    const r = await readEmptyJobs(24, runs, wt, NOW);
    expect(r?.reasons?.by_reason).toMatchObject({ limit: 1, other: 1 });
    expect(r?.reasons?.recent.find(j => j.id === 'T')?.reason).toBe('other');
  });

  it('does not fail when a log is unreadable', async () => {
    await seed(['D']);
    await mkdir(join(runs, 'D.log'));
    const r = await readEmptyJobs(24, runs, wt, NOW);
    expect(r?.reasons?.by_reason.other).toBe(1);
    expect(r?.reasons?.recent).toEqual([{ id: 'D', lane: 'claude', reason: 'other' }]);
  });

  it('tags all five reasons through readEmptyJobs', async () => {
    await seed(['L', 'I', 'B', 'M', 'O', 'N']);
    await log('L', 'ESLint crashed');
    await log('I', 'process exited code 130');
    await log('B', 'the task is blocked');
    await log('M', 'you hit your usage limit');
    await log('O', 'nothing notable happened');
    // N has no log file at all.
    const r = await readEmptyJobs(24, runs, wt, NOW);
    expect(r?.reasons?.by_reason).toEqual({ 'lint-env': 1, interrupted: 1, blocked: 1, limit: 1, other: 2 });
    expect(r?.reasons?.recent.map(j => j.reason)).toEqual(['other', 'other', 'limit', 'blocked', 'interrupted', 'lint-env']);
  });

  it('keeps reasons entries to id, lane and reason only', async () => {
    await seed(['S']);
    await log('S', 'usage limit reached; token=sk-live-abc123 at /Users/someone/private/log.txt');
    const r = await readEmptyJobs(24, runs, wt, NOW);
    const entry = r?.reasons?.recent[0];
    expect(Object.keys(entry!).sort()).toEqual(['id', 'lane', 'reason']);
    const serialized = JSON.stringify(r?.reasons);
    expect(serialized).not.toContain('sk-live-abc123');
    expect(serialized).not.toContain('/Users/someone');
    expect(serialized).not.toContain('token=');
  });

  it('leaves the EmptyClass counts and topCauses untouched', async () => {
    await seed(['P', 'Q', 'R', 'S']);
    await notes('P', 'duplicate of an earlier job');
    await log('Q', 'the test suite timed out');
    await notes('R', 'task is too broad');
    await log('S', 'usage limit reached');
    const r = await readEmptyJobs(24, runs, wt, NOW);
    expect(r?.counts).toEqual({ duplicate: 1, 'already-done': 0, 'too-broad': 1, 'tests-timeout': 1, 'blocked-by-env': 0, 'missing-input': 0, 'scope-too-cautious': 0, other: 1 });
    expect(r?.jobs.map(j => j.class)).toEqual(['duplicate', 'tests-timeout', 'too-broad', 'other']);
    expect(r?.topCauses.map(c => c.class)).toEqual(['duplicate', 'too-broad', 'tests-timeout', 'other']);
    expect(r?.topCauses[0]).toMatchObject({ class: 'duplicate', count: 1, exampleJob: 'P' });
    // Reasons classify the log tail only; notes text never reaches them.
    expect(r?.reasons?.by_reason).toEqual({ 'lint-env': 0, interrupted: 0, blocked: 0, limit: 1, other: 3 });
  });

  it('returns null without a ledger and still reports reasons when empty', async () => {
    expect(await readEmptyJobs(24, join(dir, 'missing'), wt, NOW)).toBeNull();
    await seed([]);
    const r = await readEmptyJobs(24, runs, wt, NOW);
    expect(r?.total).toBe(0);
    expect(r?.reasons).toEqual({ by_reason: { 'lint-env': 0, interrupted: 0, blocked: 0, limit: 0, other: 0 }, recent: [] });
  });
});

describe('shared empty-log classifier', () => {
  it('is the same function behind the core module and the CLI re-exports', () => {
    expect(why.classifyEmptyLog).toBe(classifyEmptyLog);
    expect(cli.classifyEmptyLog).toBe(classifyEmptyLog);
    expect(why.FLEET_EMPTY_WHY_REASONS).toBe(cli.FLEET_EMPTY_WHY_REASONS);
    expect(why.FLEET_EMPTY_WHY_LOG_LINES).toBe(cli.FLEET_EMPTY_WHY_LOG_LINES);
    expect(why.FLEET_EMPTY_WHY_REASONS).toEqual(['lint-env', 'interrupted', 'blocked', 'limit', 'other']);
  });

  it('tags each reason and null as other', () => {
    expect(classifyEmptyLog('ESLint failed')).toBe('lint-env');
    expect(classifyEmptyLog('process exited with code 130')).toBe('interrupted');
    expect(classifyEmptyLog('job blocked on input')).toBe('blocked');
    expect(classifyEmptyLog('You hit your usage limit')).toBe('limit');
    expect(classifyEmptyLog('all quiet')).toBe('other');
    expect(classifyEmptyLog(null)).toBe('other');
  });

  it('looks only at the last 60 lines', () => {
    expect(classifyEmptyLog(['usage limit', ...Array(60).fill('ok')].join('\n'))).toBe('other');
    expect(classifyEmptyLog(['usage limit', ...Array(59).fill('ok')].join('\n'))).toBe('limit');
  });

  it('applies rule precedence in order', () => {
    expect(classifyEmptyLog('eslint failed; job blocked; usage limit')).toBe('lint-env');
    expect(classifyEmptyLog('exited code 130\nusage limit reached')).toBe('interrupted');
    expect(classifyEmptyLog('task is blocked\nyou hit your usage limit')).toBe('blocked');
  });
});

describe('CLI surface after extraction', () => {
  it('still summarizes and prints the empty-why report', async () => {
    const jobs = [{ id: 'A', lane: 'claude' }, { id: 'B', lane: 'devin' }];
    const logs = new Map([['A', 'usage limit'], ['B', null]]);
    const report = cli.summarizeEmptyWhy(jobs, logs, 24);
    expect(report.by_reason).toEqual({ 'lint-env': 0, interrupted: 0, blocked: 0, limit: 1, other: 1 });
    expect(report.ids.limit).toEqual(['A']);
    expect(report.by_lane.devin.other).toBe(1);

    const ledger = [
      JSON.stringify({ event: 'outcome', job: 'A', lane: 'claude', empty: true, ts: new Date(NOW - HOUR).toISOString() }),
      JSON.stringify({ event: 'outcome', job: 'B', lane: 'devin', empty: true, ts: new Date(NOW - 2 * HOUR).toISOString() }),
    ].join('\n');
    const reader = async (p: string) => (p.endsWith('jobs.jsonl') ? ledger : p.endsWith('A.log') ? 'usage limit' : null);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const prev = process.env.ASHLR_RUNS_DIR;
    process.env.ASHLR_RUNS_DIR = '/runs';
    try {
      expect(await cli.cmdFleetEmptyWhy(['--json'], reader, () => NOW)).toBe(0);
    } finally {
      if (prev === undefined) delete process.env.ASHLR_RUNS_DIR; else process.env.ASHLR_RUNS_DIR = prev;
    }
    const printed = JSON.parse(logSpy.mock.calls.map(c => c[0]).join('\n'));
    expect(printed.schema).toBe(cli.FLEET_EMPTY_WHY_SCHEMA);
    expect(printed.by_reason.limit).toBe(1);
    expect(printed.by_reason.other).toBe(1);
  });

  it('keeps classifyEmpty note/log classification unchanged', () => {
    expect(classifyEmpty('duplicate of an earlier job', null)).toEqual({ class: 'duplicate', reason: 'The job duplicated an earlier job.' });
    expect(classifyEmpty(null, null)).toEqual({ class: 'other', reason: 'Notes and log were unavailable.' });
  });
});
