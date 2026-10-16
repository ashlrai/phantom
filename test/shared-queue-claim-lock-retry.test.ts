/**
 * Shared-queue claims wait briefly for a busy queue lock.
 *
 * Every SharedStore mutation is a short read-modify-write under one lock file.
 * claimLeasesByLane used to try that lock exactly once, so when N agents
 * claimed at once every loser got an empty claim and sat out a whole tick
 * (scripts/daemon-throughput.mjs: 11 of 20 agents). A claim now retries for
 * a short bounded window; a lock that stays held still yields no claim.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { SharedStore } from '../src/core/fleet/shared-store.js';

let dir: string;

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'shared-claim-retry-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

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
