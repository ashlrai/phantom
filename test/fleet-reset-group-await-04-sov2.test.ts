import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cmdFleetResetGroupAwait } from '../src/cli/fleet-reset-group-await.js';
import { resolveFleetSubcommand } from '../src/cli/fleet-subcommand-resolve.js';
import type { UsageResetRow, UsageResetsV1 } from '../src/core/fleet/usage-reset-detect.js';

const start = Date.parse('2026-11-01T00:00:00Z');
const row = (lane: string, over: Partial<UsageResetRow> = {}, readingMs = start + 1): UsageResetRow => ({ lane, held: true,
  heldReason: 'autobackoff secret /private/path', heldUntil: null, holdSince: null, heldBy: 'autobackoff',
  usedPct: 1, readingAsOf: new Date(readingMs).toISOString(), resetAt: null,
  state: 'reset-detected', releasable: true, tell: 'secret tell /private/path', ...over });
const snapshot = (rows: UsageResetRow[], sourceState: UsageResetsV1['sourceState'] = 'healthy'): UsageResetsV1 =>
  ({ v: 1, generatedAt: new Date(start).toISOString(), sourceState, rows });
const now = () => Date.now() - start;
const args = (lanes: string, extra: string[] = []): string[] =>
  ['--lanes', lanes, '--timeout-ms', '100', '--poll-ms', '20', '--runs-dir', dir, '--json', ...extra];
let dir: string;
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(start); dir = mkdtempSync(join(tmpdir(), 'reset-group-await-')); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); rmSync(dir, { recursive: true, force: true }); });

it('observes two lanes qualifying in different polls with one read per poll, in requested order', async () => {
  const lines: string[] = [];
  // A reading must be newer than invocation and not in the future, so evidence first qualifies on poll 2 (t=20ms).
  const open = row('beta', { held: false, state: 'open' });
  const read = vi.fn()
    .mockResolvedValueOnce(snapshot([row('alpha', { held: false, state: 'open' }), open]))
    .mockResolvedValueOnce(snapshot([row('alpha', {}, start + 15), open]))
    .mockResolvedValueOnce(snapshot([row('alpha', {}, start + 15), row('beta', { state: 'reset-time-passed' }, start + 35)]));
  const pending = cmdFleetResetGroupAwait(args('beta,alpha'), { read, now, emit: line => { lines.push(line); } });
  await vi.advanceTimersByTimeAsync(40);
  expect(await pending).toBe(0);
  expect(read).toHaveBeenCalledTimes(3);
  expect(read).toHaveBeenCalledWith({ runsDir: dir });
  expect(JSON.parse(lines[0]!)).toEqual({ v: 1, authority: 'none', outcome: 'observed', checks: 3,
    observed: [
      { lane: 'beta', state: 'reset-time-passed', heldBy: 'autobackoff', readingAsOf: new Date(start + 35).toISOString() },
      { lane: 'alpha', state: 'reset-detected', heldBy: 'autobackoff', readingAsOf: new Date(start + 15).toISOString() },
    ],
    pending: [] });
});

it('preserves ordered partial progress on deadline and keeps the first evidence per lane', async () => {
  const lines: string[] = [];
  const read = vi.fn(async () => snapshot([row('alpha'), row('beta', { held: false, state: 'open' })]));
  const pending = cmdFleetResetGroupAwait(args('beta,alpha'), { read, now, emit: line => { lines.push(line); } });
  await vi.advanceTimersByTimeAsync(100);
  expect(await pending).toBe(1);
  expect(read.mock.calls.length).toBeGreaterThan(1);
  const out = JSON.parse(lines[0]!);
  expect(out).toMatchObject({ outcome: 'deadline', observed: [{ lane: 'alpha' }], pending: ['beta'] });
  expect(out.observed).toHaveLength(1);
  expect(out.checks).toBe(read.mock.calls.length);
});

