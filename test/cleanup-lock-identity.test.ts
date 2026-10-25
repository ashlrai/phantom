/**
 * Sandbox cleanup locks (`<sandboxes>/.cleanup-locks/<id>.lock`) are removed
 * only when the file at the path is still the one the remover judged. Inode
 * numbers are reused as soon as a file is freed, so a stale lock another
 * cleaner already replaced can share dev+ino with the new, live lock; the
 * identity therefore includes the change time, which a new file resets.
 *
 * HERMETIC: files live in a fresh tmp dir; no git, no network.
 */

import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { _cleanupLockUnlinkForTest } from '../src/core/sandbox/worktree.js';

let dir: string | null = null;
afterEach(() => {
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
  dir = null;
});

function lockPath(): string {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cleanup-lock-identity-'));
  return path.join(dir, 'sb.lock');
}

function waitForClockTick(): void {
  const start = Date.now();
  while (Date.now() - start < 20) { /* coarse ctime granularity */ }
}

describe('cleanup lock removal identity', () => {
  it('removes the lock it judged', () => {
    const p = lockPath();
    fs.writeFileSync(p, '{"pid":1}\n', { mode: 0o600 });
    const lock = _cleanupLockUnlinkForTest(p);
    lock.snapshot();
    expect(lock.unlink()).toBe(true);
    expect(fs.existsSync(p)).toBe(false);
  });

  it('refuses when the same inode now holds a different lock (reuse)', () => {
    const p = lockPath();
    fs.writeFileSync(p, '{"pid":1}\n', { mode: 0o600 });
    const lock = _cleanupLockUnlinkForTest(p);
    lock.snapshot();
    const ino = fs.lstatSync(p).ino;
    waitForClockTick();
    // Same dev+ino, new content: exactly what a reused inode looks like to dev+ino checks.
    fs.writeFileSync(p, '{"pid":2}\n');
    expect(fs.lstatSync(p).ino).toBe(ino);
    expect(lock.unlink()).toBe(false);
    expect(fs.readFileSync(p, 'utf8')).toBe('{"pid":2}\n');
  });

  it('refuses when the lock was replaced, whether or not the inode number came back', () => {
    const p = lockPath();
    fs.writeFileSync(p, '{"pid":1}\n', { mode: 0o600 });
    const lock = _cleanupLockUnlinkForTest(p);
    lock.snapshot();
    waitForClockTick();
    fs.unlinkSync(p);
    fs.writeFileSync(p, '{"pid":3}\n', { mode: 0o600 });
    expect(lock.unlink()).toBe(false);
    expect(fs.existsSync(p)).toBe(true);
  });

  it('never removes a symlink in the lock\'s place', () => {
    const p = lockPath();
    fs.writeFileSync(p, '{"pid":1}\n', { mode: 0o600 });
    const lock = _cleanupLockUnlinkForTest(p);
    lock.snapshot();
    const target = path.join(dir!, 'target');
    fs.renameSync(p, target);
    try {
      fs.symlinkSync(target, p);
    } catch {
      return; // symlinks unavailable (unprivileged Windows)
    }
    expect(lock.unlink()).toBe(false);
    expect(fs.lstatSync(p).isSymbolicLink()).toBe(true);
  });
});
