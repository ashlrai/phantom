/**
 * RQ-PHX-RESETHISTORYFOLLOW04SOW2 — `ashlr fleet reset-follow` consumes newly
 * recorded reset releases as bounded read-only JSONL while the desktop is
 * closed. All reads are injected fakes.
 */
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { cmdFleetResetFollow } from '../src/cli/fleet-reset-follow.js';
import { resolveFleetSubcommand } from '../src/cli/fleet-subcommand-resolve.js';
import {
  RESET_FOLLOW_MAX_POLL_MS, RESET_FOLLOW_MAX_TIMEOUT_MS, RESET_FOLLOW_SOURCE_LIMIT,
  followResetReleases, type ResetFollowRecord,
} from '../src/core/fleet/reset-history-follow.js';
import type { ResetReleaseRecord } from '../src/core/fleet/usage-reset-release.js';

const T0 = '2026-10-31T19:00:00.000Z', atT0 = () => Date.parse(T0);
const rec = (lane: string, at: string, over: Partial<ResetReleaseRecord> = {}): ResetReleaseRecord =>
  ({ v: 1, by: 'reset-detect', reason: 'private reason', lane, at, state: 'reset-detected',
     usedPct: 3, readingAsOf: '2026-10-31T19:10:00Z', heldUntil: '2026-11-04T00:00:00Z', ...over });
const recA = rec('alpha', '2026-10-31T19:05:00.000Z');
/** Fake monotonic clock: each injected sleep advances time; hook fires per call. */
const clock = (onSleep?: (calls: number) => void) => {
  const sleeps: number[] = []; let t = 1000;
  return { sleeps, now: () => t, sleep: async (ms: number) => { sleeps.push(ms); t += ms; onSleep?.(sleeps.length); } };
};
const collect = () => { const records: ResetFollowRecord[] = []; return { records, emit: (r: ResetFollowRecord) => { records.push(r); } }; };
const deferred = <T>() => {
  let resolve!: (v: T) => void, reject!: (e: Error) => void;
  return { promise: new Promise<T>((y, n) => { resolve = y; reject = n; }), resolve, reject };
};
const releases = (records: ResetFollowRecord[]) =>
  records.filter((r): r is ResetFollowRecord & { lane: string | null } => r.type === 'release');
const cmd = async (args: string[], deps: Parameters<typeof cmdFleetResetFollow>[1] = {}) => {
  const lines: string[] = [], stderr: string[] = [];
  const spy = vi.spyOn(process.stderr, 'write').mockImplementation(m => { stderr.push(String(m)); return true; });
  try { return { code: await cmdFleetResetFollow(args, { emit: l => { lines.push(l); }, ...deps }), lines, stderr: stderr.join('') }; } finally { spy.mockRestore(); }
};
const seqRead = (seq: ResetReleaseRecord[][]) => { let i = 0; return vi.fn(async () => seq[Math.min(i++, seq.length - 1)]!); };

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

it('resolves through the fleet convention without registry edits', async () => {
  expect(resolveFleetSubcommand('reset-follow')).toEqual({ module: './fleet-reset-follow.js', exportName: 'cmdFleetResetFollow' });
  expect(typeof (await import('../src/cli/fleet-reset-follow.js')).cmdFleetResetFollow).toBe('function');
});

it('emits releases newer than the invocation watermark, dedupes, then one summary', async () => {
  // Rows at/before the watermark never emit; repeats dedupe; distinct lanes sharing
  // `at` both emit, oldest-first so a consumer's next --after is honest.
  const recB = rec('beta', '2026-10-31T19:05:00.000Z');
  const read = seqRead([[rec('alpha', T0), rec('alpha', '2026-10-30T00:00:00.000Z')], [recB, recA], [recA, recB]]);
  const { records, emit } = collect(), c = clock();
  const result = await followResetReleases({ timeoutMs: 1000, pollMs: 400 },
    { read, emit, wallNow: atT0, ...c });
  expect(result).toMatchObject({ outcome: 'deadline', reads: 3, emitted: 2, lastError: null });
  expect(c.sleeps).toEqual([400, 400, 200]); // the last sleep is capped by the time left
  expect(releases(records).map(r => r.lane)).toEqual(['alpha', 'beta']);
  expect(records[2]).toMatchObject({ v: 1, type: 'end', outcome: 'deadline', reads: 3, emitted: 2,
    watermark: T0, sourceLimit: RESET_FOLLOW_SOURCE_LIMIT });
});

it('rejects invalid options and arguments before any read or output', async () => {
  const read = vi.fn(), { records, emit } = collect();
  for (const options of [
    { timeoutMs: 0 }, { timeoutMs: RESET_FOLLOW_MAX_TIMEOUT_MS + 1 },
    { timeoutMs: 10, pollMs: 0 }, { timeoutMs: 10, pollMs: RESET_FOLLOW_MAX_POLL_MS + 1 },
    { timeoutMs: 10, after: 'not-a-date' },
  ]) {
    expect(await followResetReleases(options, { read, emit, ...clock() }))
      .toMatchObject({ outcome: 'invalid', reads: 0, emitted: 0 });
  }
  expect(read).not.toHaveBeenCalled(); expect(records).toEqual([]);
  for (const args of [
    [], ['--bogus'], ['positional'], ['--json'], ['--json', '--json'], ['--timeout-ms'],
    ['--timeout-ms', '10'], ['--timeout-ms', 'abc'], ['--timeout-ms', '0'], ['--poll-ms', '10', '--json'],
    ['--timeout-ms', '10', '--timeout-ms', '20', '--json'],
    ['--timeout-ms', String(RESET_FOLLOW_MAX_TIMEOUT_MS + 1), '--json'],
    ['--timeout-ms', '10', '--poll-ms', '1', '--poll-ms', '2', '--json'],
    ['--timeout-ms', '10', '--runs-dir', 'relative', '--json'],
    ['--timeout-ms', '10', '--lane', '--json'], ['--timeout-ms', '10', '--lane', 'a', '--lane', 'b', '--json'],
    ['--timeout-ms', '10', '--after', 'not-a-date', '--json'], ['--timeout-ms', '10', '--after', T0, '--after', T0, '--json'],
  ]) {
    const result = await cmd(args, { read, ...clock() });
    expect(result.code).toBe(2); expect(result.lines).toEqual([]);
    expect(result.stderr).toContain('Usage: ashlr fleet reset-follow');
  }
  expect(read).not.toHaveBeenCalled();
});

