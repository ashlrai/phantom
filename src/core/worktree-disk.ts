/** Disk admission and copy-on-write dependency reuse for agent worktrees.
 * Async, injectable I/O keeps the console responsive and unit tests hermetic.
 * A disk check is an admission snapshot, not a reservation against other processes.
 */
import * as fs from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

export const DEFAULT_WORKTREE_FREE_BYTES = 5 * 1024 ** 3;
export interface WorktreeDiskOptions {
  fs?: typeof fs;
  minFreeBytes?: number;
}

export class WorktreeDiskError extends Error {
  readonly status = 409;
  readonly code = 'WORKTREE_DISK_REFUSED';
}

/** Check the destination volume, walking to its nearest existing ancestor. */
export async function assertWorktreeDiskSpace(destination: string, options: WorktreeDiskOptions = {}): Promise<void> {
  const io = options.fs ?? fs;
  const floor = options.minFreeBytes ?? (process.env['ASHLR_WORKTREE_MIN_FREE_BYTES'] === undefined
    ? DEFAULT_WORKTREE_FREE_BYTES : Number(process.env['ASHLR_WORKTREE_MIN_FREE_BYTES']));
  if (!Number.isSafeInteger(floor) || floor <= 0) throw new WorktreeDiskError('The worktree free-disk floor must be a positive integer in bytes.');
  let path = resolve(destination);
  for (;;) {
    try {
      const stat = await io.statfs(path, { bigint: true });
      if (stat.bsize <= 0n || stat.bavail < 0n) throw new Error('Invalid disk measurement');
      if (stat.bavail * stat.bsize < BigInt(floor)) {
        throw new WorktreeDiskError(`Not enough free disk space to create a worktree. Free at least ${Math.ceil(floor / 1024 ** 3)} GiB, then retry.`);
      }
      return;
    } catch (error) {
      if (error instanceof WorktreeDiskError) throw error;
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || dirname(path) === path) {
        throw new WorktreeDiskError('Could not measure free disk space. Worktree creation was refused; check the destination volume and retry.');
      }
      path = dirname(path);
    }
  }
}

export type DependencyReuseResult = 'cloned' | 'skipped';
const MANIFESTS = ['package.json', 'package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lock', 'bun.lockb'];

function within(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
}

/**
 * Clone only matching installations. Never hardlink writable dependencies:
 * an install or build in one worktree must not corrupt the source checkout.
 * FICLONE_FORCE deliberately skips unsupported/cross-device filesystems;
 * silently falling back to a full copy would defeat the disk guard.
 * Internal relative links (.bin, pnpm) survive; external workspace links do not.
 */
export async function reuseWorktreeNodeModules(source: string, destination: string, options: WorktreeDiskOptions = {}): Promise<DependencyReuseResult> {
  const io = options.fs ?? fs;
  const from = join(source, 'node_modules');
  const to = join(destination, 'node_modules');
  let stage: string | undefined;
  try {
    if (resolve(source) === resolve(destination)) return 'skipped';
    const info = await io.lstat(from);
    if (!info.isDirectory() || info.isSymbolicLink()) return 'skipped';
    try { await io.lstat(to); return 'skipped'; } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return 'skipped';
    }
    const readManifest = async (root: string, name: string): Promise<Buffer | null> => {
      try {
        const path = join(root, name);
        const stat = await io.lstat(path);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 32 * 1024 ** 2) throw new Error('Unsafe manifest');
        return await io.readFile(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
      }
    };
    const manifests: Array<Buffer | null> = [];
    for (const name of MANIFESTS) {
      const a = await readManifest(source, name);
      const b = await readManifest(destination, name);
      if (a === null ? b !== null : b === null || !a.equals(b)) return 'skipped';
      manifests.push(a);
    }
    if (!manifests[0] || !manifests.slice(1).some(Boolean)) return 'skipped';
    await assertWorktreeDiskSpace(destination, options);
    stage = await io.mkdtemp(join(destination, '.phantom-deps-'));
    let entries = 0;
    const clone = async (src: string, dst: string): Promise<void> => {
      if (++entries > 200_000) throw new Error('Dependency tree too large');
      const stat = await io.lstat(src);
      if (stat.isSymbolicLink()) {
        const target = await io.readlink(src);
        if (isAbsolute(target) || !within(from, resolve(dirname(src), target))) throw new Error('External dependency link');
        await io.symlink(target, dst);
      } else if (stat.isDirectory()) {
        await io.mkdir(dst);
        for (const name of await io.readdir(src)) await clone(join(src, name), join(dst, name));
      } else if (stat.isFile()) {
        await io.copyFile(src, dst, constants.COPYFILE_FICLONE_FORCE | constants.COPYFILE_EXCL);
      } else throw new Error('Unsupported dependency entry');
    };
    const tree = join(stage, 'node_modules');
    await clone(from, tree);
    // An install may have changed either checkout while we cloned it.
    for (let i = 0; i < MANIFESTS.length; i += 1) {
      for (const root of [source, destination]) {
        const current = await readManifest(root, MANIFESTS[i]!);
        const original = manifests[i];
        if (original ? !current?.equals(original) : current !== null) throw new Error('Manifest changed');
      }
    }
    await assertWorktreeDiskSpace(destination, options);
    try { await io.lstat(to); return 'skipped'; } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    await io.rename(tree, to);
    return 'cloned';
  } catch {
    // Reuse is an optimization. The repository's normal setup remains authoritative.
    return 'skipped';
  } finally {
    // A cleanup error must not orphan the already-created agent workspace by
    // failing its registration. Retain the private stage for manual recovery.
    if (stage) await io.rm(stage, { recursive: true, force: true }).catch(() => undefined);
  }
}