it.each([
  ['manual hold', row('alpha', { heldBy: 'manual', heldReason: 'manual' })],
  ['stale reading', row('alpha', {}, start)],
  ['future reading', row('alpha', {}, start + 1_000_000)],
  ['consistent reading', row('alpha', { state: 'consistent', usedPct: 60 })],
  ['absent lane row', null],
  ['no reading time', row('alpha', { readingAsOf: null })],
])('does not count %s as evidence, while a healthy sibling still qualifies', async (_label, alpha) => {
  const lines: string[] = [];
  const read = vi.fn(async () => snapshot([...(alpha ? [alpha] : []), row('beta')]));
  const pending = cmdFleetResetGroupAwait(args('alpha,beta'), { read, now, emit: line => { lines.push(line); } });
  await vi.advanceTimersByTimeAsync(100);
  expect(await pending).toBe(1);
  expect(JSON.parse(lines[0]!)).toMatchObject({ outcome: 'deadline', observed: [{ lane: 'beta' }], pending: ['alpha'] });
  expect(read.mock.calls.length).toBeGreaterThan(0);
});

it('does not count any lane from a degraded source', async () => {
  const lines: string[] = [];
  const read = vi.fn(async () => snapshot([row('alpha'), row('beta')], 'degraded'));
  const pending = cmdFleetResetGroupAwait(args('alpha,beta'), { read, now, emit: line => { lines.push(line); } });
  await vi.advanceTimersByTimeAsync(100);
  expect(await pending).toBe(1);
  expect(JSON.parse(lines[0]!)).toMatchObject({ outcome: 'deadline', observed: [], pending: ['alpha', 'beta'] });
});

it('rejects invalid arguments before any read', async () => {
  const read = vi.fn(async () => snapshot([row('alpha')]));
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  const seventeen = Array.from({ length: 17 }, (_, i) => `lane-${i}`).join(',');
  for (const argv of [
    [],
    ['--lanes', '', '--timeout-ms', '100'],
    ['--lanes', 'alpha,,beta', '--timeout-ms', '100'],
    ['--lanes', 'alpha,', '--timeout-ms', '100'],
    ['--lanes', 'alpha,alpha', '--timeout-ms', '100'],
    ['--lanes', 'Alpha,beta', '--timeout-ms', '100'],
    ['--lanes', 'alpha beta', '--timeout-ms', '100'],
    ['--lanes', seventeen, '--timeout-ms', '100'],
    ['--lanes', 'alpha', '--lanes', 'beta', '--timeout-ms', '100'],
    ['--lanes', 'alpha', '--timeout-ms', '100', '--json', '--json'],
    ['--lanes', 'alpha', '--timeout-ms', '100', '--bogus'],
    ['--lanes', 'alpha', '--timeout-ms', '100', '--after', '2026-11-01T00:00:00Z'],
    ['--lanes', 'alpha'],
    ['--lanes', '--timeout-ms', '100'],
    ['--lanes', 'alpha', '--timeout-ms', '0'],
    ['--lanes', 'alpha', '--timeout-ms', '1e3'],
    ['--lanes', 'alpha', '--timeout-ms', '86400001'],
    ['--lanes', 'alpha', '--timeout-ms', '1', '--poll-ms', '0'],
    ['--lanes', 'alpha', '--timeout-ms', '1', '--poll-ms', '3600001'],
    ['--lanes', 'alpha', '--timeout-ms', '1', '--runs-dir', 'relative'],
  ]) {
    expect(await cmdFleetResetGroupAwait(argv, { read, now })).toBe(2);
  }
  expect(read).not.toHaveBeenCalled();
});

it('bounds a stalled read by the overall deadline and makes no later reads', async () => {
  const lines: string[] = [];
  const read = vi.fn(() => new Promise<UsageResetsV1>(() => {}));
  const pending = cmdFleetResetGroupAwait(args('alpha,beta'), { read, now, emit: line => { lines.push(line); } });
  await vi.advanceTimersByTimeAsync(100);
  expect(await pending).toBe(1);
  await vi.advanceTimersByTimeAsync(1_000);
  expect(read).toHaveBeenCalledTimes(1);
  expect(JSON.parse(lines[0]!)).toMatchObject({ outcome: 'deadline', checks: 0, observed: [], pending: ['alpha', 'beta'] });
  expect(vi.getTimerCount()).toBe(0);
});

