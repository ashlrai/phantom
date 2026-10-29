import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { controlQueue, type QueueSnapshot } from '../src/core/queue/controller.js';
import { writeQueueDecision } from '../src/core/queue/store.js';

let directory: string;
let root: string;

function input(observedAt = 1000): QueueSnapshot {
  return {
    schema: 'phantom-queue-snapshot/v1', stream: 'store-test', observedAt,
    windowSeconds: 10, plannerRate: 1, targetUtilization: 0.8,
    pools: [{ id: 'pool', slots: 4, available: true }],
    stages: [{ id: 'build', kind: 'work', pool: 'pool', queued: 10,
      previousQueued: 4, arrivals: 10, slots: 1, minSlots: 1, maxSlots: 4,
      tier: 'standard', tiers: [{ id: 'standard', serviceRate: 1 }],
      impact: false, batchSize: 1, batches: [] }],
  };
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'phantom-queue-store-'));
  root = join(directory, 'store');
});
afterEach(() => { rmSync(directory, { recursive: true, force: true }); });

describe('queue decision store', () => {
  it('writes one private atomic envelope for controller, bandit and LP consumers', async () => {
    const decision = controlQueue(input());
    const result = await writeQueueDecision(root, decision);
    expect(result).toEqual({ path: join(root, 'store-test', '1000.json'), replayed: false });
    const stored = JSON.parse(readFileSync(result.path, 'utf8'));
    expect(stored).toEqual(decision);
    expect(stored.bandit.decisionId).toBe(stored.id);
    expect(stored.lpInputs.decisionId).toBe(stored.id);
    expect(stored.bandit.reward).toBeNull();
    expect(readdirSync(root)).toEqual(['store-test']);
    expect(readdirSync(join(root, 'store-test'))).toEqual(['1000.json']);
    if (process.platform !== 'win32') {
      expect(lstatSync(root).mode & 0o777).toBe(0o700);
      expect(lstatSync(join(root, 'store-test')).mode & 0o777).toBe(0o700);
      expect(lstatSync(result.path).mode & 0o777).toBe(0o600);
    }
  });

  it('returns identical replays without rewriting the existing file', async () => {
    const decision = controlQueue(input());
    const first = await writeQueueDecision(root, decision);
    const before = lstatSync(first.path);
    expect(await writeQueueDecision(root, decision)).toEqual({ ...first, replayed: true });
    const after = lstatSync(first.path);
    expect(after.ino).toBe(before.ino);
    expect(after.mtimeMs).toBe(before.mtimeMs);
  });

  it('refuses conflicting evidence at an existing stream timestamp without overwriting it', async () => {
    const first = await writeQueueDecision(root, controlQueue(input()));
    const original = readFileSync(first.path, 'utf8');
    const changed = input(); changed.stages[0].queued++;
    await expect(writeQueueDecision(root, controlQueue(changed))).rejects.toThrow('conflicting');
    expect(readFileSync(first.path, 'utf8')).toBe(original);
    expect(readdirSync(root)).toEqual(['store-test']);
  });

  it('refuses new stale observations but allows an exact historical replay', async () => {
    const original = controlQueue(input());
    await writeQueueDecision(root, original);
    await writeQueueDecision(root, controlQueue(input(3000)));
    await expect(writeQueueDecision(root, controlQueue(input(2000)))).rejects.toThrow('out-of-order');
    expect(existsSync(join(root, 'store-test', '2000.json'))).toBe(false);
    expect((await writeQueueDecision(root, original)).replayed).toBe(true);
  });

  it('keeps independent stream clocks separate', async () => {
    await writeQueueDecision(root, controlQueue(input(3000)));
    const second = input(1000); second.stream = 'other';
    const result = await writeQueueDecision(root, controlQueue(second));
    expect(result.replayed).toBe(false);
    expect(result.path).toBe(join(root, 'other', '1000.json'));
  });

  it('rejects a modified decision before creating a store', async () => {
    const decision = controlQueue(input());
    decision.allocations[0].slots = 999;
    await expect(writeQueueDecision(root, decision)).rejects.toThrow('does not match');
    expect(existsSync(root)).toBe(false);
  });

  it('does not repair or overwrite corrupt recorded decisions', async () => {
    const decision = controlQueue(input());
    const result = await writeQueueDecision(root, decision);
    writeFileSync(result.path, '{corrupt');
    await expect(writeQueueDecision(root, decision)).rejects.toThrow('unreadable');
    expect(readFileSync(result.path, 'utf8')).toBe('{corrupt');
  });

  it('refuses a non-directory output without modifying it', async () => {
    writeFileSync(root, 'untouched');
    await expect(writeQueueDecision(root, controlQueue(input()))).rejects.toThrow();
    expect(readFileSync(root, 'utf8')).toBe('untouched');
  });

  it('refuses a symlinked store root before writing to its target', async () => {
    const target = join(directory, 'target');
    mkdirSync(target, { mode: 0o700 });
    symlinkSync(target, root, 'junction');
    await expect(writeQueueDecision(root, controlQueue(input()))).rejects.toThrow();
    expect(readdirSync(target)).toEqual([]);
    expect(lstatSync(root).isSymbolicLink()).toBe(true);
  });

  it('refuses a symlinked stream directory and releases its lock', async () => {
    mkdirSync(root, { mode: 0o700 });
    const target = join(directory, 'target');
    mkdirSync(target, { mode: 0o700 });
    symlinkSync(target, join(root, 'store-test'), 'junction');
    await expect(writeQueueDecision(root, controlQueue(input()))).rejects.toThrow();
    expect(readdirSync(target)).toEqual([]);
    expect(readdirSync(root)).toEqual(['store-test']);
  });

  it('refuses a directory at the observation path without leaving a temporary or lock', async () => {
    mkdirSync(join(root, 'store-test', '1000.json'), { recursive: true, mode: 0o700 });
    await expect(writeQueueDecision(root, controlQueue(input()))).rejects.toThrow('unreadable');
    expect(readdirSync(root)).toEqual(['store-test']);
    expect(readdirSync(join(root, 'store-test'))).toEqual(['1000.json']);
    expect(lstatSync(join(root, 'store-test', '1000.json')).isDirectory()).toBe(true);
  });
});
