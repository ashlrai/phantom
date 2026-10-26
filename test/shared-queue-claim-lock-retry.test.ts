/**
 * Shared-queue claims wait briefly for a busy queue lock.
 *
 * Every SharedStore mutation is a short read-modify-write under one lock file.
 * claimLeasesByLane used to try that lock exactly once, so when N agents
 * claimed at once every loser got an empty claim and sat out a whole tick
 * (scripts/daemon-throughput.mjs: 11 of 20 agents). A claim now retries for
 * a short bounded window; a lock that stays held still yields no claim.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  linkSync, lstatSync, mkdtempSync, readdirSync, readFileSync, rmSync, unlinkSync, utimesSync, writeFileSync,
} from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { verifiedProcessStartIdentity } from '../src/core/fleet/local-store-lock.js';
import { SharedStore } from '../src/core/fleet/shared-store.js';

let dir: string;

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'shared-claim-retry-')); });
afterEach(() => { vi.restoreAllMocks(); rmSync(dir, { recursive: true, force: true }); });

/** Hold the queue lock "in another process" and release it after `releaseMs`. */
async function holdLockFor(releaseMs: number): Promise<Worker> {
  const lockPath = join(dir, 'ashlr-fleet-queue.json.lock');
  writeFileSync(lockPath, `${JSON.stringify({ token: 'other-holder' })}\n`, { mode: 0o600 });
  const worker = new Worker(
    `const { parentPort, workerData } = require('node:worker_threads');
     const { unlinkSync } = require('node:fs');
     parentPort.postMessage('ready');
     setTimeout(() => { try { unlinkSync(workerData.lockPath); } catch {} parentPort.postMessage('released'); }, workerData.releaseMs);`,
    { eval: true, workerData: { lockPath, releaseMs } },
  );
  await new Promise<void>((resolve) => { worker.once('message', () => resolve()); });
  return worker;
}

describe('SharedStore claim under a briefly held queue lock', () => {
  it('claims once the competing holder releases within the retry window', async () => {
    const store = new SharedStore(dir, 60_000);
    expect(store.claimLeases(['warm'], 1, 'machine-A')).toHaveLength(1); // capability probe + queue init
    const worker = await holdLockFor(40);
    try {
      const claimed = store.claimLeases(['item-a'], 1, 'machine-B');
      expect(claimed.map((ref) => ref.itemId)).toEqual(['item-a']);
    } finally {
      await worker.terminate();
    }
  });

  it('still returns no claim when the lock stays held past the window', async () => {
    const store = new SharedStore(dir, 60_000);
    expect(store.claimLeases(['warm'], 1, 'machine-A')).toHaveLength(1);
    const worker = await holdLockFor(5_000);
    try {
      const started = Date.now();
      expect(store.claimLeases(['item-a'], 1, 'machine-B')).toEqual([]);
      expect(Date.now() - started).toBeLessThan(2_000);
    } finally {
      await worker.terminate();
    }
  });
});

