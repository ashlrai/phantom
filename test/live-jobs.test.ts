import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readLiveJobs, writeLiveJobs } from '../src/core/fleet/live-jobs.js';
import * as logs from '../src/core/fleet/runs-job-detail.js';
import { runSelfTick, SELF_TICK_STEP_ORDER, type SelfTickSteps } from '../src/core/fleet/self-tick.js';
import { cmdJobsLive } from '../src/cli/jobs-live.js';
import { compactBriefLines, readCompactBrief } from '../src/core/fleet/leader-compact-brief.js';
import { groupHostFamilies } from '../src/core/fleet/host-families.js';
const NOW = Date.parse('2026-11-21T12:00:00Z');
let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'live-jobs-')); await mkdir(join(dir, 'queue/run'), { recursive: true }); });
afterEach(async () => { vi.restoreAllMocks(); await rm(dir, { recursive: true, force: true }); });
const read = () => readLiveJobs({ runsDir: dir, wtRoot: dir, now: () => NOW, alive: pid => pid === 12 });
async function job(id: string, minutes: number, pid: number | null = 12, ageMinutes = 120) {
  await writeFile(join(dir, `queue/run/${id}.line`), `${id}\tphantom\tlocal\twork\tworking`);
  await writeFile(join(dir, `queue/run/${id}.dispatched`), String((NOW - ageMinutes * 60_000) / 1000));
  await writeFile(join(dir, `${id}.launch`), pid === null ? 'launching' : `pid ${pid}`);
  await writeFile(join(dir, `${id}.log`), `working\n\n---\n`);
  const time = new Date(NOW - minutes * 60_000); await utimes(join(dir, `${id}.log`), time, time);
}
it('classifies boundary ages and dead or missing processes, preserving redacted progress', async () => {
  for (const [id, age, pid] of [['fresh', 9, 12], ['quiet', 10, 12], ['hour', 60, 12], ['old', 61, 12], ['gone', 1, 13], ['missing', 1, null]] as const) await job(id, age, pid);
  const redact = vi.spyOn(logs, 'scrubJobLogLine').mockImplementation(line => line === 'working' ? 'hidden' : line);
  const report = await read();
  expect(Object.fromEntries(report.jobs.map(j => [j.id, j.status]))).toEqual({ fresh: 'moving', quiet: 'quiet', hour: 'quiet', old: 'stuck', gone: 'stuck', missing: 'unknown' });
  expect(report.jobs[0]).toMatchObject({ repo: 'phantom', lane: 'local', elapsed: 7200, lastLine: 'hidden', started: '2026-11-21T10:00:00.000Z' });
  expect(redact).toHaveBeenCalledWith('working');
});
it('keeps missing evidence unknown and excludes finished attempts', async () => {
  await job('bare', 1); await rm(join(dir, 'bare.log')); await rm(join(dir, 'bare.launch')); await rm(join(dir, 'queue/run/bare.dispatched'));
  await job('done', 1); await writeFile(join(dir, 'queue/run/done.fin'), 'finished');
  expect((await read()).jobs).toMatchObject([{ id: 'bare', started: 'unknown', elapsed: 'unknown', lastLine: 'unknown', lastLogWrite: 'unknown', process: 'unknown', status: 'unknown' }]);
  expect(await readLiveJobs({ runsDir: join(dir, 'absent') })).toMatchObject({ known: false, jobs: [] });
});
it('ignores only confirmed gone processes older than 48 hours in the saved brief', async () => {
  for (const [id, idle, pid, age] of [
    ['live-old', 61, 12, 2881], ['live-moving', 1, 12, 2881], ['stale', 1, 13, 2881],
    ['boundary', 1, 13, 2880], ['recent-gone', 1, 13, 120], ['unknown', 61, null, 2881],
  ] as const) await job(id, idle, pid, age);
  const report = await read();
  expect(report.jobs.map(({ id, process, status }) => ({ id, process, status }))).toEqual([
    { id: 'boundary', process: 'gone', status: 'stuck' },
    { id: 'live-moving', process: 'live', status: 'moving' },
    { id: 'live-old', process: 'live', status: 'stuck' },
    { id: 'recent-gone', process: 'gone', status: 'stuck' },
    { id: 'stale', process: 'gone', status: 'stale' },
    { id: 'unknown', process: 'unknown', status: 'unknown' },
  ]);
  const file = join(dir, 'queue/live-jobs.json');
  await writeLiveJobs(file, report);
  const snapshot = JSON.parse(await readFile(file, 'utf8'));
  expect(snapshot.running).toContainEqual(expect.objectContaining({ id: 'stale', state: 'stale', process: 'gone' }));
  expect(snapshot.running).toContainEqual(expect.objectContaining({ id: 'unknown', state: 'unknown', process: 'unknown' }));
  const brief = await readCompactBrief(dir, NOW, async () => groupHostFamilies(null));
  expect(brief.attention.map(j => j.id)).toEqual(['live-old', 'boundary', 'recent-gone']);
  expect(compactBriefLines(brief)).toContain('Quiet/stuck: live-old, boundary, recent-gone');
  const output = vi.spyOn(console, 'log').mockImplementation(() => {});
  expect(await cmdJobsLive(['--json'], read)).toBe(0);
  expect(JSON.parse(output.mock.calls[0]![0])).toEqual(report);
});
it.each(['unavailable', 'throws'])('keeps %s process probes unknown despite old markers', async mode => {
  await job('old', 3000, 12, 3000);
  const report = await readLiveJobs({ runsDir: dir, now: () => NOW, alive: () => {
    if (mode === 'throws') throw new Error('Process observation unavailable');
    return null;
  } });
  expect(report.jobs[0]).toMatchObject({ id: 'old', process: 'unknown', status: 'unknown' });
});
it.each([
  ['ESRCH', 'gone', 'stale'], ['EPERM', 'live', 'stuck'], ['EIO', 'unknown', 'unknown'],
])('classifies an old marker after a %s process probe', async (code, processState, status) => {
  await job('old', 3000, 12, 3000);
  const probe = vi.spyOn(process, 'kill').mockImplementation(() => { throw Object.assign(new Error('Probe failed'), { code }); });
  const report = await readLiveJobs({ runsDir: dir, wtRoot: dir, now: () => NOW });
  expect(report.jobs[0]).toMatchObject({ process: processState, status });
  expect(probe).toHaveBeenCalledExactlyOnceWith(12, 0);
});
it('uses the launch time to age markers with no dispatch time', async () => {
  await job('undated', 1, 13); await rm(join(dir, 'queue/run/undated.dispatched'));
  await utimes(join(dir, 'undated.launch'), new Date(NOW - 3000 * 60_000), new Date(NOW - 3000 * 60_000));
  // The launch mtime is the documented start fallback when dispatch time is absent.
  expect((await read()).jobs[0]).toMatchObject({ status: 'stale' });
});
it('writes a private sibling temp then renames, retaining the previous file on failure', async () => {
  const file = join(dir, 'live.json'), report = await read(); await writeFile(file, 'old');
  await writeLiveJobs(file, report, async (temp, target) => {
    expect(target).toBe(file); expect(temp).toMatch(/\.tmp$/); expect(await readFile(file, 'utf8')).toBe('old');
    expect(JSON.parse(await readFile(temp, 'utf8'))).toMatchObject({ running: [], finished_recent: [] }); expect((await stat(temp)).mode & 0o777).toBe(0o600); await rename(temp, target);
  });
  await expect(writeLiveJobs(file, report, async () => { throw new Error('blocked'); })).rejects.toThrow('blocked');
  expect(JSON.parse(await readFile(file, 'utf8'))).toMatchObject({ running: [], finished_recent: [] }); expect((await readdir(dir)).some(n => n.endsWith('.tmp'))).toBe(false);
  const output = vi.spyOn(console, 'log').mockImplementation(() => {});
  expect(await cmdJobsLive(['--json', '--write', file], read)).toBe(0); expect(JSON.parse(output.mock.calls[0]![0])).toEqual(report);
});
it('refreshes the queue snapshot every acquired tick, including dry runs', async () => {
  const steps = Object.fromEntries(SELF_TICK_STEP_ORDER.map(s => [s, async () => ({ exitCode: 0, output: '{}' })])) as SelfTickSteps;
  expect((await runSelfTick({ runsDir: dir, now: () => NOW, steps })).report.liveJobs).toBe('written');
  expect(JSON.parse(await readFile(join(dir, 'queue/live-jobs.json'), 'utf8'))).toMatchObject({ running: [], finished_recent: [] });
});

it('writes a small snapshot for 500 worktrees and 10 running jobs', async () => {
  const wt = join(dir, 'worktrees'); await mkdir(wt);
  for (let i = 0; i < 500; i++) await mkdir(join(wt, `job${i}`));
  for (let i = 0; i < 10; i++) await job(`job${i}`, 1);
  const report = await readLiveJobs({ runsDir: dir, wtRoot: wt, now: () => NOW, alive: () => true });
  const file = join(dir, 'snapshot.json'); await writeLiveJobs(file, report);
  const data = await readFile(file, 'utf8'); const snapshot = JSON.parse(data);
  expect(snapshot.running).toHaveLength(10); expect(snapshot.other_worktrees).toBe(490);
  expect(Buffer.byteLength(data)).toBeLessThan(32 * 1024);
  expect(data).not.toContain('lastLine'); expect(data).not.toContain('working');
});
