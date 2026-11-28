import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { actOnStuckJobs, classifyRunning, readStuckJobs, stuckNote, MAX_STUCK_STOPS_PER_TICK } from '../src/core/fleet/running-stuck.js';
import { cmdJobsStuck } from '../src/cli/jobs-stuck.js';

const NOW = Date.parse('2026-11-21T12:00:00Z');
const MIN = 60_000;
let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'stuck-jobs-')); await mkdir(join(dir, 'queue', 'run'), { recursive: true }); });
afterEach(async () => { vi.restoreAllMocks(); await rm(dir, { recursive: true, force: true }); });

/** A running job: marker files, a launch record with pid, a log last written `logQuietMin` ago. */
async function job(id: string, o: { lane?: string; ageMin: number; logQuietMin?: number | null; pid?: number }) {
  const run = join(dir, 'queue', 'run');
  await writeFile(join(run, `${id}.line`), `${id}\tphantom\t${o.lane ?? 'codex-local'}\twork\tprompt`);
  await writeFile(join(run, `${id}.dispatched`), String((NOW - o.ageMin * MIN) / 1000));
  await writeFile(join(dir, `${id}.launch`), `launched ${id} ${o.lane ?? 'codex-local'} pid ${o.pid ?? 4001} base abc123`);
  await writeFile(join(dir, `${id}.base`), 'abc123 branch /tmp/wt');
  if (o.logQuietMin !== null && o.logQuietMin !== undefined) {
    await writeFile(join(dir, `${id}.log`), 'working\n');
    const t = new Date(NOW - o.logQuietMin * MIN);
    await utimes(join(dir, `${id}.log`), t, t);
  }
}
const alive = (...pids: number[]) => (pid: number) => pids.includes(pid);

it('a job with a dead pid is a ghost; a 2 h job with a 40 min stale log is stuck; a 2 h job with a fresh log is fine', async () => {
  await job('ghostly', { ageMin: 20, logQuietMin: 1, pid: 4101 });
  await job('stale', { ageMin: 120, logQuietMin: 40, pid: 4102 });
  await job('fine', { ageMin: 120, logQuietMin: 2, pid: 4103 });
  const r = await readStuckJobs({ runsDir: dir, now: () => NOW, alive: alive(4102, 4103) });
  expect(r).toMatchObject({ schema: 'jobs.stuck.v1', known: true, running: 3 });
  expect(r.stuck.map(s => [s.job, s.kind]).sort()).toEqual([['ghostly', 'ghost'], ['stale', 'stuck']]);
  expect(r.stuck.find(s => s.job === 'stale')!.why).toBe('log silent for 40m');
});

it('a young job or a recent launch is never flagged', () => {
  const base = { lane: 'a', logMtimeMs: NOW - 50 * MIN, pid: 9, baseKey: '1' };
  expect(classifyRunning([{ ...base, job: 'young', startedMs: NOW - 80 * MIN }], NOW, () => true)).toEqual([]);
  expect(classifyRunning([{ ...base, job: 'launching', startedMs: NOW - MIN }], NOW, () => false)).toEqual([]);
});

it('markers closed by a matching .fin are not running; a .fin from another attempt does not close', async () => {
  await job('done', { ageMin: 200, logQuietMin: 100 });
  await job('rerun', { ageMin: 200, logQuietMin: 100 });
  const { stat } = await import('node:fs/promises');
  const key = String(Math.floor((await stat(join(dir, 'done.base'))).mtimeMs / 1000));
  await writeFile(join(dir, 'queue', 'run', 'done.fin'), key);
  await writeFile(join(dir, 'queue', 'run', 'rerun.fin'), '1');
  const r = await readStuckJobs({ runsDir: dir, now: () => NOW, alive: alive(4001) });
  expect(r.running).toBe(1);
  expect(r.stuck.map(s => s.job)).toEqual(['rerun']);
});

it('an empty .fin is not a finish marker, even when no .base survives to key it', async () => {
  await job('torn', { ageMin: 200, logQuietMin: 100 });
  await rm(join(dir, 'torn.base'));
  await writeFile(join(dir, 'queue', 'run', 'torn.fin'), ' \n');
  const r = await readStuckJobs({ runsDir: dir, now: () => NOW, alive: alive(4001) });
  expect(r.running).toBe(1);
  expect(r.stuck.map(s => s.job)).toEqual(['torn']);
});

it('unreadable markers are unknown, not fine', async () => {
  const r = await readStuckJobs({ runsDir: join(dir, 'nope'), now: () => NOW });
  expect(r).toMatchObject({ known: false, stuck: [] });
});

