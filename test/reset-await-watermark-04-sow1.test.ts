import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cmdFleetResetAwait } from '../src/cli/fleet-reset-await.js';
import { awaitResetEvidence, parseResetAwaitWatermarkMs } from '../src/core/fleet/reset-evidence-await.js';
import type { UsageResetRow, UsageResetsV1 } from '../src/core/fleet/usage-reset-detect.js';

const start = Date.parse('2026-11-01T00:00:00Z');
const iso = (ms: number): string => new Date(ms).toISOString();
// A watermark the supervisor persisted before it last went offline.
const watermark = iso(start - 60_000);
const row = (over: Partial<UsageResetRow> = {}): UsageResetRow => ({ lane: 'alpha', held: true,
  heldReason: 'autobackoff usage', heldUntil: null, holdSince: null, heldBy: 'autobackoff',
  usedPct: 1, readingAsOf: iso(start - 30_000), resetAt: null,
  state: 'reset-detected', releasable: true, tell: 'reset observed', ...over });
const snapshot = (rows = [row()], sourceState: UsageResetsV1['sourceState'] = 'healthy'): UsageResetsV1 =>
  ({ v: 1, generatedAt: iso(start), sourceState, rows });
const opts = { lane: 'alpha', timeoutMs: 100, pollMs: 20 };
const now = () => Date.now() - start;
let dir: string;
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(start); dir = mkdtempSync(join(tmpdir(), 'reset-await-wm-')); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); rmSync(dir, { recursive: true, force: true }); });

it('observes a reset read after the saved watermark but before invocation', async () => {
  const lines: string[] = [];
  const read = vi.fn(async () => snapshot());
  // Same instant as `watermark`, written with a +02:00 offset to prove normalization.
  const code = await cmdFleetResetAwait(
    ['--lane', 'alpha', '--timeout-ms', '100', '--poll-ms', '20', '--runs-dir', dir,
      '--after', '2026-11-01T01:59:00+02:00', '--json'],
    { read, now, emit: line => { lines.push(line); } });
  expect(code).toBe(0);
  expect(read).toHaveBeenCalledTimes(1);
  expect(JSON.parse(lines[0]!)).toMatchObject({ outcome: 'observed', checks: 1, authority: 'none',
    evidence: { sourceState: 'healthy', state: 'reset-detected', heldBy: 'autobackoff',
      readingAsOf: iso(start - 30_000) } });
});

it('keeps the invocation boundary when --after is absent', async () => {
  const read = vi.fn(async () => snapshot());
  const pending = awaitResetEvidence(opts, { read, now });
  await vi.advanceTimersByTimeAsync(100);
  expect((await pending).outcome).toBe('deadline');
  expect(read.mock.calls.length).toBeGreaterThan(0);
});

it.each([
  ['equal to the watermark', iso(start - 60_000)],
  ['before the watermark', iso(start - 90_000)],
  ['in the future', iso(start + 3_600_000)],
])('does not observe a reading %s', async (_label, readingAsOf) => {
  const read = vi.fn(async () => snapshot([row({ readingAsOf })]));
  const pending = awaitResetEvidence({ ...opts, after: watermark }, { read, now });
  await vi.advanceTimersByTimeAsync(100);
  expect((await pending).outcome).toBe('deadline');
});

it.each([
  ['manual hold', snapshot([row({ heldBy: 'manual', state: 'manual-hold' })])],
  ['degraded source', snapshot([row()], 'degraded')],
  ['missing lane row', snapshot([])],
  ['open lane', snapshot([row({ held: false, heldBy: null, state: 'open' })])],
  ['expired hold', snapshot([row({ state: 'hold-expired' })])],
  ['consistent usage', snapshot([row({ state: 'consistent' })])],
])('does not release on %s evidence with --after', async (_label, data) => {
  const read = vi.fn(async () => data);
  const pending = awaitResetEvidence({ ...opts, after: watermark }, { read, now });
  await vi.advanceTimersByTimeAsync(100);
  expect((await pending).outcome).toBe('deadline');
});

it('accepts reset-time-passed evidence newer than the watermark', async () => {
  const pending = awaitResetEvidence({ ...opts, after: watermark },
    { read: async () => snapshot([row({ state: 'reset-time-passed' })]), now });
  expect((await pending).outcome).toBe('observed');
});

