import { randomBytes } from 'node:crypto';
import { closeSync, constants, fstatSync, linkSync, lstatSync, mkdirSync, openSync, readSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import type { Stats } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { assurePrivateStoragePath } from '../util/private-storage.js';

const MARKER = /^planner-cycle-lock-v1 [a-f0-9]{32}\n$/;
const same = (a: { dev: number; ino: number }, b: { dev: number; ino: number }): boolean => a.dev === b.dev && a.ino === b.ino;
const owned = (uid: number): boolean => typeof process.getuid !== 'function' || uid === process.getuid();

// An untrusted writable ancestor could replace the root and split the lock domain.
function safeParents(root: string): boolean {
  if (process.platform === 'win32') return true; // ACL assurance checks the anchor.
  let current = dirname(root);
  for (;;) {
    const stat = lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.uid !== 0 && !owned(stat.uid)) ||
        ((stat.mode & 0o022) !== 0 && (stat.mode & 0o1000) === 0)) return false;
    const parent = dirname(current);
    if (parent === current) return true;
    current = parent;
  }
}

/** Single-host lock. An abandoned lock is never reclaimed automatically. */
export function acquirePlannerCycleLock(root: string): { state: 'acquired'; release: () => boolean } | { state: 'busy' | 'unsafe' } {
  let candidate: string | undefined;
  let identity: Stats | undefined;
  let linked: string | undefined;
  let acquired = false;
  let directory: string | undefined;
  let directoryIdentity: Stats | undefined;
  const removeOwned = (path: string): boolean => {
    try {
      if (!identity || !directory || !directoryIdentity || !same(lstatSync(directory), directoryIdentity)) return false;
      const named = lstatSync(path);
      if (!named.isFile() || !same(named, identity)) return false;
      unlinkSync(path);
      return true;
    } catch { return false; }
  };
  try {
    if (!isAbsolute(root) || root.includes('\0')) return { state: 'unsafe' };
    const original = lstatSync(root);
    if (!original.isDirectory() || original.isSymbolicLink() || !owned(original.uid) ||
        (process.platform !== 'win32' && (original.mode & 0o022) !== 0)) return { state: 'unsafe' };
    const canonical = realpathSync(root);
    if (!safeParents(canonical) || !same(original, lstatSync(canonical)) || !assurePrivateStoragePath(canonical, 'directory', 'inspect-owned', { anchorPath: dirname(canonical) }).ok) return { state: 'unsafe' };
    directory = join(canonical, '.planner-cycle');
    let created = false;
    try { mkdirSync(directory, { mode: 0o700 }); created = true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    directoryIdentity = lstatSync(directory);
    if (!directoryIdentity.isDirectory() || directoryIdentity.isSymbolicLink() || !owned(directoryIdentity.uid) ||
        (process.platform !== 'win32' && (directoryIdentity.mode & 0o7777) !== 0o700) ||
        !assurePrivateStoragePath(directory, 'directory', created ? 'secure-created' : 'inspect-existing', { anchorPath: canonical }).ok ||
        !same(original, lstatSync(canonical)) || !same(directoryIdentity, lstatSync(directory))) return { state: 'unsafe' };

    const lock = join(directory, 'apply.lock');
    const token = randomBytes(16).toString('hex');
    candidate = join(directory, `.${token}.tmp`);
    const fd = openSync(candidate, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
    try {
      identity = fstatSync(fd);
      writeFileSync(fd, `planner-cycle-lock-v1 ${token}\n`);
      if (!identity.isFile() || !owned(identity.uid) || (process.platform !== 'win32' && (identity.mode & 0o7777) !== 0o600) ||
          !assurePrivateStoragePath(candidate, 'file', 'secure-created', { anchorPath: directory }).ok ||
          !same(directoryIdentity, lstatSync(directory)) || !same(identity, lstatSync(candidate))) return { state: 'unsafe' };
      try { linkSync(candidate, lock); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        const existing = lstatSync(lock);
        if (!existing.isFile() || existing.isSymbolicLink() || !owned(existing.uid) || existing.nlink > 2 ||
            (process.platform !== 'win32' && (existing.mode & 0o7777) !== 0o600) || existing.size > 64) return { state: 'unsafe' };
        const lockFd = openSync(lock, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
        try {
          const bytes = Buffer.alloc(65);
          if (!same(existing, fstatSync(lockFd)) || readSync(lockFd, bytes, 0, bytes.length, 0) !== existing.size ||
              !MARKER.test(bytes.subarray(0, existing.size).toString('utf8')) ||
              !assurePrivateStoragePath(lock, 'file', 'inspect-existing', { anchorPath: directory }).ok ||
              !same(existing, lstatSync(lock)) || !same(directoryIdentity, lstatSync(directory))) return { state: 'unsafe' };
        } finally { closeSync(lockFd); }
        return { state: 'busy' };
      }
      linked = lock;
      if (!same(identity, lstatSync(lock)) || !same(directoryIdentity, lstatSync(directory)) || !same(original, lstatSync(canonical))) return { state: 'unsafe' };
      acquired = true;
      return { state: 'acquired', release: () => removeOwned(lock) };
    } finally { closeSync(fd); }
  } catch { return { state: 'unsafe' }; }
  finally { if (linked && !acquired) removeOwned(linked); if (candidate) removeOwned(candidate); }
}
