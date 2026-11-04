import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cmdFleetResetGroupAwait } from '../src/cli/fleet-reset-group-await.js';
import { awaitResetGroup } from '../src/core/fleet/reset-group-await.js';
import type { UsageResetRow, UsageResetsV1 } from '../src/core/fleet/usage-reset-detect.js';

const start = Date.parse('2026-11-01T18:06:00Z');
const iso = (ms: number): string => new Date(ms).toISOString();
// A watermark the supervisor persisted before it last went offline; default rows sit
// inside the downtime window between it and the fake invocation time.
const watermark = iso(start - 60_000);
const row = (lane: string, over: Partial<UsageResetRow> = {}, readingMs = start - 30_000): UsageResetRow => ({ lane, held: true,
  heldReason: 'autobackoff usage', heldUntil: null, holdSince: null, heldBy: 'autobackoff',
  usedPct: 1, readingAsOf: iso(readingMs), resetAt: null,
  state: 'reset-detected', releasable: true, tell: 'reset observed', ...over });
const snapshot = (rows: UsageResetRow[], sourceState: UsageResetsV1['sourceState'] = 'healthy'): UsageResetsV1 =>
  ({ v: 1, generatedAt: iso(start), sourceState, rows });
const now = () => Date.now() - start;
const cli = (lanes: string, extra: string[] = []): string[] =>
  ['--lanes', lanes, '--timeout-ms', '100', '--poll-ms', '20', '--runs-dir', dir, '--json', ...extra];
let dir: string;
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(start); dir = mkdtempSync(join(tmpdir(), 'reset-group-wm-')); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); rmSync(dir, { recursive: true, force: true }); });

it('observes downtime evidence on every lane via a persisted --after watermark', async () => {
  const lines: string[] = [];
  const read = vi.fn(async () => snapshot([row('alpha'), row('beta')]));
  const code = await cmdFleetResetGroupAwait(cli('alpha,beta', ['--after', watermark]),
    { read, now, emit: line => { lines.push(line); } });
  expect(code).toBe(0);
  expect(read).toHaveBeenCalledTimes(1);
  expect(read).toHaveBeenCalledWith({ runsDir: dir });
  expect(JSON.parse(lines[0]!)).toEqual({ v: 1, authority: 'none', outcome: 'observed', checks: 1,
    observed: [
      { lane: 'alpha', state: 'reset-detected', heldBy: 'autobackoff', readingAsOf: iso(start - 30_000) },
      { lane: 'beta', state: 'reset-detected', heldBy: 'autobackoff', readingAsOf: iso(start - 30_000) },
    ],
    pending: [] });
});

it('accepts an --after watermark carrying a non-Z offset', async () => {
  const lines: string[] = [];
  const read = vi.fn(async () => snapshot([row('alpha'), row('beta')]));
  // Same instant as `watermark`, written with a +02:00 offset to prove normalization.
  const code = await cmdFleetResetGroupAwait(cli('alpha,beta', ['--after', '2026-11-01T20:05:00+02:00']),
    { read, now, emit: line => { lines.push(line); } });
  expect(code).toBe(0);
  expect(read).toHaveBeenCalledTimes(1);
  expect(JSON.parse(lines[0]!)).toMatchObject({ outcome: 'observed', checks: 1 });
});

it('keeps the invocation boundary when --after is absent, so downtime evidence does not count', async () => {
  const read = vi.fn(async () => snapshot([row('alpha'), row('beta')]));
  const pending = awaitResetGroup({ lanes: ['alpha', 'beta'], timeoutMs: 100, pollMs: 20 }, { read, now });
  await vi.advanceTimersByTimeAsync(100);
  const result = await pending;
  expect(result).toMatchObject({ outcome: 'deadline', observed: [], pending: ['alpha', 'beta'] });
  expect(read.mock.calls.length).toBeGreaterThan(0);
});

it.each([
  ['equal to the watermark', start - 60_000],
  ['before the watermark', start - 90_000],
  ['in the future', start + 3_600_000],
])('does not observe a reading %s', async (_label, readingMs) => {
  const read = vi.fn(async () => snapshot([row('alpha', {}, readingMs), row('beta')]));
  const pending = awaitResetGroup({ lanes: ['alpha', 'beta'], timeoutMs: 100, pollMs: 20, after: watermark }, { read, now });
  await vi.advanceTimersByTimeAsync(100);
  expect(await pending).toMatchObject({ outcome: 'deadline', observed: [{ lane: 'beta' }], pending: ['alpha'] });
});

it.each([
  ['manual hold', snapshot([row('alpha', { heldBy: 'manual', heldReason: 'manual', state: 'manual-hold' })])],
  ['degraded source', snapshot([row('alpha')], 'degraded')],
  ['missing lane row', snapshot([])],
])('does not count %s as evidence even when newer than the watermark', async (_label, data) => {
  const read = vi.fn(async () => data);
  const pending = awaitResetGroup({ lanes: ['alpha'], timeoutMs: 100, pollMs: 20, after: watermark }, { read, now });
  await vi.advanceTimersByTimeAsync(100);
  expect((await pending).outcome).toBe('deadline');
});

