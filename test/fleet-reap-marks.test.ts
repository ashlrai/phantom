import { mkdtemp, mkdir, rm, rmdir, rename, symlink, utimes, writeFile, readFile, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cmdFleetReapMarks } from '../src/cli/fleet-reap-marks.js';
import { FLEET_SUBCOMMAND_LOADERS } from '../src/cli/fleet-subcommand-registry.js';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, lstat: vi.fn(actual.lstat), rmdir: vi.fn(actual.rmdir) };
});

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
afterEach(async () => {
  vi.restoreAllMocks();
  vi.mocked(lstat).mockReset();
  vi.mocked(rmdir).mockReset();
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  vi.mocked(lstat).mockImplementation(actual.lstat);
  vi.mocked(rmdir).mockImplementation(actual.rmdir);
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});
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
  expect(report.applied).toBe(false);
  expect(report.markers[0].jobId).toBe('old');
  expect(report.markers[0].ageMinutes).toBeGreaterThanOrEqual(30);
  expect(await lstat(old)).toBeDefined();
  expect(await cmdFleetReapMarks(['--min', '40'])).toBe(0);
  expect(log).toHaveBeenLastCalledWith('Total: 0');
  expect(rmdir).not.toHaveBeenCalled();
  expect(typeof (await FLEET_SUBCOMMAND_LOADERS['reap-marks']!()).cmdFleetReapMarks).toBe('function');
});
it('blocks apply and preserves old empty, nonempty and recent markers', async () => {
  const empty = await marker('empty', 30);
  const full = await marker('full', 30);
  await writeFile(join(full, 'keep'), 'x');
  const time = new Date(Date.now() - 30 * 60_000);
  await utimes(full, time, time);
  const recent = await marker('recent', 5);
  expect(await cmdFleetReapMarks(['--apply', '--json'])).toBe(1);
  const report = JSON.parse(log.mock.calls[0]![0] as string);
  expect(report).toMatchObject({ applied: false, applyRequested: true, blockedReason: 'ownership-and-fencing-unavailable' });
  expect(report.markers.map((m: { status: string }) => m.status)).toEqual(['blocked', 'blocked']);
  expect(await lstat(empty)).toBeDefined();
  expect(await readFile(join(full, 'keep'), 'utf8')).toBe('x');
  expect(await lstat(recent)).toBeDefined();
  expect(rmdir).not.toHaveBeenCalled();
  expect(console.error).toHaveBeenCalledWith(expect.stringContaining('--apply is disabled'));
});
it('does not treat an old empty marker owned by this live process as abandoned', async () => {
  // The legacy mkdir lock has no owner metadata or heartbeat. Its owning
  // process can still be executing after the directory's mtime passes --min.
  const owned = await marker('live-owner', 120);
  const before = await lstat(owned);
  expect(() => process.kill(process.pid, 0)).not.toThrow();
  const result = await cmdFleetReapMarks(['--apply', '--min', '0', '--json']);
  expect(await lstat(owned)).toMatchObject({ ino: before.ino, dev: before.dev });
  expect(result).toBe(1);
  expect(rmdir).not.toHaveBeenCalled();
});
it('does not unlink a replacement swapped in after the last lstat', async () => {
  const path = await marker('replace', 30);
  const previous = join(root, 'previous-marker');
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  let swapped = false;
  // The vulnerable implementation rechecks lstat, then removes by pathname.
  // Swap at the removal boundary to reproduce replacement of the checked inode.
  vi.mocked(rmdir).mockImplementation(async (target) => {
    if (target === path) {
      await rename(path, previous);
      await mkdir(path);
      swapped = true;
    }
    await actual.rmdir(target);
  });
  const result = await cmdFleetReapMarks(['--apply', '--json']);
  expect(await lstat(path)).toBeDefined();
  expect(result).toBe(1);
  expect(rmdir).not.toHaveBeenCalled();
  expect(swapped).toBe(false);
});
it('keeps a replacement created during inventory and reports the apply blocker', async () => {
  const path = await marker('replace-during-list', 30);
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  const snapshot = await actual.lstat(path);
  vi.mocked(lstat).mockImplementationOnce(async () => {
    await rename(path, join(root, 'previous-marker'));
    await mkdir(path);
    return snapshot;
  });
  expect(await cmdFleetReapMarks(['--apply', '--json'])).toBe(1);
  expect((await actual.lstat(path)).ino).not.toBe(snapshot.ino);
  expect(rmdir).not.toHaveBeenCalled();
});
it('blocks apply even with no candidates or a missing run directory', async () => {
  await marker('recent', 5);
  expect(await cmdFleetReapMarks(['--apply'])).toBe(1);
  expect(log).toHaveBeenLastCalledWith('Total: 0');
  await rm(run, { recursive: true });
  expect(await cmdFleetReapMarks(['--apply', '--json'])).toBe(1);
  expect(JSON.parse(log.mock.calls.at(-1)![0] as string)).toMatchObject({ applied: false, total: 0, blockedReason: 'ownership-and-fencing-unavailable' });
  expect(rmdir).not.toHaveBeenCalled();
});
it('validates arguments, documents the blocker and treats a missing run directory as empty', async () => {
  expect(await cmdFleetReapMarks(['--min', '-1'])).toBe(2);
  expect(await cmdFleetReapMarks(['--min', 'NaN'])).toBe(2);
  expect(await cmdFleetReapMarks(['--json', '--json'])).toBe(2);
  expect(await cmdFleetReapMarks(['--apply', '--apply'])).toBe(2);
  expect(await cmdFleetReapMarks(['--help'])).toBe(0);
  expect(log).toHaveBeenLastCalledWith(expect.stringContaining('--apply is disabled'));
  await rm(run, { recursive: true });
  expect(await cmdFleetReapMarks(['--json'])).toBe(0);
  expect(JSON.parse(log.mock.calls.at(-1)![0] as string).total).toBe(0);
});
