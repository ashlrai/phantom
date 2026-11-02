import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { findJobProcesses, JOB_STOPS_FILE, stopJob, type JobProcessReaders } from './job-stop.js';

const JOB = 'RQ-PHX-JOB1';
const processes = [
  { pid: 111, elapsed: '01:00', command: `/fake/bin/launch.sh ${JOB} fake-repo codex mid`, cwd: null },
  { pid: 222, elapsed: '01:00', command: `claude -p --add-dir /wt/${JOB}`, cwd: `/wt/${JOB}` },
  // cwd matches but the command line lacks the id: never a stop target.
  { pid: 333, elapsed: '9:99:99', command: 'node /app/verse-server.js', cwd: `/wt/${JOB}` },
  { pid: 444, elapsed: '00:01', command: `grep ${JOB}`, cwd: null },
  // A longer id that merely contains JOB must not match on token boundaries.
  { pid: 555, elapsed: '00:02', command: `/fake/bin/launch.sh ${JOB}X fake-repo codex mid`, cwd: null },
  { pid: 0, elapsed: '00:01', command: `/fake/bin/launch.sh ${JOB} fake-repo codex mid`, cwd: null },
];
const readers: JobProcessReaders = { readProcesses: async () => processes };
const noProcesses: JobProcessReaders = { readProcesses: async () => [] };

type Signal = 'SIGTERM' | 'SIGKILL' | 0;
interface Call { pid: number; signal: Signal }
function recordingKill(exitsOnTerm: ReadonlySet<number>) {
  const calls: Call[] = [];
  const alive = new Set(processes.map((row) => row.pid));
  const kill = (pid: number, signal: Signal) => {
    calls.push({ pid, signal });
    if (!alive.has(pid)) throw Object.assign(new Error('no such process'), { code: 'ESRCH' });
    if (signal === 'SIGTERM' && exitsOnTerm.has(pid)) alive.delete(pid);
    if (signal === 'SIGKILL') alive.delete(pid);
  };
  return { calls, kill };
}
const noTimer = { set: (fn: () => void) => { fn(); return {}; } };

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'job-stop-')); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

async function ledger() {
  const text = await readFile(join(dir, JOB_STOPS_FILE), 'utf8');
  return text.trimEnd().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
}
const events = () => readFile(join(dir, 'dispatch-events.log'), 'utf8');

it('finds only pids whose command line carries the id on token boundaries', async () => {
  expect(await findJobProcesses(JOB, readers)).toEqual([111, 222]);
  expect(await findJobProcesses('bad id', readers)).toEqual([]);
});

it('SIGTERMs only the matching pids and writes the ledger and event rows', async () => {
  const { calls, kill } = recordingKill(new Set([111, 222]));
  const result = await stopJob(JOB, { readers, kill, timers: noTimer, runsDir: dir, now: () => Date.parse('2026-11-01T00:08:00Z') });
  expect(result).toMatchObject({ id: JOB, pids: [111, 222], outcome: 'stopped', at: '2026-11-01T00:08:00.000Z' });
  expect(calls).toEqual([
    { pid: 111, signal: 'SIGTERM' }, { pid: 222, signal: 'SIGTERM' },
    { pid: 111, signal: 0 }, { pid: 222, signal: 0 },
  ]);
  expect(await ledger()).toEqual([{ at: '2026-11-01T00:08:00.000Z', id: JOB, pids: [111, 222], outcome: 'stopped', by: 'verse-operator' }]);
  expect(await events()).toBe('2026-11-01 00:08:00 LANE_HOLD stopped RQ-PHX-JOB1 by verse-operator: 2 processes signalled\n');
});

it('SIGKILLs the survivor after graceMs, never the pid that already exited', async () => {
  const { calls, kill } = recordingKill(new Set([111]));
  const pending: (() => void)[] = [];
  const timers = { set: (fn: () => void) => { pending.push(fn); return {}; } };
  const run = stopJob(JOB, { readers, kill, timers, graceMs: 8000, runsDir: dir });
  for (let i = 0; i < 100 && pending.length === 0; i++) await new Promise((resolve) => setImmediate(resolve));
  expect(pending).toHaveLength(1);
  expect(calls).toEqual([{ pid: 111, signal: 'SIGTERM' }, { pid: 222, signal: 'SIGTERM' }]);
  pending[0]!();
  const result = await run;
  expect(result.outcome).toBe('stopped');
  expect(calls).toEqual([
    { pid: 111, signal: 'SIGTERM' }, { pid: 222, signal: 'SIGTERM' },
    { pid: 111, signal: 0 }, { pid: 222, signal: 0 },
    { pid: 222, signal: 'SIGKILL' },
  ]);
});

it('reports not-running when no process carries the id, still audited', async () => {
  const { calls, kill } = recordingKill(new Set());
  const result = await stopJob(JOB, { readers: noProcesses, kill, runsDir: dir });
  expect(result).toMatchObject({ id: JOB, pids: [], outcome: 'not-running' });
  expect(calls).toEqual([]);
  expect(await ledger()).toEqual([expect.objectContaining({ id: JOB, pids: [], outcome: 'not-running', by: 'verse-operator' })]);
  expect(await events()).toContain('LANE_HOLD stopped RQ-PHX-JOB1 by verse-operator: no live processes');
});

it('refuses an id with a space and signals nothing', async () => {
  const { calls, kill } = recordingKill(new Set());
  const result = await stopJob('RQ PHX', { readers, kill, runsDir: dir });
  expect(result).toMatchObject({ id: 'RQ PHX', pids: [], outcome: 'refused' });
  expect(calls).toEqual([]);
  expect(await ledger()).toEqual([expect.objectContaining({ id: 'RQ PHX', outcome: 'refused' })]);
  await expect(events()).rejects.toMatchObject({ code: 'ENOENT' });
});
