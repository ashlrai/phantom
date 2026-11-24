import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readLiveJobs, writeLiveJobs } from '../src/core/fleet/live-jobs.js';
import { cmdJobsLive } from '../src/cli/jobs-live.js';
import { compactBriefLines, readCompactBrief } from '../src/core/fleet/leader-compact-brief.js';
import { groupHostFamilies } from '../src/core/fleet/host-families.js';

const NOW = Date.parse('2026-11-21T12:00:00Z');
let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'stale-original-')); await mkdir(join(dir, 'queue/run'), { recursive: true }); });
afterEach(async () => { vi.restoreAllMocks(); await rm(dir, { recursive: true, force: true }); });
const read = () => readLiveJobs({ runsDir: dir, wtRoot: dir, now: () => NOW, alive: pid => pid === 12 });
async function job(id: string, idle: number, pid: number | null, age: number) {
  await writeFile(join(dir, `queue/run/${id}.line`), `${id}\tphantom\tlocal\twork\tworking`);
  await writeFile(join(dir, `queue/run/${id}.dispatched`), String((NOW - age * 60_000) / 1000));
  await writeFile(join(dir, `${id}.launch`), pid === null ? 'launching' : `pid ${pid}`);
  await writeFile(join(dir, `${id}.log`), 'working\n\n---\n');
  const time = new Date(NOW - idle * 60_000); await utimes(join(dir, `${id}.log`), time, time);
}

it('omits only confirmed old gone jobs from the saved brief', async () => {
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
  const data = await readFile(file, 'utf8');
  const snapshot = JSON.parse(data);
  expect(snapshot.running).toContainEqual(expect.objectContaining({ id: 'stale', state: 'stale', process: 'gone' }));
  expect(snapshot.running).toContainEqual(expect.objectContaining({ id: 'unknown', state: 'unknown', process: 'unknown' }));
  expect(data).not.toContain('working');
  const brief = await readCompactBrief(dir, NOW, async () => groupHostFamilies(null));
  expect(brief.attention.map(j => j.id)).toEqual(['live-old', 'boundary', 'recent-gone']);
  expect(compactBriefLines(brief)).toContain('Quiet/stuck: live-old, boundary, recent-gone');
  const output = vi.spyOn(console, 'log').mockImplementation(() => {});
  expect(await cmdJobsLive(['--json'], read)).toBe(0);
  expect(JSON.parse(output.mock.calls[0]![0])).toEqual(JSON.parse(JSON.stringify(report)));
});

it.each(['unavailable', 'throws'])('keeps %s observations unknown for old jobs', async mode => {
  await job('old', 3000, 12, 3000);
  const report = await readLiveJobs({ runsDir: dir, wtRoot: dir, now: () => NOW, alive: () => {
    if (mode === 'throws') throw new Error('Process observation unavailable');
    return null;
  } });
  expect(report.jobs[0]).toMatchObject({ id: 'old', process: 'unknown', status: 'unknown' });
});

it.each([
  ['ESRCH', 'gone', 'stale'], ['EPERM', 'live', 'stuck'], ['EIO', 'unknown', 'unknown'],
])('classifies an old marker after a %s probe', async (code, processState, status) => {
  await job('old', 3000, 12, 3000);
  const probe = vi.spyOn(process, 'kill').mockImplementation(() => { throw Object.assign(new Error('Probe failed'), { code }); });
  const report = await readLiveJobs({ runsDir: dir, wtRoot: dir, now: () => NOW });
  expect(report.jobs[0]).toMatchObject({ process: processState, status });
  expect(probe).toHaveBeenCalledExactlyOnceWith(12, 0);
});

it('uses launch mtime when the dispatch timestamp is absent', async () => {
  await job('undated', 1, 13, 120); await rm(join(dir, 'queue/run/undated.dispatched'));
  const time = new Date(NOW - 3000 * 60_000); await utimes(join(dir, 'undated.launch'), time, time);
  expect((await read()).jobs[0]).toMatchObject({ started: time.toISOString(), process: 'gone', status: 'stale' });
});