it('a thrown read fails visibly once — never retried in a tight loop', async () => {
  const read = vi.fn(async (): Promise<ResetReleaseRecord[]> => { throw new Error('audit vanished'); });
  const { records, emit } = collect();
  const result = await followResetReleases({ timeoutMs: 60_000 }, { read, emit, ...clock() });
  expect(result).toMatchObject({ outcome: 'failed', reads: 0, lastError: 'audit vanished' });
  expect(read).toHaveBeenCalledTimes(1);
  expect(records).toEqual([{ v: 1, type: 'end', outcome: 'failed', reads: 0, emitted: 0,
    lastError: 'audit vanished', watermark: expect.any(String), sourceLimit: RESET_FOLLOW_SOURCE_LIMIT }]);
  expect((await cmd(['--timeout-ms', '60', '--json'], { read, ...clock() })).code).toBe(1);
});

it.each(['deadline', 'cancelled'] as const)('bounds a stalled read on %s and cleans up', async reason => {
  vi.useFakeTimers();
  const pending = deferred<ResetReleaseRecord[]>(), controller = new AbortController();
  const read = vi.fn(() => pending.promise), before = [process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')];
  const following = followResetReleases({ timeoutMs: 100, signal: controller.signal },
    { read, emit: () => {}, wallNow: () => 0 });
  await vi.advanceTimersByTimeAsync(0);
  if (reason === 'deadline') await vi.advanceTimersByTimeAsync(100); else controller.abort();
  expect(await following).toMatchObject({ outcome: reason, reads: 0, emitted: 0, inFlight: true });
  pending.reject(new Error('late failure'));
  await vi.advanceTimersByTimeAsync(0);
  expect([process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')]).toEqual(before);
  expect(vi.getTimerCount()).toBe(0);
});

it.each(['deadline', 'cancelled'] as const)('interrupts a stuck release output on %s', async reason => {
  vi.useFakeTimers();
  const controller = new AbortController(), pending = deferred<void>(), { records, emit } = collect();
  const read = vi.fn(async () => [recA]);
  const following = followResetReleases({ timeoutMs: 100, signal: controller.signal }, {
    read, wallNow: () => 0, emit: r => { emit(r); if (r.type === 'release') return pending.promise; },
  });
  await vi.advanceTimersByTimeAsync(0);
  if (reason === 'deadline') await vi.advanceTimersByTimeAsync(100); else controller.abort();
  expect(await following).toMatchObject({ outcome: reason, reads: 1 });
  pending.reject(new Error('late sink failure'));
  await vi.advanceTimersByTimeAsync(0);
  expect(records.map(r => r.type)).toEqual(['release', 'end']);
  expect(vi.getTimerCount()).toBe(0);
});

it('emits scrubbed JSONL honouring --after/--lane: public fields only, exit 0', async () => {
  const dirty = rec('evil\u001b[31m', '2026-10-31T19:05:00.000Z', {
    readingAsOf: '/private/example/path', heldUntil: `sk-test-${'F'.repeat(22)}` });
  // 'other' is lane-filtered; the equal-T0 row is excluded by the watermark.
  const read = seqRead([[dirty, rec('evil\u001b[31m', T0), rec('other', dirty.at)]]);
  const dir = mkdtempSync(join(tmpdir(), 'reset-follow-'));
  const { code, lines } = await cmd(
    ['--timeout-ms', '10', '--after', T0, '--lane', 'evil\u001b[31m', '--runs-dir', dir, '--json'],
    { read, wallNow: atT0, ...clock() });
  expect(code).toBe(0);
  const parsed = lines.map(l => JSON.parse(l) as ResetFollowRecord);
  const release = parsed[0] as unknown as Record<string, unknown>;
  expect(release).toMatchObject({ v: 1, lane: 'evil\u001b[31m', at: dirty.at, state: 'reset-detected',
    usedPct: 3, readingAsOf: '[path]', heldUntil: '[REDACTED]' });
  expect('reason' in release || 'by' in release).toBe(false);
  for (const bad of ['private reason', '\u001b', '/private/example/path', 'sk-test-'])
    expect(lines.join('')).not.toContain(bad);
  expect(parsed[1]).toMatchObject({ type: 'end', outcome: 'deadline', reads: 1, emitted: 1 });
  expect(readdirSync(dir)).toEqual([]); rmSync(dir, { recursive: true, force: true }); // read-only
});

it('exits 130 on cancellation; help and summary disclose the capped-source gaps', async () => {
  const help = await cmd(['--help']);
  expect(help.code).toBe(0); expect(help.lines.join('')).toContain('not durable exactly-once');
  const controller = new AbortController();
  const { code, lines } = await cmd(['--timeout-ms', '60000', '--json'],
    { read: seqRead([[recA]]), signal: controller.signal, wallNow: atT0, ...clock(() => controller.abort()) });
  expect(code).toBe(130);
  expect(JSON.parse(lines.at(-1)!)).toMatchObject({ type: 'end', outcome: 'cancelled' });
});
