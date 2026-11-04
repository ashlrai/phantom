import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cmdFleetResetAwait } from '../src/cli/fleet-reset-await.js';
import { awaitResetEvidence } from '../src/core/fleet/reset-evidence-await.js';
import type { UsageResetRow, UsageResetsV1 } from '../src/core/fleet/usage-reset-detect.js';

const start = Date.parse('2026-11-01T00:00:00Z');
const row = (over: Partial<UsageResetRow> = {}): UsageResetRow => ({ lane: 'alpha', held: true,
  heldReason: 'secret reason /private/path', heldUntil: null, holdSince: null, heldBy: 'autobackoff',
  usedPct: 1, readingAsOf: new Date(start + 1).toISOString(), resetAt: null,
  state: 'reset-detected', releasable: true, tell: 'secret tell /private/path', ...over });
const snapshot = (rows = [row()], sourceState: UsageResetsV1['sourceState'] = 'healthy'): UsageResetsV1 =>
  ({ v: 1, generatedAt: new Date(start).toISOString(), sourceState, rows });
const opts = { lane: 'alpha', timeoutMs: 100, pollMs: 20 };
const now = () => Date.now() - start;
let dir: string;
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(start); dir = mkdtempSync(join(tmpdir(), 'reset-await-')); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); rmSync(dir, { recursive: true, force: true }); });

it('observes a fresh healthy reset and emits only safe evidence', async () => {
  const lines: string[] = [];
  const read = vi.fn(async () => snapshot());
  const pending = cmdFleetResetAwait(['--lane', 'alpha', '--timeout-ms', '100', '--poll-ms', '20', '--runs-dir', dir, '--json'],
    { read, now, emit: line => { lines.push(line); } });
  await vi.advanceTimersByTimeAsync(21);
  expect(await pending).toBe(0);
  expect(read).toHaveBeenCalledWith({ runsDir: dir });
  expect(JSON.parse(lines[0]!)).toMatchObject({ outcome: 'observed', checks: 2, authority: 'none' });
  expect(lines[0]).not.toMatch(/reason|tell|private|runsDir/);
});

it.each([
  ['old', snapshot([row({ readingAsOf: new Date(start).toISOString() })])],
  ['manual', snapshot([row({ heldBy: 'manual' })])],
  ['degraded', snapshot([row()], 'degraded')],
  ['expired', snapshot([row({ state: 'hold-expired' })])],
  ['open', snapshot([row({ held: false, state: 'open' })])],
  ['missing', snapshot([])],
  ['absent reading', snapshot([row({ readingAsOf: null })])],
])('does not accept %s evidence', async (_label, data) => {
  const read = vi.fn(async () => data);
  const pending = awaitResetEvidence(opts, { read, now });
  await vi.advanceTimersByTimeAsync(100);
  expect((await pending).outcome).toBe('deadline');
  expect(read.mock.calls.length).toBeGreaterThan(0);
});

it('accepts reset-time-passed after a fresh reading arrives', async () => {
  const pending = awaitResetEvidence(opts, { now, read: async () => snapshot([row({ state: 'reset-time-passed' })]) });
  await vi.advanceTimersByTimeAsync(21);
  expect((await pending).outcome).toBe('observed');
});

it('rejects invalid and duplicate flags before reading', async () => {
  const read = vi.fn(async () => snapshot());
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  for (const args of [[], ['--lane', 'a', '--timeout-ms', '0'], ['--lane', 'a', '--lane', 'b', '--timeout-ms', '1'],
    ['--lane', 'a', '--timeout-ms', '1', '--json', '--json'], ['--lane', 'a', '--timeout-ms', '1', '--poll-ms', '3600001'],
    ['--lane', 'a', '--timeout-ms', '86400001'], ['--lane', 'a', '--timeout-ms', '1', '--runs-dir', 'relative']]) {
    expect(await cmdFleetResetAwait(args, { read })).toBe(2);
  }
  expect(read).not.toHaveBeenCalled();
});

it('bounds a pending read and handles its late rejection', async () => {
  let reject!: (reason: Error) => void;
  const pending = awaitResetEvidence(opts, { now, read: () => new Promise((_resolve, fail) => { reject = fail; }) });
  await vi.advanceTimersByTimeAsync(100);
  expect((await pending).outcome).toBe('deadline');
  reject(new Error('private')); await Promise.resolve();
});

it.each(['read', 'sleep'])('cancels during %s and cleans listeners', async phase => {
  const before = process.listenerCount('SIGINT');
  const controller = new AbortController();
  const read = phase === 'read' ? () => new Promise<UsageResetsV1>(() => {}) : async () => snapshot([]);
  const pending = awaitResetEvidence({ ...opts, signal: controller.signal }, { read, now });
  await vi.advanceTimersByTimeAsync(1);
  controller.abort();
  expect((await pending).outcome).toBe('cancelled');
  expect(process.listenerCount('SIGINT')).toBe(before);
  expect(vi.getTimerCount()).toBe(0);
});

it('returns failure for a rejected reader without exposing its error', async () => {
  const result = await awaitResetEvidence(opts, { now, read: async () => { throw new Error('/private/path'); } });
  expect(result.outcome).toBe('failed');
  expect(JSON.stringify(result)).not.toContain('/private/path');
});
