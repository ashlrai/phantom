import { mkdtempSync, rmSync } from 'node:fs';
import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cmdFleetResetReleaseAwait } from '../src/cli/fleet-reset-release-await.js';
import { awaitResetRelease } from '../src/core/fleet/reset-release-await.js';
import { readResetReleases, RESET_RELEASES_FILE, type ResetReleaseRecord } from '../src/core/fleet/usage-reset-release.js';

const start = Date.parse('2026-11-04T18:06:00Z');
const iso = (ms: number): string => new Date(ms).toISOString();
const now = (): number => Date.now() - start;
const tick = (): Promise<void> => new Promise(resolve => setImmediate(resolve));
const line = (over: Record<string, unknown> = {}): string => JSON.stringify({ v: 1, lane: 'alpha',
  at: iso(start + 10), by: 'reset-detect', reason: 'secret reason /private/hidden',
  state: 'reset-detected', usedPct: 3, readingAsOf: null, heldUntil: null, ...over });
const readSpy = () => vi.fn(async (): Promise<ResetReleaseRecord[]> => []);
const opts = { lane: 'alpha', timeoutMs: 40, pollMs: 20 };
let dir: string;
const file = (): string => join(dir, RESET_RELEASES_FILE);
const seed = async (lines: string[]): Promise<void> => {
  await mkdir(join(dir, 'queue'), { recursive: true });
  await writeFile(file(), `${lines.join('\n')}\n`);
};
/** The real bounded audit reader, wrapped so each check's completion is observable. */
const trackedReader = (): { read: typeof readResetReleases; calls: Promise<ResetReleaseRecord[]>[] } => {
  const calls: Promise<ResetReleaseRecord[]>[] = [];
  const read = vi.fn((runsDir?: string, limit?: number) => {
    const promise = readResetReleases(runsDir, limit);
    calls.push(promise);
    return promise;
  });
  return { read, calls };
};
const settle = async (calls: Promise<unknown>[], n: number): Promise<void> => {
  for (let i = 0; i < 500 && calls.length < n; i++) await tick();
  if (calls.length < n) throw new Error(`await never reached check ${n}`);
  await Promise.all(calls.slice(0, n));
  await tick();
};
beforeEach(() => {
  // setImmediate stays real so the real audit reader can finish between checks.
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  vi.setSystemTime(start);
  dir = mkdtempSync(join(tmpdir(), 'reset-release-await-'));
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); rmSync(dir, { recursive: true, force: true }); });

it('records only after a fresh audit line for the lane arrives', async () => {
  await seed([line({ at: iso(start) })]);
  const { read, calls } = trackedReader();
  const out: string[] = [];
  const pending = cmdFleetResetReleaseAwait(['--lane', 'alpha', '--timeout-ms', '500', '--poll-ms', '20',
    '--runs-dir', dir, '--json'], { read, now, emit: text => { out.push(text); } });
  await settle(calls, 1);
  await appendFile(file(), `${line()}\n`);
  await vi.advanceTimersByTimeAsync(20);
  expect(await pending).toBe(0);
  expect(read).toHaveBeenCalledWith(dir, 200);
  expect(JSON.parse(out[0]!)).toEqual({ v: 1, authority: 'none', outcome: 'recorded', lane: 'alpha',
    checks: 2, release: { timestamp: iso(start + 10), state: 'reset-detected' } });
  expect(out[0]).not.toMatch(/reason|secret|private|hidden/);
  expect(out[0]).not.toContain('\u001b');
  expect(out[0]).not.toContain(dir);
});

it.each([
  ['other lane', [line({ lane: 'beta' })]],
  ['old', [line({ at: iso(start - 1) })]],
  ['boundary', [line({ at: iso(start) })]],
  ['future', [line({ at: iso(start + 3_600_000) })]],
  ['invalid', [line({ at: 'not-a-time' })]],
  ['missing at', [JSON.stringify({ lane: 'alpha' })]],
  ['malformed', ['{broken']],
])('reaches deadline on %s audit content', async (_label, lines) => {
  await seed(lines);
  const { read, calls } = trackedReader();
  const pending = awaitResetRelease({ ...opts, runsDir: dir }, { read, now });
  await settle(calls, 1);
  await vi.advanceTimersByTimeAsync(40);
  const result = await pending;
  expect(result.outcome).toBe('deadline');
  expect(result.release).toBeNull();
  expect(result.checks).toBeGreaterThanOrEqual(1);
});

