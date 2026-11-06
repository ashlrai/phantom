import { mkdtempSync, rmSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cmdFleetResetReleaseAwait } from '../src/cli/fleet-reset-release-await.js';
import { awaitResetRelease } from '../src/core/fleet/reset-release-await.js';
import { readResetReleases, RESET_RELEASES_FILE, type ResetReleaseRecord } from '../src/core/fleet/usage-reset-release.js';

// The Nov 1 18:06 restart-continuity cursor: a supervisor persisted this
// watermark before going offline. A release audited after it but before this
// invocation (start) must still satisfy the wait; the default boundary stays
// invocation time.
const start = Date.parse('2026-11-04T18:06:00Z');
const cursor = '2026-11-01T18:06:00.000Z';
const iso = (ms: number): string => new Date(ms).toISOString();
const now = (): number => Date.now() - start;
const tick = (): Promise<void> => new Promise(resolve => setImmediate(resolve));
const line = (over: Record<string, unknown> = {}): string => JSON.stringify({ v: 1, lane: 'alpha',
  at: iso(start - 30_000), by: 'reset-detect', reason: 'secret reason /private/hidden',
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
  dir = mkdtempSync(join(tmpdir(), 'reset-release-cursor-'));
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); rmSync(dir, { recursive: true, force: true }); });

it('records a release audited between the saved cursor and invocation', async () => {
  // The line landed at start-30s while the supervisor was offline: newer than
  // the Nov 1 cursor (passed here with a +02:00 offset) yet older than now.
  await seed([line()]);
  const { read } = trackedReader();
  const out: string[] = [];
  const code = await cmdFleetResetReleaseAwait(
    ['--lane', 'alpha', '--timeout-ms', '500', '--poll-ms', '20', '--runs-dir', dir,
      '--after', '2026-11-01T20:06:00+02:00', '--json'],
    { read, now, emit: text => { out.push(text); } });
  expect(code).toBe(0);
  expect(read).toHaveBeenCalledWith(dir, 200);
  expect(JSON.parse(out[0]!)).toEqual({ v: 1, authority: 'none', outcome: 'recorded', lane: 'alpha',
    checks: 1, release: { timestamp: iso(start - 30_000), state: 'reset-detected' } });
  expect(out[0]).not.toMatch(/reason|secret|private|hidden/);
  expect(out[0]).not.toContain(dir);
});

it('keeps the invocation-time boundary when --after is absent', async () => {
  await seed([line()]);
  const { read, calls } = trackedReader();
  const pending = awaitResetRelease({ ...opts, runsDir: dir }, { read, now });
  await settle(calls, 1);
  await vi.advanceTimersByTimeAsync(40);
  const result = await pending;
  expect(result.outcome).toBe('deadline');
  expect(result.release).toBeNull();
  expect(result.checks).toBeGreaterThanOrEqual(1);
});

it.each([
  ['equal to the cursor', line({ at: cursor })],
  ['older than the cursor', line({ at: '2026-11-01T18:05:59.999Z' })],
  ['in the future', line({ at: iso(start + 3_600_000) })],
  ['another lane', line({ lane: 'beta' })],
])('reaches deadline on a release %s despite --after', async (_label, seeded) => {
  await seed([seeded]);
  const { read, calls } = trackedReader();
  const pending = awaitResetRelease({ ...opts, runsDir: dir, after: cursor }, { read, now });
  await settle(calls, 1);
  await vi.advanceTimersByTimeAsync(40);
  const result = await pending;
  expect(result.outcome).toBe('deadline');
  expect(result.release).toBeNull();
});

it('treats a future cursor as unsatisfiable and reaches the deadline', async () => {
  await seed([line({ at: iso(start) })]);
  const { read, calls } = trackedReader();
  const pending = awaitResetRelease({ ...opts, runsDir: dir, after: iso(start + 60_000) }, { read, now });
  await settle(calls, 1);
  await vi.advanceTimersByTimeAsync(40);
  expect((await pending).outcome).toBe('deadline');
});

it('rejects malformed and duplicate --after flags before reading', async () => {
  const read = readSpy();
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
    ['--lane', 'a', '--timeout-ms', '1', '--after', cursor, '--after', '2026-11-01T19:00:00Z'],
  ]) {
    expect(await cmdFleetResetReleaseAwait(args, { read, now })).toBe(2);
  }
  expect(read).not.toHaveBeenCalled();
});

it('fails closed on an invalid core after option without reading', async () => {
  const read = readSpy();
  for (const after of ['not-a-date', '2026-11-01', '2026-11-01T18:06:00', '2026-11-01T18:06:00+24:00']) {
    expect((await awaitResetRelease({ ...opts, after }, { read, now })).outcome).toBe('failed');
  }
  expect(read).not.toHaveBeenCalled();
});

it.each(['read', 'sleep'])('cancels during %s with --after and cleans listeners', async phase => {
  const before = process.listenerCount('SIGINT');
  const controller = new AbortController();
  const read = phase === 'read'
    ? () => new Promise<ResetReleaseRecord[]>(() => {})
    : readSpy();
  const pending = awaitResetRelease({ ...opts, after: cursor, signal: controller.signal }, { read, now });
  await vi.advanceTimersByTimeAsync(1);
  controller.abort();
  expect((await pending).outcome).toBe('cancelled');
  expect(process.listenerCount('SIGINT')).toBe(before);
  expect(vi.getTimerCount()).toBe(0);
});

it('exits 1 at the deadline with the audit-only human output under --after', async () => {
  await seed([line({ at: '2026-11-01T00:00:00Z' })]);
  const { read, calls } = trackedReader();
  const out: string[] = [];
  const pending = cmdFleetResetReleaseAwait(
    ['--lane', 'alpha', '--timeout-ms', '40', '--poll-ms', '20', '--runs-dir', dir, '--after', cursor],
    { read, now, emit: text => { out.push(text); } });
  await settle(calls, 1);
  await vi.advanceTimersByTimeAsync(40);
  expect(await pending).toBe(1);
  expect(out[0]).toContain('deadline');
  expect(out[0]).toContain('audit evidence, not present lane health or successful dispatch');
  expect(out[0]).not.toContain(dir);
});

it('help explains the caller-persisted watermark', async () => {
  const read = readSpy();
  const out: string[] = [];
  expect(await cmdFleetResetReleaseAwait(['--help'], { read, emit: text => { out.push(text); } })).toBe(0);
  expect(out[0]).toContain('--after');
  expect(out[0]).toMatch(/persisted|between runs/);
  expect(read).not.toHaveBeenCalled();
});