describe('SharedStore stale lock left with a crashed holder\'s guard link', () => {
  // scripts/daemon-chaos.mjs: an agent SIGKILLed while committing the queue
  // (between pinLock and unpinLock) leaves `<lock>.commit-<pid>-<uuid>.guard`,
  // a hard link to the lock, and one killed in safelyUnlinkLock leaves an
  // `unlink-` guard. The lock's link count then stays 2, it never read as
  // stale, and every later claim on every machine came back empty for good.
  // An aged unlink guard is now dropped; an aged commit guard only with
  // same-host proof that its holder is dead.
  const lockPath = (): string => join(dir, 'ashlr-fleet-queue.json.lock');
  const UUID = '0b6f3c5e-8d2a-4c1e-9f3b-7a1d2e3f4a5b';
  const strand = (kind: 'commit' | 'unlink', pid: number, owner?: Record<string, unknown>): string => {
    writeFileSync(lockPath(), `${JSON.stringify({ token: 'stranded-holder' })}\n`, { mode: 0o600 });
    const stem = `${lockPath()}.${kind}-${pid}-${UUID}`;
    if (owner) writeFileSync(`${stem}.owner`, `${JSON.stringify(owner)}\n`, { mode: 0o600 });
    linkSync(lockPath(), `${stem}.guard`);
    return `${stem}.guard`;
  };
  // Above every pid_max (Linux caps it at 2^22, macOS at 99999): no process
  // can hold it, so kill(pid, 0) is ESRCH without spawning anything.
  const deadPid = (): number => 4_194_305;
  const warmStore = (): SharedStore => {
    const store = new SharedStore(dir, 1_000); // stale window: the 30 s floor
    expect(store.claimLeases(['warm'], 1, 'machine-A')).toHaveLength(1);
    return store;
  };
  const later = (): void => {
    const at = Date.now() + 61_000;
    vi.spyOn(Date, 'now').mockReturnValue(at);
  };
  const leftovers = (): string[] => readdirSync(dir).filter((name) => /\.(guard|owner)$/.test(name));

  it('drops an aged unlink guard by age alone', () => {
    const store = warmStore();
    strand('unlink', 424242);
    expect(store.claimLeases(['before'], 1, 'machine-B')).toEqual([]);
    later();
    expect(store.readHealth().lock?.recoveryRequired).toBe(false);
    expect(store.claimLeases(['after'], 1, 'machine-B').map((ref) => ref.itemId)).toEqual(['after']);
    expect(leftovers()).toEqual([]);
    expect(() => lstatSync(lockPath())).toThrow();
  });

  it('drops an aged commit guard whose same-host holder pid is gone', () => {
    const store = warmStore();
    const pid = deadPid();
    strand('commit', pid, { host: hostname(), pid });
    expect(store.claimLeases(['before'], 1, 'machine-B')).toEqual([]);
    later();
    expect(store.readHealth().lock?.recoveryRequired).toBe(false);
    expect(store.claimLeases(['after'], 1, 'machine-B').map((ref) => ref.itemId)).toEqual(['after']);
    expect(leftovers()).toEqual([]);
  });

  it('keeps an aged commit guard held by a live same-host committer (paused, not dead)', () => {
    const store = warmStore();
    const start = verifiedProcessStartIdentity(process.pid);
    const guard = strand('commit', process.pid, {
      host: hostname(), pid: process.pid, ...(start ? { startRef: start.ref, startSource: start.source } : {}),
    });
    later();
    expect(store.claimLeases(['busy'], 1, 'machine-B')).toEqual([]);
    expect(lstatSync(guard).nlink).toBe(2);
    expect(store.readHealth().lock?.recoveryRequired).toBe(true);
  });

  it('keeps an aged commit guard recorded on another host, even with a pid that is free here', () => {
    const store = warmStore();
    const pid = deadPid();
    const guard = strand('commit', pid, { host: `not-${hostname()}`, pid });
    later();
    expect(store.claimLeases(['busy'], 1, 'machine-B')).toEqual([]);
    expect(lstatSync(guard).nlink).toBe(2);
    expect(store.readHealth().lock?.recoveryRequired).toBe(true);
  });

  it('keeps an aged commit guard with no owner record (unprovable holder)', () => {
    const store = warmStore();
    const guard = strand('commit', deadPid());
    later();
    expect(store.claimLeases(['busy'], 1, 'machine-B')).toEqual([]);
    expect(lstatSync(guard).nlink).toBe(2);
    expect(store.readHealth().lock?.recoveryRequired).toBe(true);
  });

  it('keeps a lock whose guard is younger than the stale window', () => {
    const store = warmStore();
    const guard = strand('unlink', deadPid());
    // Only the lock is old: its mtime is backdated, the link (ctime) is fresh.
    const old = new Date(Date.now() - 120_000);
    utimesSync(lockPath(), old, old);
    expect(store.claimLeases(['busy'], 1, 'machine-B')).toEqual([]);
    expect(lstatSync(guard).nlink).toBe(2);
  });

  it('refuses to publish the queue once its commit pin was broken', () => {
    const store = warmStore();
    const internals = store as unknown as { pinLock(lock: unknown): string | null };
    const pinLock = internals.pinLock.bind(store);
    // Another acquirer drops our guard between pinLock and the rename.
    internals.pinLock = (lock: unknown): string | null => {
      const guard = pinLock(lock);
      if (guard) unlinkSync(guard);
      return guard;
    };
    expect(store.claimLeases(['lost'], 1, 'machine-B')).toEqual([]);
    const queue = readFileSync(join(dir, 'ashlr-fleet-queue.json'), 'utf8');
    expect(queue).not.toContain('"lost"');
    expect(queue).toContain('"warm"');
    expect(readdirSync(dir).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  it('writes an owner record beside every commit guard and removes both after the commit', () => {
    const store = warmStore();
    const internals = store as unknown as { writeQueue(q: unknown, pin?: unknown): boolean };
    const writeQueue = internals.writeQueue.bind(store);
    let seen: Record<string, unknown> | undefined;
    internals.writeQueue = (q: unknown, pin?: unknown): boolean => {
      const owner = readdirSync(dir).find((name) => name.endsWith('.owner'));
      if (owner) seen = JSON.parse(readFileSync(join(dir, owner), 'utf8')) as Record<string, unknown>;
      return writeQueue(q, pin);
    };
    expect(store.claimLeases(['next'], 1, 'machine-B')).toHaveLength(1);
    expect(seen).toMatchObject({ host: hostname(), pid: process.pid });
    expect(leftovers()).toEqual([]);
  });
});
