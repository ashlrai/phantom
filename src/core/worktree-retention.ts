import {
  closeSync, constants, fstatSync, lstatSync, openSync, opendirSync, readSync,
  realpathSync, type Stats,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';

export interface KeptWorktrees {
  paths: readonly string[];
  valid: boolean;
}

const INVALID_POLICY: KeptWorktrees = { paths: [], valid: false };
const MAX_POLICY_BYTES = 64 * 1024;
const sameObject = (a: Stats, b: Stats): boolean => a.dev === b.dev && a.ino === b.ino;
const sameSnapshot = (a: Stats, b: Stats): boolean => sameObject(a, b) &&
  a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;

/** Resolve existing aliases while retaining an absent worktree's final name. */
function pathIdentity(value: string): string | null {
  if (!isAbsolute(value) || value.includes('\0')) return null;
  let current = resolve(value);
  const missing: string[] = [];
  for (;;) {
    try {
      lstatSync(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return null;
      const parent = dirname(current);
      if (parent === current) return null;
      missing.unshift(basename(current));
      current = parent;
      continue;
    }
    try {
      const physical = realpathSync.native(current);
      if (missing.length && !lstatSync(physical).isDirectory()) return null;
      const identity = join(physical, ...missing);
      return process.platform === 'win32' ? identity.toLowerCase() : identity;
    } catch { return null; }
  }
}

/** Missing means no pins; an unreadable or malformed allowlist retains everything. */
export function readKeptWorktrees(): KeptWorktrees {
  const root = join(homedir(), '.ashlr');
  const file = join(root, 'kept-worktrees.json');
  let fd: number | undefined;
  try {
    let rootBefore: Stats;
    try { rootBefore = lstatSync(root); }
    catch (error) {
      return (error as NodeJS.ErrnoException).code === 'ENOENT' ? { paths: [], valid: true } : INVALID_POLICY;
    }
    if (!rootBefore.isDirectory() || rootBefore.isSymbolicLink()) return INVALID_POLICY;
    let before: Stats;
    try { before = lstatSync(file); }
    catch (error) {
      return (error as NodeJS.ErrnoException).code === 'ENOENT' && sameObject(rootBefore, lstatSync(root))
        ? { paths: [], valid: true } : INVALID_POLICY;
    }
    if (!before.isFile() || before.isSymbolicLink() || before.size > MAX_POLICY_BYTES) return INVALID_POLICY;
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    if (!sameSnapshot(before, fstatSync(fd))) return INVALID_POLICY;
    const bytes = Buffer.alloc(before.size + 1);
    let offset = 0;
    for (;;) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (count === 0) break;
      offset += count;
      if (offset > before.size) return INVALID_POLICY;
    }
    if (offset !== before.size) return INVALID_POLICY;
    const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, offset)));
    if (!sameSnapshot(before, fstatSync(fd)) || !sameSnapshot(before, lstatSync(file)) ||
      !sameObject(rootBefore, lstatSync(root))) return INVALID_POLICY;
    if (!Array.isArray(value) || value.some((item: unknown) =>
      typeof item !== 'string' || pathIdentity(item) === null)) return INVALID_POLICY;
    return { paths: [...new Set(value as string[])], valid: true };
  } catch { return INVALID_POLICY; }
  finally { if (fd !== undefined) closeSync(fd); }
}

/** Exact worktree pins, including aliases; uncertainty always preserves the checkout. */
export function isKeptWorktree(dir: string, policy: KeptWorktrees): boolean {
  if (!policy.valid) return true;
  const identity = pathIdentity(dir);
  if (identity === null) return true;
  for (const kept of policy.paths) {
    const candidate = pathIdentity(kept);
    if (candidate === null || candidate === identity) return true;
  }
  return false;
}

export interface WorktreeMeasurement {
  bytes: number;
  complete: boolean;
}

/**
 * Bounded logical-byte estimate, without following links or counting an inode
 * twice. deadlineMs is an absolute epoch-millisecond deadline shared by scans.
 * A partial result is never a full disk
 * inventory. Node lacks portable openat, so observed directory swaps fail closed.
 */
export function measureWorktreeBytes(
  dir: string,
  options: { maxEntries?: number; deadlineMs?: number } = {},
): WorktreeMeasurement {
  const result = { bytes: 0, complete: true };
  const maxEntries = options.maxEntries ?? 100_000;
  const deadline = options.deadlineMs ?? Date.now() + 2_000;
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 1 || !Number.isFinite(deadline) || deadline <= Date.now()) {
    return { bytes: 0, complete: false };
  }
  let visited = 0;
  const seen = new Set<string>();
  try {
    const original = lstatSync(dir);
    if (!original.isDirectory() || original.isSymbolicLink()) return { bytes: 0, complete: false };
    const root = realpathSync.native(dir);
    const pending = [root];
    while (pending.length) {
      if (Date.now() >= deadline || !sameObject(original, lstatSync(dir)) ||
        realpathSync.native(dir) !== root) return { ...result, complete: false };
      const current = pending.pop()!;
      const before = lstatSync(current);
      if (!before.isDirectory() || before.isSymbolicLink() || before.dev !== original.dev ||
        realpathSync.native(current) !== current) {
        result.complete = false;
        continue;
      }
      const directory = opendirSync(current);
      try {
        for (;;) {
          if (Date.now() >= deadline) return { ...result, complete: false };
          const entry = directory.readSync();
          if (!entry) break;
          if (++visited > maxEntries) return { ...result, complete: false };
          if (!sameObject(before, lstatSync(current)) || realpathSync.native(current) !== current) {
            return { ...result, complete: false };
          }
          const file = join(current, entry.name);
          try {
            const stat = lstatSync(file);
            if (stat.isSymbolicLink()) continue;
            if (stat.isDirectory()) pending.push(file);
            else if (stat.isFile()) {
              // The root .git file points at shared repository metadata, not build output.
              if (current === root && entry.name === '.git') continue;
              const key = `${stat.dev}:${stat.ino}`;
              if (!seen.has(key)) {
                seen.add(key);
                result.bytes += stat.size;
              }
            } else result.complete = false;
          } catch { result.complete = false; }
        }
      } finally { directory.closeSync(); }
      if (!sameSnapshot(before, lstatSync(current))) result.complete = false;
    }
  } catch { result.complete = false; }
  return result;
}