it('cancels during a stalled read and cleans listeners', async () => {
  const before = process.listenerCount('SIGINT');
  const controller = new AbortController();
  const lines: string[] = [];
  const read = vi.fn(() => new Promise<UsageResetsV1>(() => {}));
  const pending = cmdFleetResetGroupAwait(args('alpha'), { read, now, signal: controller.signal, emit: line => { lines.push(line); } });
  await vi.advanceTimersByTimeAsync(1);
  controller.abort();
  expect(await pending).toBe(130);
  await vi.advanceTimersByTimeAsync(1_000);
  expect(read).toHaveBeenCalledTimes(1);
  expect(JSON.parse(lines[0]!)).toMatchObject({ outcome: 'cancelled', checks: 0 });
  expect(process.listenerCount('SIGINT')).toBe(before);
  expect(process.listenerCount('SIGTERM')).toBe(before);
  expect(vi.getTimerCount()).toBe(0);
});

it('keeps partial progress when cancelled between polls', async () => {
  const controller = new AbortController();
  const lines: string[] = [];
  const read = vi.fn(async () => snapshot([row('alpha')]));
  const pending = cmdFleetResetGroupAwait(args('alpha,beta'), { read, now, signal: controller.signal, emit: line => { lines.push(line); } });
  // Poll 2 (t=20ms) qualifies alpha; cancellation then lands during the sleep before poll 3.
  await vi.advanceTimersByTimeAsync(21);
  controller.abort();
  expect(await pending).toBe(130);
  await vi.advanceTimersByTimeAsync(1_000);
  expect(read).toHaveBeenCalledTimes(2);
  expect(JSON.parse(lines[0]!)).toMatchObject({ outcome: 'cancelled', checks: 2, observed: [{ lane: 'alpha' }], pending: ['beta'] });
});

it('never lets a read that resolves after the deadline change the terminal output', async () => {
  const lines: string[] = [];
  let resolveRead!: (value: UsageResetsV1) => void;
  const read = vi.fn(() => new Promise<UsageResetsV1>(resolve => { resolveRead = resolve; }));
  const pending = cmdFleetResetGroupAwait(args('alpha,beta'), { read, now, emit: line => { lines.push(line); } });
  await vi.advanceTimersByTimeAsync(100);
  expect(await pending).toBe(1);
  const terminal = lines[0];
  resolveRead(snapshot([row('alpha'), row('beta')]));
  await vi.advanceTimersByTimeAsync(1_000);
  expect(lines).toEqual([terminal]);
  expect(JSON.parse(terminal!)).toMatchObject({ outcome: 'deadline', observed: [] });
  expect(read).toHaveBeenCalledTimes(1);
});

it('returns failed for a rejected read without exposing its error', async () => {
  const lines: string[] = [];
  const read = vi.fn(async () => { throw new Error('/private/path token'); });
  const pending = cmdFleetResetGroupAwait(args('alpha'), { read, now, emit: line => { lines.push(line); } });
  await vi.advanceTimersByTimeAsync(1);
  expect(await pending).toBe(1);
  expect(lines[0]).not.toMatch(/private|token|runs/);
  expect(JSON.parse(lines[0]!)).toMatchObject({ outcome: 'failed', checks: 0 });
});

it('emits only the public v1 shape', async () => {
  const lines: string[] = [];
  const read = vi.fn(async () => snapshot([row('alpha')]));
  const pending = cmdFleetResetGroupAwait(args('alpha'), { read, now, emit: line => { lines.push(line); } });
  await vi.advanceTimersByTimeAsync(21);
  expect(await pending).toBe(0);
  const out = JSON.parse(lines[0]!);
  expect(Object.keys(out).sort()).toEqual(['authority', 'checks', 'observed', 'outcome', 'pending', 'v']);
  expect(Object.keys(out.observed[0]).sort()).toEqual(['heldBy', 'lane', 'readingAsOf', 'state']);
  expect(lines[0]).not.toMatch(/reason|tell|private|runs|secret/);
});

it('is discovered by convention dispatch without a registry edit', async () => {
  const route = resolveFleetSubcommand('reset-group-await');
  expect(route).toEqual({ module: './fleet-reset-group-await.js', exportName: 'cmdFleetResetGroupAwait' });
  const mod = await import('../src/cli/fleet-reset-group-await.js');
  expect(typeof mod[route!.exportName as 'cmdFleetResetGroupAwait']).toBe('function');
});
