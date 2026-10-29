import { constants } from 'node:fs';
import type * as fs from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { assertWorktreeDiskSpace, DEFAULT_WORKTREE_FREE_BYTES, reuseWorktreeNodeModules } from '../src/core/worktree-disk.js';

type Entry = { kind: 'dir' | 'file' | 'link' | 'special'; content?: string };
const source = resolve('/source');
const destination = resolve('/destination');
const missing = () => Object.assign(new Error('missing'), { code: 'ENOENT' });

/** No disk calls: directory entries, bytes, volumes and clone failures live in memory. */
function fakeFs() {
  const entries = new Map<string, Entry>();
  const add = (path: string, kind: Entry['kind'], content?: string) => entries.set(path, { kind, content });
  const requireEntry = (path: string): Entry => {
    const entry = entries.get(path);
    if (!entry) throw missing();
    return entry;
  };
  let free = BigInt(DEFAULT_WORKTREE_FREE_BYTES);
  let cloneError: string | null = null;
  let onClone: (() => void) | undefined;
  const io = {
    statfs: vi.fn(async (path: string) => {
      requireEntry(path);
      return { bsize: 1n, bavail: free, bfree: free + 100000n };
    }),
    lstat: vi.fn(async (path: string) => {
      const entry = requireEntry(path);
      return {
        isDirectory: () => entry.kind === 'dir',
        isSymbolicLink: () => entry.kind === 'link',
        isFile: () => entry.kind === 'file',
        size: Buffer.byteLength(entry.content ?? ''),
      };
    }),
    readFile: vi.fn(async (path: string) => Buffer.from(requireEntry(path).content ?? '')),
    readlink: vi.fn(async (path: string) => requireEntry(path).content!),
    readdir: vi.fn(async (path: string) => [...entries.keys()].filter((p) => p !== path && dirname(p) === path).map((p) => p.slice(path.length + 1))),
    mkdir: vi.fn(async (path: string) => {
      if (entries.has(path)) throw Object.assign(new Error('exists'), { code: 'EEXIST' });
      add(path, 'dir');
    }),
    mkdtemp: vi.fn(async (prefix: string) => { const path = `${prefix}fixture`; add(path, 'dir'); return path; }),
    symlink: vi.fn(async (target: string, path: string) => { add(path, 'link', target); }),
    copyFile: vi.fn(async (from: string, to: string, _mode: number) => {
      if (cloneError) throw Object.assign(new Error('clone unsupported'), { code: cloneError });
      add(to, 'file', requireEntry(from).content);
      onClone?.();
    }),
    rename: vi.fn(async (from: string, to: string) => {
      if (entries.has(to)) throw Object.assign(new Error('exists'), { code: 'EEXIST' });
      for (const [path, entry] of [...entries]) {
        if (path === from || path.startsWith(`${from}${sep}`)) {
          entries.set(to + path.slice(from.length), entry);
          entries.delete(path);
        }
      }
    }),
    rm: vi.fn(async (root: string) => {
      for (const path of entries.keys()) if (path === root || path.startsWith(`${root}${sep}`)) entries.delete(path);
    }),
  };
  add(source, 'dir');
  add(destination, 'dir');
  for (const root of [source, destination]) {
    add(join(root, 'package.json'), 'file', '{"dependencies":{"tool":"1.0.0"}}');
    add(join(root, 'package-lock.json'), 'file', '{"lockfileVersion":3}');
  }
  add(join(source, 'node_modules'), 'dir');
  add(join(source, 'node_modules', 'tool'), 'dir');
  add(join(source, 'node_modules', 'tool', 'cli.js'), 'file', 'original executable');
  return {
    io,
    options: { fs: io as unknown as typeof fs, minFreeBytes: DEFAULT_WORKTREE_FREE_BYTES },
    entries,
    add,
    setFree: (value: bigint) => { free = value; },
    failClone: (code: string) => { cloneError = code; },
    onClone: (fn: () => void) => { onClone = fn; },
  };
}

afterEach(() => vi.unstubAllEnvs());