it('treats a future watermark as unsatisfiable and reaches the deadline', async () => {
  const read = vi.fn(async () => snapshot([row({ readingAsOf: iso(start) })]));
  const pending = awaitResetEvidence({ ...opts, after: iso(start + 60_000) }, { read, now });
  await vi.advanceTimersByTimeAsync(100);
  expect((await pending).outcome).toBe('deadline');
});

it('rejects invalid and duplicate --after flags before reading', async () => {
  const read = vi.fn(async () => snapshot());
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  for (const args of [
    ['--lane', 'a', '--timeout-ms', '1', '--after'],
    ['--lane', 'a', '--timeout-ms', '1', '--after', '--json'],
    ['--lane', 'a', '--timeout-ms', '1', '--after', 'not-a-date'],
    ['--lane', 'a', '--timeout-ms', '1', '--after', '2026-11-01'],
    ['--lane', 'a', '--timeout-ms', '1', '--after', '2026-11-01T18:06:00'],
    ['--lane', 'a', '--timeout-ms', '1', '--after', '2026-11-01T18:06Z'],
    ['--lane', 'a', '--timeout-ms', '1', '--after', '2026-11-01T18:06:00+0530'],
    ['--lane', 'a', '--timeout-ms', '1', '--after', '2026-13-01T00:00:00Z'],
    ['--lane', 'a', '--timeout-ms', '1', '--after', ' 2026-11-01T18:06:00Z'],
    ['--lane', 'a', '--timeout-ms', '1', '--after', '2026-11-01T18:06:00Z',
      '--after', '2026-11-01T19:00:00Z'],
  ]) {
    expect(await cmdFleetResetAwait(args, { read })).toBe(2);
  }
  expect(read).not.toHaveBeenCalled();
});

it('fails closed on an invalid core after option without reading', async () => {
  const read = vi.fn(async () => snapshot());
  for (const after of ['not-a-date', '2026-11-01', '2026-11-01T18:06:00', '2026-11-01T18:06:00+24:00']) {
    expect((await awaitResetEvidence({ ...opts, after }, { read, now })).outcome).toBe('failed');
  }
  expect(read).not.toHaveBeenCalled();
});

it.each(['read', 'sleep'])('cancels during %s with --after and cleans listeners', async phase => {
  const before = process.listenerCount('SIGINT');
  const controller = new AbortController();
  const read = phase === 'read' ? () => new Promise<UsageResetsV1>(() => {}) : async () => snapshot([]);
  const pending = awaitResetEvidence({ ...opts, after: watermark, signal: controller.signal }, { read, now });
  await vi.advanceTimersByTimeAsync(1);
  controller.abort();
  expect((await pending).outcome).toBe('cancelled');
  expect(process.listenerCount('SIGINT')).toBe(before);
  expect(vi.getTimerCount()).toBe(0);
});

it('exits 1 at the deadline when no reading passes the watermark', async () => {
  const pending = cmdFleetResetAwait(
    ['--lane', 'alpha', '--timeout-ms', '100', '--poll-ms', '20', '--after', watermark, '--json'],
    { read: async () => snapshot([row({ readingAsOf: iso(start - 90_000) })]), now, emit: () => {} });
  await vi.advanceTimersByTimeAsync(100);
  expect(await pending).toBe(1);
});

it('help explains the caller-persisted watermark', async () => {
  const lines: string[] = [];
  expect(await cmdFleetResetAwait(['--help'], { emit: line => { lines.push(line); } })).toBe(0);
  expect(lines[0]).toContain('--after');
  expect(lines[0]).toMatch(/persisted|between runs/);
});

it('normalizes a strict RFC 3339 watermark once to epoch milliseconds', () => {
  expect(parseResetAwaitWatermarkMs('2026-10-31T23:59:00.000Z')).toBe(start - 60_000);
  expect(parseResetAwaitWatermarkMs('2026-11-01T01:59:00+02:00')).toBe(start - 60_000);
  expect(parseResetAwaitWatermarkMs('2026-10-31T23:59:00.5Z')).toBe(start - 59_500);
  expect(parseResetAwaitWatermarkMs('2026-11-01T18:06:00')).toBeNull();
});
