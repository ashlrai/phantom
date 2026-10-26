import { afterEach, describe, expect, it, vi } from 'vitest';
import { chmod, cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { prepareDependencies } from '../scripts/bridge-worktree.mjs';

const run = promisify(execFile);
const helper = fileURLToPath(new URL('../scripts/bridge-worktree.mjs', import.meta.url));
const FLOOR = 20 * 1024 ** 3;
const roots: string[] = [];
const manifest = '{"name":"bridge-fixture","version":"1.0.0"}\n';
const lockfile = '{"name":"bridge-fixture","lockfileVersion":3,"packages":{}}\n';
const plenty = async () => FLOOR + 1024 ** 3;

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'phantom-bridge-worktree-'));
  roots.push(root);
  const source = join(root, 'source');
  await mkdir(join(source, 'node_modules', 'fixture'), { recursive: true });
  await mkdir(join(source, 'node_modules', '.bin'));
  await writeFile(join(source, 'package.json'), manifest);
  await writeFile(join(source, 'package-lock.json'), lockfile);
  await writeFile(join(source, 'node_modules', 'fixture', 'index.js'), 'export const value = 42;\n');
  await chmod(join(source, 'node_modules', 'fixture', 'index.js'), 0o755);
  await symlink('../fixture/index.js', join(source, 'node_modules', '.bin', 'fixture'));
  const target = await targetAt(root, 'target');
  return { root, source, target };
}

async function targetAt(root: string, name: string) {
  const target = join(root, name);
  await mkdir(target);
  await writeFile(join(target, 'package.json'), manifest);
  await writeFile(join(target, 'package-lock.json'), lockfile);
  return target;
}

async function absent(path: string) {
  await expect(lstat(path)).rejects.toMatchObject({ code: 'ENOENT' });
}

