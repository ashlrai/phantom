import { mkdtemp, mkdir, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { readLiveJobs, writeLiveJobs } from '../src/core/fleet/live-jobs.js';

const now = Date.parse('2026-11-21T12:00:00Z');
let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'process-evidence-')); await mkdir(join(dir, 'queue/run'), { recursive: true }); });
afterEach(async () => { vi.restoreAllMocks(); await rm(dir, { recursive: true, force: true }); });
async function marker(id: string, pid: string, ageHours: number, idleMinutes = 1) {
  await writeFile(join(dir, `queue/run/${id}.line`), `${id}\tphantom\tlocal\twork\tworking`);
  await writeFile(join(dir, `queue/run/${id}.dispatched`), String((now - ageHours * 3_600_000) / 1000));
  await writeFile(join(dir, `${id}.launch`), pid);
  await writeFile(join(dir, `${id}.log`), 'synthetic log content\n');
  const time = new Date(now - idleMinutes * 60_000);
  await utimes(join(dir, `${id}.log`), time, time);
}
it('preserves independently observed process evidence through the reader and saved snapshot', async () => {
  for (const [id, pid, age, idle] of [
    ['live-old', 'pid 11', 49, 1], ['gone-old', 'pid 12', 49, 1],
    ['boundary', 'pid 12', 48, 1], ['unknown', 'pid 13', 49, 61],
    ['throws', 'pid 14', 49, 61], ['missing', 'launching', 49, 1],
    ['invalid', 'pid 0', 49, 1], ['quiet', 'pid 11', 2, 10], ['stuck', 'pid 11', 2, 61],
  ] as const) await marker(id, pid, age, idle);
  const probe = vi.fn((pid: number): boolean | null => {
    if (pid === 14) throw new Error('unavailable');
    return pid === 11 ? true : pid === 12 ? false : null;
  });
  const report = await readLiveJobs({ runsDir: dir, wtRoot: dir, now: () => now, alive: probe });
  const expected = {
    'live-old': ['live', 'moving'], 'gone-old': ['gone', 'stale'], boundary: ['gone', 'stuck'],
    unknown: ['unknown', 'unknown'], throws: ['unknown', 'unknown'], missing: ['unknown', 'unknown'],
    invalid: ['unknown', 'unknown'], quiet: ['live', 'quiet'], stuck: ['live', 'stuck'],
  };
  expect(Object.fromEntries(report.jobs.map(j => [j.id, [j.process, j.status]]))).toEqual(expected);
  expect(report.jobs.find(j => j.id === 'gone-old')?.processLive).toBe(false);
  expect(report.jobs.find(j => j.id === 'missing')?.processLive).toBeUndefined();
  expect(probe).not.toHaveBeenCalledWith(0);
  const file = join(dir, 'snapshot.json');
  await writeLiveJobs(file, report);
  const text = await readFile(file, 'utf8');
  const snapshot = JSON.parse(text);
  expect(Object.fromEntries(snapshot.running.map((j: { id: string; process: string; state: string }) => [j.id, [j.process, j.state]]))).toEqual(expected);
  expect(text).not.toContain('synthetic log content');
  expect(text).not.toContain('lastLine');
});
it.each([['ESRCH', 'gone', 'stale'], ['EPERM', 'live', 'moving'], ['EIO', 'unknown', 'unknown']])(
  'records %s probe evidence in the saved snapshot', async (code, evidence, status) => {
    await marker('probe', 'pid 15', 49);
    vi.spyOn(process, 'kill').mockImplementation(() => { throw Object.assign(new Error('probe'), { code }); });
    const report = await readLiveJobs({ runsDir: dir, wtRoot: dir, now: () => now });
    const file = join(dir, 'snapshot.json');
    await writeLiveJobs(file, report);
    expect(report.jobs[0]).toMatchObject({ process: evidence, status });
    expect(JSON.parse(await readFile(file, 'utf8')).running[0]).toMatchObject({ process: evidence, state: status });
  },
);
