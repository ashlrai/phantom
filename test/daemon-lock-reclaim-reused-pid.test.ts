/**
 * A daemon.lock left behind by a SIGKILLed / rebooted daemon must be
 * reclaimable when its pid has since been REUSED by an unrelated process.
 *
 * Before: `acquireDaemonLock` reclaimed only on ESRCH, so a lock whose pid now
 * names any other live process (the pid-850 shape after a reboot) refused
 * every restart forever — `runDaemon` returned `daemon-singleton-lock-busy`
 * and `ashlr daemon doctor --clear-stale`, the fix `daemon status` prints,
 * refused too ("the daemon lock could not be taken"). Only a hand `rm` of the
 * lock recovered. HOME is isolated per worker (test/setup/home.ts).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { acquireDaemonLock, daemonLockPath, releaseDaemonLock } from '../src/core/daemon/state.js';

const children: ChildProcess[] = [];

afterEach(() => {
  for (const child of children.splice(0)) child.kill('SIGKILL');
  rmSync(daemonLockPath(), { force: true });
});

function liveUnrelatedPid(): number {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60_000)'], { stdio: 'ignore' });
  children.push(child);
  if (typeof child.pid !== 'number') throw new Error('could not spawn');
  return child.pid;
}

function writeLock(pid: number, acquiredAt: string, heartbeatAt: string): void {
  const path = daemonLockPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ pid, token: 'crashed-owner', hostname: 'h', acquiredAt, heartbeatAt }) + '\n');
}

const posix = process.platform !== 'win32';

describe.skipIf(!posix)('daemon lock reclaim after pid reuse', () => {
  it('reclaims a long-dead owner lock whose pid now belongs to a process started after the lock was taken', () => {
    // The crashed daemon took the lock (and last heartbeat) days ago; the pid
    // now names a process that started seconds ago, so it cannot be the owner.
    writeLock(liveUnrelatedPid(), '2026-01-01T00:00:00.000Z', '2026-01-01T00:05:00.000Z');
    const acquired = acquireDaemonLock();
    expect(acquired.acquired).toBe(true);
    if (acquired.acquired) {
      expect(acquired.replacedStale).toBe(true);
      expect(releaseDaemonLock(acquired.lock)).toBe(true);
    }
  });

  it('never reclaims while the named process may be the owner (started before the lock was taken)', () => {
    const pid = liveUnrelatedPid();
    const future = new Date(Date.now() + 60_000).toISOString();
    // Stale heartbeat but acquiredAt AFTER the process started: identity unprovable.
    writeLock(pid, future, '2026-01-01T00:05:00.000Z');
    expect(acquireDaemonLock({ staleMs: 0 }).acquired).toBe(false);
    expect(JSON.parse(readFileSync(daemonLockPath(), 'utf8')).token).toBe('crashed-owner');
  });

  it('never reclaims a lock whose heartbeat is fresh, even when the start time disagrees', () => {
    const now = new Date().toISOString();
    writeLock(liveUnrelatedPid(), '2026-01-01T00:00:00.000Z', now);
    expect(acquireDaemonLock().acquired).toBe(false);
  });

  it('never reclaims a live owner whose heartbeat stalled (e.g. a blocked event loop)', () => {
    // This process started before it "took" the lock now: it may be the owner.
    writeLock(process.pid, new Date().toISOString(), '2026-01-01T00:05:00.000Z');
    expect(acquireDaemonLock({ staleMs: 0 }).acquired).toBe(false);
  });
});