describe('worktree disk admission with a fake filesystem', () => {
  it('measures the destination volume at its nearest existing ancestor, including the exact floor', async () => {
    const f = fakeFs();
    await expect(assertWorktreeDiskSpace(join(destination, 'repo', 'worktree'), f.options)).resolves.toBeUndefined();
    expect(f.io.statfs.mock.calls.map(([path]) => path)).toEqual([
      join(destination, 'repo', 'worktree'), join(destination, 'repo'), destination,
    ]);
    expect(f.io.statfs).toHaveBeenLastCalledWith(destination, { bigint: true });
  });

  it('uses available bytes rather than reserved free blocks', async () => {
    const f = fakeFs();
    f.setFree(BigInt(DEFAULT_WORKTREE_FREE_BYTES) - 1n);
    await expect(assertWorktreeDiskSpace(destination, f.options)).rejects.toMatchObject({ status: 409, code: 'WORKTREE_DISK_REFUSED' });
    expect(f.io.mkdir).not.toHaveBeenCalled();
  });

  it.each(['EACCES', 'ENOSYS', 'ENOTDIR'])('refuses unknown capacity (%s) without falling back to another volume', async (code) => {
    const f = fakeFs();
    f.io.statfs.mockRejectedValue(Object.assign(new Error('private filesystem path'), { code }));
    await expect(assertWorktreeDiskSpace(destination, f.options)).rejects.toThrow('Could not measure free disk space');
    expect(f.io.statfs).toHaveBeenCalledTimes(1);
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])('refuses invalid floor %s before measuring', async (minFreeBytes) => {
    const f = fakeFs();
    await expect(assertWorktreeDiskSpace(destination, { ...f.options, minFreeBytes })).rejects.toThrow('positive integer');
    expect(f.io.statfs).not.toHaveBeenCalled();
  });

  it('honors the environment floor and rejects malformed overrides', async () => {
    const f = fakeFs();
    f.setFree(20n);
    vi.stubEnv('ASHLR_WORKTREE_MIN_FREE_BYTES', '20');
    await expect(assertWorktreeDiskSpace(destination, { fs: f.options.fs })).resolves.toBeUndefined();
    vi.stubEnv('ASHLR_WORKTREE_MIN_FREE_BYTES', 'not-bytes');
    await expect(assertWorktreeDiskSpace(destination, { fs: f.options.fs })).rejects.toThrow('positive integer');
  });

  it.each([{ bsize: 0n, bavail: 3n }, { bsize: 1n, bavail: -1n }])('refuses invalid filesystem measurements %o', async (stat) => {
    const f = fakeFs();
    f.io.statfs.mockResolvedValue({ ...stat, bfree: 10n });
    await expect(assertWorktreeDiskSpace(destination, f.options)).rejects.toThrow('Could not measure free disk space');
  });

  it('stops walking at the filesystem root when no ancestor can be measured', async () => {
    const f = fakeFs();
    f.io.statfs.mockRejectedValue(missing());
    await expect(assertWorktreeDiskSpace(destination, f.options)).rejects.toThrow('Could not measure free disk space');
    expect(f.io.statfs.mock.calls.at(-1)?.[0]).toBe(dirname(destination));
  });
});