async function onlyManifests(target: string) {
  expect((await readdir(target)).sort()).toEqual(['package-lock.json', 'package.json']);
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

const copyFixture = async (source: string, target: string) => cp(source, target, { recursive: true });

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('Mac bridge dependency preparation', () => {
  it('publishes a complete clone with executable links and measured preparation time', async () => {
    const { source, target } = await fixture();
    const clone = vi.fn(copyFixture);
    const result = await prepareDependencies({ source, target, cloneTimeoutMs: 1234 }, {
      platform: 'darwin', freeBytes: plenty, clone,
    });
    expect(result.method).toBe('apfs-clone');
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(Number.isFinite(result.durationMs)).toBe(true);
    expect(clone).toHaveBeenCalledOnce();
    expect(clone).toHaveBeenCalledWith(expect.any(String), expect.any(String), 1234);
    expect(clone.mock.calls[0]?.[0]).toBe(join(await realpath(source), 'node_modules'));
    expect(await readFile(join(target, 'node_modules', '.bin', 'fixture'), 'utf8')).toContain('42');
    expect((await lstat(join(target, 'node_modules'))).isDirectory()).toBe(true);
    expect((await readdir(target)).sort()).toEqual(['node_modules', 'package-lock.json', 'package.json']);
  });

  it('removes a partial failed clone before publishing the symlink fallback', async () => {
    const { source, target } = await fixture();
    const clone = vi.fn(async (_source: string, staging: string) => {
      await mkdir(staging);
      await writeFile(join(staging, 'partial'), 'incomplete');
      throw new Error('clone unsupported');
    });
    const result = await prepareDependencies({ source, target }, { platform: 'darwin', freeBytes: plenty, clone });
    expect(result.method).toBe('symlink');
    expect((await lstat(join(target, 'node_modules'))).isSymbolicLink()).toBe(true);
    expect(await realpath(join(target, 'node_modules'))).toBe(await realpath(join(source, 'node_modules')));
    await absent(join(source, 'node_modules', 'partial'));
    expect((await readdir(target)).sort()).toEqual(['node_modules', 'package-lock.json', 'package.json']);
  });

  it('uses the symlink fallback off Darwin without attempting a recursive copy', async () => {
    const { source, target } = await fixture();
    const clone = vi.fn(copyFixture);
    const result = await prepareDependencies({ source, target }, { platform: 'linux', freeBytes: plenty, clone });
    expect(result.method).toBe('symlink');
    expect(clone).not.toHaveBeenCalled();
  });

  it.each(['package.json', 'package-lock.json'])('refuses mismatched %s before provisioning dependencies', async (file) => {
    const { source, target } = await fixture();
    await writeFile(join(target, file), '{}\n');
    const clone = vi.fn(copyFixture);
    await expect(prepareDependencies({ source, target }, { platform: 'darwin', freeBytes: plenty, clone })).rejects.toThrow();
    expect(clone).not.toHaveBeenCalled();
    await onlyManifests(target);
    expect(await readFile(join(source, 'node_modules', 'fixture', 'index.js'), 'utf8')).toContain('42');
  });

  it('refuses missing lockfiles rather than assuming installed dependencies match', async () => {
    const { source, target } = await fixture();
    await rm(join(target, 'package-lock.json'));
    await expect(prepareDependencies({ source, target }, { freeBytes: plenty })).rejects.toThrow();
    await absent(join(target, 'node_modules'));
  });

  it('refuses a source without installed dependencies', async () => {
    const { source, target } = await fixture();
    await rm(join(source, 'node_modules'), { recursive: true });
    await expect(prepareDependencies({ source, target }, { freeBytes: plenty })).rejects.toThrow();
    await onlyManifests(target);
  });

  it('refuses an identical source and target even through a directory alias', async () => {
    const { root, source } = await fixture();
    const alias = join(root, 'alias');
    await symlink(source, alias);
    await expect(prepareDependencies({ source, target: alias }, { freeBytes: plenty })).rejects.toThrow();
    expect(await readFile(join(source, 'node_modules', 'fixture', 'index.js'), 'utf8')).toContain('42');
  });

  it.each(['directory', 'symlink'])('preserves an existing target node_modules %s', async (kind) => {
    const { source, target } = await fixture();
    const modules = join(target, 'node_modules');
    if (kind === 'directory') {
      await mkdir(modules);
      await writeFile(join(modules, 'owned'), 'preserve');
    } else {
      await symlink(join(source, 'node_modules'), modules);
    }
    await expect(prepareDependencies({ source, target }, { freeBytes: plenty })).rejects.toThrow();
    if (kind === 'directory') expect(await readFile(join(modules, 'owned'), 'utf8')).toBe('preserve');
    else expect((await lstat(modules)).isSymbolicLink()).toBe(true);
  });

  it('preserves the 20 GiB disk floor before any clone starts', async () => {
    const { source, target } = await fixture();
    const clone = vi.fn(copyFixture);
    await expect(prepareDependencies({ source, target }, {
      platform: 'darwin', freeBytes: async () => FLOOR - 1, clone,
    })).rejects.toThrow();
    expect(clone).not.toHaveBeenCalled();
    await onlyManifests(target);
  });

  it('accepts the exact disk floor', async () => {
    const { source, target } = await fixture();
    const result = await prepareDependencies({ source, target }, {
      platform: 'linux', freeBytes: async () => FLOOR,
    });
    expect(result.method).toBe('symlink');
  });

  it('removes prepared dependencies if the post-preparation disk floor fails', async () => {
    const { source, target } = await fixture();
    let readings = 0;
    await expect(prepareDependencies({ source, target }, {
      platform: 'darwin', clone: copyFixture,
      freeBytes: async () => ++readings === 1 ? FLOOR + 1024 : FLOOR - 1,
    })).rejects.toThrow();
    expect(readings).toBeGreaterThanOrEqual(2);
    await onlyManifests(target);
    expect(await readFile(join(source, 'node_modules', 'fixture', 'index.js'), 'utf8')).toContain('42');
  });

  it.each([NaN, Infinity, -1, 'unknown', null])('rejects invalid disk availability %s', async (available) => {
    const { source, target } = await fixture();
    await expect(prepareDependencies({ source, target }, { freeBytes: async () => available })).rejects.toThrow();
    await onlyManifests(target);
  });

  it.each([0, -1, NaN, Infinity, 10_001, 1.5])('rejects invalid clone timeout %s', async (cloneTimeoutMs) => {
    const { source, target } = await fixture();
    await expect(prepareDependencies({ source, target, cloneTimeoutMs }, { freeBytes: plenty })).rejects.toThrow();
    await onlyManifests(target);
  });

  it('rolls back its published directory if disk drops below the floor after publication', async () => {
    const { source, target } = await fixture();
    let readings = 0;
    await expect(prepareDependencies({ source, target }, {
      platform: 'darwin', clone: copyFixture,
      freeBytes: async () => ++readings < 3 ? FLOOR + 1024 : FLOOR - 1,
    })).rejects.toThrow();
    expect(readings).toBe(3);
    await onlyManifests(target);
    expect(await readFile(join(source, 'node_modules', 'fixture', 'index.js'), 'utf8')).toContain('42');
  });

  it('rolls back its published symlink without deleting the shared source', async () => {
    const { source, target } = await fixture();
    let readings = 0;
    await expect(prepareDependencies({ source, target }, {
      platform: 'linux',
      freeBytes: async () => ++readings < 3 ? FLOOR + 1024 : FLOOR - 1,
    })).rejects.toThrow();
    await onlyManifests(target);
    expect(await readFile(join(source, 'node_modules', 'fixture', 'index.js'), 'utf8')).toContain('42');
  });

  it('refuses source dependency symlinks with unproven manifest identity', async () => {
    const { root, source, target } = await fixture();
    const external = join(root, 'external-dependencies');
    await mkdir(external);
    await writeFile(join(external, 'owned'), 'preserve');
    await rm(join(source, 'node_modules'), { recursive: true });
    await symlink(external, join(source, 'node_modules'));
    await expect(prepareDependencies({ source, target }, { freeBytes: plenty })).rejects.toThrow();
    await onlyManifests(target);
    expect(await readFile(join(external, 'owned'), 'utf8')).toBe('preserve');
  });

  it('refuses manifests changed while cloning and removes its private staging', async () => {
    const { source, target } = await fixture();
    await expect(prepareDependencies({ source, target }, {
      platform: 'darwin', freeBytes: plenty,
      clone: async (from: string, to: string) => {
        await copyFixture(from, to);
        await writeFile(join(target, 'package-lock.json'), '{}');
      },
    })).rejects.toThrow();
    await onlyManifests(target);
  });

  it('preserves a target dependency directory created by another writer during cloning', async () => {
    const { source, target } = await fixture();
    await expect(prepareDependencies({ source, target }, {
      platform: 'darwin', freeBytes: plenty,
      clone: async (from: string, to: string) => {
        await copyFixture(from, to);
        await mkdir(join(target, 'node_modules'));
        await writeFile(join(target, 'node_modules', 'owned'), 'preserve');
      },
    })).rejects.toThrow();
    expect(await readFile(join(target, 'node_modules', 'owned'), 'utf8')).toBe('preserve');
    expect((await readdir(target)).sort()).toEqual(['node_modules', 'package-lock.json', 'package.json']);
  });

  it('fails closed when disk availability cannot be read', async () => {
    const { source, target } = await fixture();
    await expect(prepareDependencies({ source, target }, {
      freeBytes: async () => { throw new Error('statfs unavailable'); },
    })).rejects.toThrow();
    await onlyManifests(target);
  });

  it('rejects duplicate preparation without disturbing the owner of the target lock', async () => {
    const { source, target } = await fixture();
    const entered = deferred();
    const release = deferred();
    const first = prepareDependencies({ source, target }, {
      platform: 'darwin', freeBytes: plenty,
      clone: async (from: string, to: string) => { entered.resolve(); await release.promise; await copyFixture(from, to); },
    });
    try {
      await entered.promise;
      await expect(prepareDependencies({ source, target }, { platform: 'linux', freeBytes: plenty })).rejects.toThrow();
      await absent(join(target, 'node_modules'));
    } finally {
      release.resolve();
      await first;
    }
    expect(await readFile(join(target, 'node_modules', '.bin', 'fixture'), 'utf8')).toContain('42');
  });

  it('allows all 20 independent preparations to enter cloning before any completes', async () => {
    const { root, source } = await fixture();
    const targets = await Promise.all(Array.from({ length: 20 }, (_, index) => targetAt(root, `parallel-${index}`)));
    const release = deferred();
    const allEntered = deferred();
    let entered = 0;
    const operations = targets.map((target) => prepareDependencies({ source, target }, {
      platform: 'darwin', freeBytes: plenty,
      clone: async (from: string, to: string) => {
        if (++entered === 20) allEntered.resolve();
        await release.promise;
        await copyFixture(from, to);
      },
    }));
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([allEntered.promise, new Promise<void>((resolve) => { timer = setTimeout(resolve, 2000); })]);
      expect(entered).toBe(20);
    } finally {
      if (timer) clearTimeout(timer);
      release.resolve();
      await Promise.all(operations);
    }
    expect(await Promise.all(targets.map(async (target) => (await lstat(join(target, 'node_modules'))).isDirectory()))).toEqual(Array(20).fill(true));
  });

  it('keeps the published result when the lock was already removed during preparation', async () => {
    const { source, target } = await fixture();
    let calls = 0;
    const freeBytes = async () => {
      calls += 1;
      if (calls === 3) await rm(join(target, '.bridge-dependencies.lock'), { recursive: true, force: true });
      return FLOOR + 1024 ** 3;
    };
    const result = await prepareDependencies({ source, target }, { freeBytes, platform: 'linux' });
    expect(result.method).toBe('symlink');
    expect(calls).toBe(3);
    expect((await lstat(join(target, 'node_modules'))).isSymbolicLink()).toBe(true);
    await absent(join(target, '.bridge-dependencies.lock'));
  });

  it('runs the CLI when invoked through a symlinked path', async () => {
    const { root } = await fixture();
    const linked = join(root, 'linked-bridge-worktree.mjs');
    await symlink(helper, linked);
    let caught: unknown;
    try {
      await run(process.execPath, [linked], { env: { HOME: process.env.HOME }, timeout: 10_000 });
    } catch (error) { caught = error; }
    expect(caught).toMatchObject({ code: 2 });
  });

  it('rejects incomplete CLI arguments without starting preparation', async () => {
    let caught: unknown;
    try {
      await run(process.execPath, [helper], { env: { HOME: process.env.HOME }, timeout: 10_000 });
    } catch (error) { caught = error; }
    expect(caught).toMatchObject({ code: 2, stdout: '' });
    expect((caught as { stderr: string }).stderr).toMatch(/^Usage: node scripts\/bridge-worktree\.mjs SOURCE_CHECKOUT TARGET_WORKTREE\n$/);
  });

  it.skipIf(process.platform !== 'darwin')('kills a native clone at its deadline and publishes only a clean symlink fallback', { timeout: 30_000 }, async () => {
    const { source, target } = await fixture();
    const result = await prepareDependencies({ source, target, cloneTimeoutMs: 1 }, { freeBytes: plenty });
    expect(result.method).toBe('symlink');
    expect(result.durationMs).toBeLessThan(15_000);
    expect((await lstat(join(target, 'node_modules'))).isSymbolicLink()).toBe(true);
    expect(await realpath(join(target, 'node_modules'))).toBe(await realpath(join(source, 'node_modules')));
    expect((await readdir(target)).sort()).toEqual(['node_modules', 'package-lock.json', 'package.json']);
    expect(await readFile(join(source, 'node_modules', 'fixture', 'index.js'), 'utf8')).toContain('42');
  });

  it.skipIf(process.platform !== 'darwin')('performs a real APFS clone in under 15 seconds and isolates later writes', { timeout: 30_000 }, async () => {
    const { source, target } = await fixture();
    const result = await prepareDependencies({ source, target }, { freeBytes: plenty });
    expect(result.method).toBe('apfs-clone');
    expect(result.durationMs).toBeLessThan(15_000);
    const clonedFile = join(target, 'node_modules', 'fixture', 'index.js');
    expect((await lstat(clonedFile)).mode & 0o111).toBe(0o111);
    await writeFile(clonedFile, 'export const value = 99;\n');
    expect(await readFile(join(source, 'node_modules', 'fixture', 'index.js'), 'utf8')).toBe('export const value = 42;\n');
    expect(await readFile(join(target, 'node_modules', '.bin', 'fixture'), 'utf8')).toContain('99');
  });
});
