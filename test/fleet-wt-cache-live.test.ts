import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetWtCache, type FleetWtCacheDeps, type FleetWtCacheView } from '../src/cli/fleet-wt-cache.js';

const ROOT = '/wt';
const NOW = Date.parse('2026-11-04T12:00:00Z');
const HOUR = 3_600_000;
const homes: string[] = [];

function setup(ageHours = 3) {
  const listDirs = vi.fn(async (path: string) => path === ROOT ? ['RQ-RUNNING', 'RQ-IDLE'] : ['node_modules', 'target', '.next']);
  const du = vi.fn(async () => 1024 ** 3);
  const remove = vi.fn(async () => {});
  const readRunningJobs = vi.fn(async () => new Set(['RQ-RUNNING']));
  const deps: FleetWtCacheDeps = {
    fs: { listDirs, mtimeMs: async () => NOW - ageHours * HOUR },
    now: () => NOW, du, remove, readRunningJobs,
  };
  return { deps, listDirs, du, remove, readRunningJobs };
}

async function run(args: string[], deps: FleetWtCacheDeps) {
  let output = '';
  vi.spyOn(process.stdout, 'write').mockImplementation(((s: string) => { output += s; return true; }) as never);
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const code = await cmdFleetWtCache(['--root', ROOT, '--json', ...args], deps);
  return { code, view: output ? JSON.parse(output) as FleetWtCacheView : undefined };
}

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await Promise.all(homes.splice(0).map(home => rm(home, { recursive: true, force: true })));
});

describe('fleet wt-cache live jobs', () => {
  it.each([false, true])('skips running jobs before inspecting caches, while listing idle jobs (apply=%s)', async apply => {
    const { deps, listDirs, du, remove, readRunningJobs } = setup();
    const { code, view } = await run(apply ? ['--apply'] : [], deps);
    expect(code).toBe(0);
    expect(view?.caches.map(c => c.path)).toEqual(['node_modules', 'target', '.next'].map(kind => `${ROOT}/RQ-IDLE/${kind}`));
    expect(listDirs).not.toHaveBeenCalledWith(`${ROOT}/RQ-RUNNING`);
    expect(du.mock.calls).toHaveLength(3);
    expect(remove).toHaveBeenCalledTimes(apply ? 3 : 0);
    expect(readRunningJobs).toHaveBeenCalledOnce();
  });

  it.each([[[], 2, true], [[], 1.5, false], [['--min-hours', '1'], 1, true], [['--min-hours', '1'], 0.99, false], [['--min-hours', '0.5'], 0.5, true]] as const)(
    'uses the inclusive minimum age for %j at %s hours', async (args, age, listed) => {
      const { code, view } = await run([...args], setup(age).deps);
      expect(code).toBe(0);
      expect(view?.caches).toHaveLength(listed ? 3 : 0);
    },
  );

  it.each(['0', '-1', 'nope', 'NaN', 'Infinity', '', '--apply', undefined])('rejects --min-hours %s before reading or removing', async value => {
    const { deps, listDirs, remove, readRunningJobs } = setup();
    expect((await run(['--min-hours', ...(value === undefined ? [] : [value])], deps)).code).toBe(2);
    expect(listDirs).not.toHaveBeenCalled();
    expect(readRunningJobs).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
  });

  it('rejects duplicate --min-hours and documents the flag and default', async () => {
    expect((await run(['--min-hours', '1', '--min-hours', '2'], setup().deps)).code).toBe(2);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await cmdFleetWtCache(['--help'])).toBe(0);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('[--min-hours N]'));
    expect(log).toHaveBeenCalledWith(expect.stringContaining('default 2'));
  });

  it('reads TSV job ids from unfinished .line files and ignores matching .fin markers', async () => {
    const home = await mkdtemp(join(tmpdir(), 'wt-cache-live-'));
    homes.push(home);
    vi.stubEnv('HOME', home);
    const { deps, remove } = setup();
    delete deps.readRunningJobs;
    // A missing queue is normal on a machine without a dispatcher.
    expect((await run([], deps)).view?.caches).toHaveLength(6);
    const queue = join(home, '.ashlr-runs', 'queue', 'run');
    await mkdir(queue, { recursive: true });
    await writeFile(join(queue, 'different-name.line'), 'RQ-RUNNING\tphantom\twork\n');
    await writeFile(join(queue, 'finished.line'), 'RQ-IDLE\tphantom\twork\n');
    await writeFile(join(queue, 'finished.fin'), 'done\n');
    await writeFile(join(queue, 'ignored.txt'), 'RQ-IDLE\tphantom\n');
    const { code, view } = await run(['--apply'], deps);
    expect(code).toBe(0);
    expect(view?.caches.map(c => c.job)).toEqual(['RQ-IDLE', 'RQ-IDLE', 'RQ-IDLE']);
    remove.mockClear();
    // A broken run directory must block cleanup rather than mean no live jobs.
    await rm(queue, { recursive: true });
    await writeFile(queue, 'not a directory');
    expect((await run(['--apply'], deps)).code).toBe(1);
    expect(remove).not.toHaveBeenCalled();
  });

  it('stops cleanup when the running-jobs reader fails', async () => {
    const { deps, listDirs, remove } = setup();
    deps.readRunningJobs = async () => { throw new Error('queue unavailable'); };
    expect((await run(['--apply'], deps)).code).toBe(1);
    expect(listDirs).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
  });
});
