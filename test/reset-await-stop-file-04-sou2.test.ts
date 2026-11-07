import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cmdFleetResetAwait } from '../src/cli/fleet-reset-await.js';
import { awaitResetEvidence } from '../src/core/fleet/reset-evidence-await.js';
import type { UsageResetsV1 } from '../src/core/fleet/usage-reset-detect.js';

const start = Date.parse('2026-11-01T00:00:00Z');
const now = () => Date.now() - start;
const empty: UsageResetsV1 = { v: 1, generatedAt: new Date(start).toISOString(), sourceState: 'healthy', rows: [] };
let dir: string;
let stopFile: string;
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(start); dir = mkdtempSync(join(tmpdir(), 'reset-stop-')); stopFile = join(dir, 'stop'); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); rmSync(dir, { recursive: true, force: true }); });
const options = () => ({ lane: 'alpha', timeoutMs: 1000, pollMs: 800, stopFile });

it.each(['file', 'dangling symlink'])('cancels before reading for a preexisting %s', async kind => {
  if (kind === 'file') writeFileSync(stopFile, 'ignored'); else symlinkSync(join(dir, 'missing'), stopFile);
  const read = vi.fn(async () => empty);
  expect((await awaitResetEvidence(options(), { read, now })).outcome).toBe('cancelled');
  expect(read).not.toHaveBeenCalled();
});

it.each(['sleep', 'read'])('cancels during %s and cleans timers and listeners', async phase => {
  const beforeInt = process.listenerCount('SIGINT');
  const beforeTerm = process.listenerCount('SIGTERM');
  let resolveRead!: (value: UsageResetsV1) => void;
  const read = vi.fn(() => phase === 'read' ? new Promise<UsageResetsV1>(resolve => { resolveRead = resolve; }) : Promise.resolve(empty));
  const pending = awaitResetEvidence(options(), { read, now });
  await vi.advanceTimersByTimeAsync(1);
  writeFileSync(stopFile, 'ignored');
  await vi.advanceTimersByTimeAsync(250);
  const result = await pending;
  expect(result.outcome).toBe('cancelled');
  expect(read).toHaveBeenCalledTimes(1);
  if (phase === 'read') { resolveRead(empty); await Promise.resolve(); expect(result.checks).toBe(0); }
  expect(process.listenerCount('SIGINT')).toBe(beforeInt);
  expect(process.listenerCount('SIGTERM')).toBe(beforeTerm);
  expect(vi.getTimerCount()).toBe(0);
});

it('fails on probe errors and invalid paths before a read', async () => {
  const read = vi.fn(async () => empty);
  expect((await awaitResetEvidence(options(), { read, now, probe: () => 'error' })).outcome).toBe('failed');
  for (const path of ['', 'bad\0path']) expect((await awaitResetEvidence({ ...options(), stopFile: path }, { read, now })).outcome).toBe('failed');
  expect(read).not.toHaveBeenCalled();
});

it('observes genuinely fresh evidence when the sentinel is absent', async () => {
  const fresh: UsageResetsV1 = { ...empty, rows: [{ lane: 'alpha', held: true, heldReason: null, heldUntil: null,
    holdSince: null, heldBy: 'autobackoff', usedPct: 1, readingAsOf: new Date(start + 1).toISOString(),
    resetAt: null, state: 'reset-detected', releasable: true, tell: '' }] };
  const pending = awaitResetEvidence(options(), { now, read: async () => fresh });
  await vi.advanceTimersByTimeAsync(801);
  expect((await pending).outcome).toBe('observed');
});

it('gives the deadline precedence when a stop appears at the deadline', async () => {
  const pending = awaitResetEvidence({ ...options(), timeoutMs: 250 }, { now, read: () => new Promise(() => {}),
    probe: () => now() >= 250 ? 'stop' : 'go' });
  await vi.advanceTimersByTimeAsync(250);
  expect((await pending).outcome).toBe('deadline');
  expect(vi.getTimerCount()).toBe(0);
});

it('validates CLI flags and returns 130 for a sentinel', async () => {
  const read = vi.fn(async () => empty);
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  const base = ['--lane', 'alpha', '--timeout-ms', '1000'];
  for (const flags of [['--stop-file', ''], ['--stop-file', 'a\0b'], ['--stop-file', 'a', '--stop-file', 'b']]) {
    expect(await cmdFleetResetAwait([...base, ...flags], { read })).toBe(2);
  }
  writeFileSync(stopFile, 'ignored');
  const lines: string[] = [];
  expect(await cmdFleetResetAwait([...base, '--stop-file', stopFile, '--json'], { read, emit: line => { lines.push(line); } })).toBe(130);
  expect(JSON.parse(lines[0]!).outcome).toBe('cancelled');
  expect(read).not.toHaveBeenCalled();
});