it('reaches deadline when no audit file exists and flags the human output', async () => {
  const { read, calls } = trackedReader();
  const out: string[] = [];
  const pending = cmdFleetResetReleaseAwait(['--lane', 'alpha', '--timeout-ms', '40', '--poll-ms', '20',
    '--runs-dir', dir], { read, now, emit: text => { out.push(text); } });
  await vi.advanceTimersByTimeAsync(40);
  expect(await pending).toBe(1);
  expect(calls.length).toBeGreaterThanOrEqual(1);
  expect(out[0]).toContain('deadline');
  expect(out[0]).toContain('audit evidence, not present lane health or successful dispatch');
  expect(out[0]).not.toContain(dir);
});

it('cancels on a pre-aborted signal before any read', async () => {
  const controller = new AbortController();
  controller.abort();
  const read = readSpy();
  const out: string[] = [];
  const code = await cmdFleetResetReleaseAwait(['--lane', 'alpha', '--timeout-ms', '40', '--runs-dir', dir, '--json'],
    { read, now, signal: controller.signal, emit: text => { out.push(text); } });
  expect(code).toBe(130);
  expect(JSON.parse(out[0]!).outcome).toBe('cancelled');
  expect(read).not.toHaveBeenCalled();
});

it('bounds a hanging reader and ignores its late rejection', async () => {
  let reject!: (reason: Error) => void;
  const pending = awaitResetRelease(opts,
    { now, read: () => new Promise<ResetReleaseRecord[]>((_resolve, fail) => { reject = fail; }) });
  await vi.advanceTimersByTimeAsync(40);
  expect((await pending).outcome).toBe('deadline');
  reject(new Error('private'));
  await tick();
});

it.each(['read', 'sleep'])('cancels during %s and cleans listeners', async phase => {
  const before = process.listenerCount('SIGINT');
  const controller = new AbortController();
  const read = phase === 'read'
    ? () => new Promise<ResetReleaseRecord[]>(() => {})
    : readSpy();
  const pending = awaitResetRelease({ ...opts, signal: controller.signal }, { read, now });
  await vi.advanceTimersByTimeAsync(1);
  controller.abort();
  expect((await pending).outcome).toBe('cancelled');
  expect(process.listenerCount('SIGINT')).toBe(before);
  expect(vi.getTimerCount()).toBe(0);
});

it('fails on a rejected reader without exposing its error', async () => {
  const result = await awaitResetRelease(opts,
    { now, read: async () => { throw new Error('/private/path'); } });
  expect(result.outcome).toBe('failed');
  expect(result.checks).toBe(0);
  expect(JSON.stringify(result)).not.toContain('/private/path');
});

it('rejects invalid and duplicate flags before reading', async () => {
  const read = readSpy();
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  for (const args of [[], ['--lane', 'a', '--timeout-ms', '0'], ['--lane', 'a', '--lane', 'b', '--timeout-ms', '1'],
    ['--lane', 'a', '--timeout-ms', '1', '--json', '--json'], ['--lane', 'a', '--timeout-ms', '1', '--poll-ms', '3600001'],
    ['--lane', 'a', '--timeout-ms', '86400001'], ['--lane', 'a', '--timeout-ms', '1', '--runs-dir', 'relative'],
    ['--lane', 'a'], ['--timeout-ms', '1'], ['--lane', 'a', '--timeout-ms', '1', '--timeout-ms', '2'],
    ['--lane', 'a', '--timeout-ms', '1', '--poll-ms', '20', '--poll-ms', '30'], ['--lane', '-x', '--timeout-ms', '1'],
    ['--lane', 'a', '--timeout-ms', '1', '--runs-dir', dir, '--runs-dir', dir],
    ['--lane', 'a', '--timeout-ms', '1', '--bogus']]) {
    expect(await cmdFleetResetReleaseAwait(args, { read, now })).toBe(2);
  }
  expect(read).not.toHaveBeenCalled();
});

it('prints usage on --help without reading', async () => {
  const read = readSpy();
  const out: string[] = [];
  expect(await cmdFleetResetReleaseAwait(['--help'], { read, emit: text => { out.push(text); } })).toBe(0);
  expect(out[0]).toContain('reset-release-await');
  expect(out[0]).toContain('never releases a hold or launches work');
  expect(read).not.toHaveBeenCalled();
});