describe('copy-on-write dependency reuse with a fake filesystem', () => {
  it('clones matching dependencies with exclusive forced reflinks and preserves internal .bin links', async () => {
    const f = fakeFs();
    f.add(join(source, 'node_modules', '.bin'), 'dir');
    f.add(join(source, 'node_modules', '.bin', 'tool'), 'link', '../tool/cli.js');
    await expect(reuseWorktreeNodeModules(source, destination, f.options)).resolves.toBe('cloned');
    expect(f.io.copyFile).toHaveBeenCalledWith(
      join(source, 'node_modules', 'tool', 'cli.js'),
      join(destination, '.phantom-deps-fixture', 'node_modules', 'tool', 'cli.js'),
      constants.COPYFILE_FICLONE_FORCE | constants.COPYFILE_EXCL,
    );
    expect(f.entries.get(join(destination, 'node_modules', '.bin', 'tool'))).toEqual({ kind: 'link', content: '../tool/cli.js' });
    expect(f.entries.get(join(destination, 'node_modules', 'tool', 'cli.js'))?.content).toBe('original executable');
    expect(f.entries.has(join(destination, '.phantom-deps-fixture'))).toBe(false);
    f.add(join(destination, 'node_modules', 'tool', 'cli.js'), 'file', 'agent edited');
    expect(f.entries.get(join(source, 'node_modules', 'tool', 'cli.js'))?.content).toBe('original executable');
  });

  it.each(['EXDEV', 'ENOTSUP', 'ENOSPC'])('cleans an incomplete clone on %s without copying or linking a fallback', async (code) => {
    const f = fakeFs();
    f.failClone(code);
    await expect(reuseWorktreeNodeModules(source, destination, f.options)).resolves.toBe('skipped');
    expect(f.io.copyFile).toHaveBeenCalledTimes(1);
    expect(f.io.rename).not.toHaveBeenCalled();
    expect(f.io.rm).toHaveBeenCalledWith(join(destination, '.phantom-deps-fixture'), { recursive: true, force: true });
    expect(f.entries.has(join(destination, 'node_modules'))).toBe(false);
    expect(f.entries.get(join(source, 'node_modules', 'tool', 'cli.js'))?.content).toBe('original executable');
  });

  it.each(['../../outside', '/outside'])('rejects external dependency link %s and leaves no partial installation', async (target) => {
    const f = fakeFs();
    f.add(join(source, 'node_modules', 'external'), 'link', target);
    await expect(reuseWorktreeNodeModules(source, destination, f.options)).resolves.toBe('skipped');
    expect(f.entries.has(join(destination, 'node_modules'))).toBe(false);
    expect(f.io.symlink).not.toHaveBeenCalled();
  });

  it('rejects a symlinked node_modules root', async () => {
    const f = fakeFs();
    f.add(join(source, 'node_modules'), 'link', '/external');
    await expect(reuseWorktreeNodeModules(source, destination, f.options)).resolves.toBe('skipped');
    expect(f.io.mkdtemp).not.toHaveBeenCalled();
  });

  it('leaves an existing destination installation untouched', async () => {
    const f = fakeFs();
    f.add(join(destination, 'node_modules'), 'dir');
    f.add(join(destination, 'node_modules', 'keep'), 'file', 'existing');
    await expect(reuseWorktreeNodeModules(source, destination, f.options)).resolves.toBe('skipped');
    expect(f.entries.get(join(destination, 'node_modules', 'keep'))?.content).toBe('existing');
    expect(f.io.mkdtemp).not.toHaveBeenCalled();
    expect(f.io.rm).not.toHaveBeenCalled();
  });

  it.each(['package.json', 'package-lock.json'])('requires identical %s before cloning', async (manifest) => {
    const f = fakeFs();
    f.add(join(destination, manifest), 'file', 'different');
    await expect(reuseWorktreeNodeModules(source, destination, f.options)).resolves.toBe('skipped');
    expect(f.io.copyFile).not.toHaveBeenCalled();
  });

  it('requires a lockfile on both sides', async () => {
    const f = fakeFs();
    for (const root of [source, destination]) f.entries.delete(join(root, 'package-lock.json'));
    await expect(reuseWorktreeNodeModules(source, destination, f.options)).resolves.toBe('skipped');
    expect(f.io.mkdtemp).not.toHaveBeenCalled();
  });

  it.each([source, destination])('rejects a manifest changed during cloning in %s', async (root) => {
    const f = fakeFs();
    f.onClone(() => { f.add(join(root, 'package-lock.json'), 'file', 'changed'); });
    await expect(reuseWorktreeNodeModules(source, destination, f.options)).resolves.toBe('skipped');
    expect(f.io.rename).not.toHaveBeenCalled();
    expect(f.entries.has(join(destination, '.phantom-deps-fixture'))).toBe(false);
  });

  it('does not replace an installation created while cloning', async () => {
    const f = fakeFs();
    f.onClone(() => { f.add(join(destination, 'node_modules'), 'dir'); });
    await expect(reuseWorktreeNodeModules(source, destination, f.options)).resolves.toBe('skipped');
    expect(f.io.rename).not.toHaveBeenCalled();
    expect(f.entries.has(join(destination, 'node_modules'))).toBe(true);
  });

  it('refuses to publish a clone if the disk falls below the floor while copying', async () => {
    const f = fakeFs();
    f.onClone(() => { f.setFree(0n); });
    await expect(reuseWorktreeNodeModules(source, destination, f.options)).resolves.toBe('skipped');
    expect(f.io.rename).not.toHaveBeenCalled();
    expect(f.entries.has(join(destination, '.phantom-deps-fixture'))).toBe(false);
  });

  it('keeps a usable clone even when private staging cleanup fails', async () => {
    const f = fakeFs();
    f.io.rm.mockRejectedValue(Object.assign(new Error('cleanup denied'), { code: 'EACCES' }));
    await expect(reuseWorktreeNodeModules(source, destination, f.options)).resolves.toBe('cloned');
    expect(f.entries.get(join(destination, 'node_modules', 'tool', 'cli.js'))?.content).toBe('original executable');
    expect(f.io.rm).toHaveBeenCalledWith(join(destination, '.phantom-deps-fixture'), { recursive: true, force: true });
    expect(f.entries.has(join(destination, '.phantom-deps-fixture'))).toBe(true);
  });

});