it('accumulates two lanes over polls with exactly one shared read per poll', async () => {
  const lines: string[] = [];
  const open = row('beta', { held: false, heldBy: null, state: 'open' });
  const read = vi.fn()
    .mockResolvedValueOnce(snapshot([row('alpha'), open]))
    .mockResolvedValueOnce(snapshot([row('alpha'), row('beta', { state: 'reset-time-passed' }, start - 10_000)]));
  const pending = cmdFleetResetGroupAwait(cli('beta,alpha', ['--after', watermark]),
    { read, now, emit: line => { lines.push(line); } });
  // Poll 1 qualifies alpha from the downtime window; poll 2 (t=20ms) qualifies beta.
  await vi.advanceTimersByTimeAsync(21);
  expect(await pending).toBe(0);
  expect(read).toHaveBeenCalledTimes(2);
  expect(JSON.parse(lines[0]!)).toEqual({ v: 1, authority: 'none', outcome: 'observed', checks: 2,
    observed: [
      { lane: 'beta', state: 'reset-time-passed', heldBy: 'autobackoff', readingAsOf: iso(start - 10_000) },
      { lane: 'alpha', state: 'reset-detected', heldBy: 'autobackoff', readingAsOf: iso(start - 30_000) },
    ],
    pending: [] });
});

it('keeps partial progress when cancelled between polls with --after', async () => {
  const before = process.listenerCount('SIGINT');
  const controller = new AbortController();
  const lines: string[] = [];
  const read = vi.fn(async () => snapshot([row('alpha'), row('beta', { held: false, heldBy: null, state: 'open' })]));
  const pending = cmdFleetResetGroupAwait(cli('alpha,beta', ['--after', watermark]),
    { read, now, signal: controller.signal, emit: line => { lines.push(line); } });
  // Poll 1 qualifies alpha; cancellation then lands during the sleep before poll 3.
  await vi.advanceTimersByTimeAsync(21);
  controller.abort();
  expect(await pending).toBe(130);
  await vi.advanceTimersByTimeAsync(1_000);
  expect(read).toHaveBeenCalledTimes(2);
  expect(JSON.parse(lines[0]!)).toMatchObject({ outcome: 'cancelled', checks: 2,
    observed: [{ lane: 'alpha' }], pending: ['beta'] });
  expect(process.listenerCount('SIGINT')).toBe(before);
  expect(vi.getTimerCount()).toBe(0);
});

it('rejects an invalid core after option before any read or sleep', async () => {
  const read = vi.fn(async () => snapshot([row('alpha')]));
  const sleep = vi.fn(async () => {});
  for (const after of ['', 'not-a-date', '2026-11-01', '2026-11-01T18:06:00', '2026-11-01T18:06:00+24:00']) {
    const result = await awaitResetGroup({ lanes: ['alpha'], timeoutMs: 100, pollMs: 20, after }, { read, now, sleep });
    expect(result).toMatchObject({ outcome: 'failed', checks: 0, observed: [] });
  }
  expect(read).not.toHaveBeenCalled();
  expect(sleep).not.toHaveBeenCalled();
});

it('rejects invalid and duplicate --after flags before reading', async () => {
  const read = vi.fn(async () => snapshot([row('alpha')]));
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  for (const argv of [
    ['--lanes', 'alpha', '--timeout-ms', '1', '--after'],
    ['--lanes', 'alpha', '--timeout-ms', '1', '--after', '--json'],
    ['--lanes', 'alpha', '--timeout-ms', '1', '--after', 'not-a-date'],
    ['--lanes', 'alpha', '--timeout-ms', '1', '--after', '2026-11-01'],
    ['--lanes', 'alpha', '--timeout-ms', '1', '--after', '2026-11-01T18:06:00'],
    ['--lanes', 'alpha', '--timeout-ms', '1', '--after', '2026-11-01T18:06Z'],
    ['--lanes', 'alpha', '--timeout-ms', '1', '--after', '2026-11-01T18:06:00+0530'],
    ['--lanes', 'alpha', '--timeout-ms', '1', '--after', '2026-13-01T00:00:00Z'],
    ['--lanes', 'alpha', '--timeout-ms', '1', '--after', ' 2026-11-01T18:06:00Z'],
    ['--lanes', 'alpha', '--timeout-ms', '1', '--after', watermark, '--after', iso(start)],
  ]) {
    expect(await cmdFleetResetGroupAwait(argv, { read, now })).toBe(2);
  }
  expect(read).not.toHaveBeenCalled();
});

it('help explains the caller-persisted watermark', async () => {
  const lines: string[] = [];
  expect(await cmdFleetResetGroupAwait(['--help'], { emit: line => { lines.push(line); } })).toBe(0);
  expect(lines[0]).toContain('--after');
  expect(lines[0]).toMatch(/persisted|between runs/);
});