const proc = (pid: number, command: string) => ({ pid, elapsed: '10:00', command, cwd: null });

it('apply closes ghost markers, stops stuck fleet processes, and never signals a non-fleet or GUI process', async () => {
  await job('ghostly', { ageMin: 30, logQuietMin: 1, pid: 4101 });
  await job('stale', { ageMin: 150, logQuietMin: 60, pid: 4102 });
  const kill = vi.fn();
  const res = await actOnStuckJobs({
    runsDir: dir, now: () => NOW, alive: alive(4102), kill, graceMs: 0,
    readers: { readProcesses: async () => [
      proc(5001, 'codex exec --cd /tmp/wt stale'),
      proc(5002, '/Applications/Editor.app/Contents/MacOS/Editor stale'),
      proc(5003, 'vim stale.txt'),
      proc(5004, 'codex exec --cd /tmp/wt other-job'),
    ] },
  });
  expect(res.closed.map(s => s.job)).toEqual(['ghostly']);
  expect(res.stopped.map(s => s.job)).toEqual(['stale']);
  expect(existsSync(join(dir, 'queue', 'run', 'ghostly.fin'))).toBe(true);
  expect(existsSync(join(dir, 'queue', 'run', 'stale.fin'))).toBe(false);
  const signalled = kill.mock.calls.filter(c => c[1] !== 0).map(c => c[0]);
  expect(new Set(signalled)).toEqual(new Set([5001]));
  expect(stuckNote(res)).toBe('codex-local: 1 ghost closed, 1 stuck stopped');
  // The closed marker is no longer counted as running.
  expect((await readStuckJobs({ runsDir: dir, now: () => NOW, alive: alive(4102) })).stuck.map(s => s.job)).toEqual(['stale']);
});

it('stops at most four stuck jobs per tick and leaves the rest for the next one', async () => {
  const procs: ReturnType<typeof proc>[] = [];
  for (let i = 0; i < 6; i++) { await job(`slow${i}`, { ageMin: 200 + i, logQuietMin: 90, pid: 4200 + i }); procs.push(proc(6000 + i, `claude -p slow${i}`)); }
  const kill = vi.fn();
  const res = await actOnStuckJobs({ runsDir: dir, now: () => NOW, alive: () => true, kill, graceMs: 0, readers: { readProcesses: async () => procs } });
  expect(res.stopped).toHaveLength(MAX_STUCK_STOPS_PER_TICK);
  expect(res.skipped).toHaveLength(2);
  expect(res.stopped.map(s => s.job)).toEqual(['slow5', 'slow4', 'slow3', 'slow2']);
  expect(new Set(kill.mock.calls.filter(c => c[1] === 'SIGTERM').map(c => c[0])).size).toBe(4);
});

it('stuck stop does not signal a job that has no fleet process', async () => {
  await job('lonely', { ageMin: 200, logQuietMin: 90 });
  const kill = vi.fn();
  const res = await actOnStuckJobs({ runsDir: dir, now: () => NOW, alive: () => true, kill, graceMs: 0, readers: { readProcesses: async () => [proc(7001, 'vim lonely')] } });
  expect(kill).not.toHaveBeenCalled();
  expect(res.stopped).toEqual([]);
  expect(res.skipped.map(s => s.job)).toEqual(['lonely']);
});

it('jobs stuck prints one plain line per job, --json is jobs.stuck.v1, exit 1 when something is stuck', async () => {
  await job('stale', { ageMin: 120, logQuietMin: 40 });
  const read = (lane?: string) => readStuckJobs({ runsDir: dir, now: () => NOW, alive: () => true, lane });
  const out: string[] = [];
  vi.spyOn(console, 'log').mockImplementation((m: string) => { out.push(m); });
  expect(await cmdJobsStuck([], read)).toBe(1);
  expect(out[0]).toBe('stale codex-local age 2h00 last-log 2026-11-21T11:20:00.000Z STUCK: log silent for 40m');
  out.length = 0;
  expect(await cmdJobsStuck(['--json', '--lane', 'devin'], read)).toBe(0);
  expect(JSON.parse(out[0])).toMatchObject({ schema: 'jobs.stuck.v1', running: 0, stuck: [] });
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  expect(await cmdJobsStuck(['--bogus'], read)).toBe(2);
  expect(await readFile(join(dir, 'queue', 'run', 'stale.line'), 'utf8')).toContain('stale');
});
