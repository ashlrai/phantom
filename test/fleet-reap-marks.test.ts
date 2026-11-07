import { mkdtemp, mkdir, rm, symlink, utimes, writeFile, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cmdFleetReapMarks } from '../src/cli/fleet-reap-marks.js';
import { FLEET_SUBCOMMAND_LOADERS } from '../src/cli/fleet-subcommand-registry.js';

let root: string;
let run: string;
let log: ReturnType<typeof vi.spyOn>;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'reap-marks-'));
  run = join(root, 'queue', 'run');
  await mkdir(run, { recursive: true });
  vi.stubEnv('ASHLR_RUNS_DIR', root);
  log = vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); });
async function marker(name: string, ageMinutes: number) {
  const path = join(run, `${name}.reaping`);
  await mkdir(path);
  const time = new Date(Date.now() - ageMinutes * 60_000);
  await utimes(path, time, time);
  return path;
}
it('lists only old marker directories in text and JSON without deleting them', async () => {
  const old = await marker('old', 30);
  await marker('new', 5);
  await writeFile(join(run, 'file.reaping'), 'x');
  await symlink(old, join(run, 'link.reaping'));
  expect(await cmdFleetReapMarks(['--json'])).toBe(0);
  const report = JSON.parse(log.mock.calls[0]![0] as string);
  expect(report.total).toBe(1);
  expect(report.markers[0].jobId).toBe('old');
  expect(report.markers[0].ageMinutes).toBeGreaterThanOrEqual(30);
  expect(await lstat(old)).toBeDefined();
  expect(await cmdFleetReapMarks(['--min', '40'])).toBe(0);
  expect(log).toHaveBeenLastCalledWith('Total: 0');
  expect(typeof (await FLEET_SUBCOMMAND_LOADERS['reap-marks']!()).cmdFleetReapMarks).toBe('function');
});
it('removes only old empty directories and reports nonempty markers', async () => {
  const empty = await marker('empty', 30);
  const full = await marker('full', 30);
  await writeFile(join(full, 'keep'), 'x');
  const time = new Date(Date.now() - 30 * 60_000);
  await utimes(full, time, time);
  const recent = await marker('recent', 5);
  expect(await cmdFleetReapMarks(['--apply', '--json'])).toBe(0);
  const report = JSON.parse(log.mock.calls[0]![0] as string);
  expect(report.markers.map((m: { status: string }) => m.status)).toEqual(['removed', 'not-empty']);
  await expect(lstat(empty)).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await lstat(full)).toBeDefined();
  expect(await lstat(recent)).toBeDefined();
});
it('validates arguments and treats a missing run directory as empty', async () => {
  expect(await cmdFleetReapMarks(['--min', '-1'])).toBe(2);
  expect(await cmdFleetReapMarks(['--min', 'NaN'])).toBe(2);
  expect(await cmdFleetReapMarks(['--json', '--json'])).toBe(2);
  expect(await cmdFleetReapMarks(['--help'])).toBe(0);
  await rm(run, { recursive: true });
  expect(await cmdFleetReapMarks(['--json'])).toBe(0);
  expect(JSON.parse(log.mock.calls.at(-1)![0] as string).total).toBe(0);
});
