/**
 * RQ-PHX-RESETHEADLESS03SOPN1 — `ashlr fleet reset-watch` repeats the guarded
 * runResetReleaseOnce pass while the desktop is closed: one pass now, then
 * one per poll until timeout, stop file or signal. One integration pass
 * drives the real runResetReleaseOnce on a temp runs dir. No real slots.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { cmdFleetResetWatch } from '../src/cli/fleet-reset-watch.js';
import { resolveFleetSubcommand } from '../src/cli/fleet-subcommand-resolve.js';
import {
  RESET_WATCH_MAX_POLL_MS, RESET_WATCH_MAX_TIMEOUT_MS, watchResetReleases,
  type ResetWatchRecord,
} from '../src/core/fleet/reset-release-watch.js';
import { readLaneTargets } from '../src/core/fleet/runs-lane-targets.js';
import { readResetReleases, type ResetReleaseResult } from '../src/core/fleet/usage-reset-release.js';

const AT = '2026-10-31T19:28:00.000Z';
const pass = (over: Partial<ResetReleaseResult> = {}): ResetReleaseResult =>
  ({ at: AT, checked: 2, released: [], bus: [], errors: [], ...over });
const row = (lane: string): ResetReleaseResult['released'][number] =>
  ({ lane, state: 'reset-detected', usedPct: 3, readingAsOf: '2026-10-31T19:10:00Z', heldUntil: '2026-11-04T00:00:00Z' });
/** Fake monotonic clock: each injected sleep advances time; hook fires per call. */
const clock = (onSleep?: (calls: number) => void) => {
  let t = 1000; const sleeps: number[] = [];
  return { sleeps, now: () => t, sleep: async (ms: number) => { sleeps.push(ms); t += ms; onSleep?.(sleeps.length); } };
};
const collect = () => { const records: ResetWatchRecord[] = []; return { records, emit: (r: ResetWatchRecord) => { records.push(r); } }; };
const cmd = async (args: string[], deps: Parameters<typeof cmdFleetResetWatch>[1] = {}) => {
  const lines: string[] = [], stderr: string[] = [];
  const spy = vi.spyOn(process.stderr, 'write').mockImplementation(m => { stderr.push(String(m)); return true; });
  try { return { code: await cmdFleetResetWatch(args, { emit: l => { lines.push(l); }, ...deps }), lines, stderr: stderr.join('') }; } finally { spy.mockRestore(); }
};

const root = mkdtempSync(join(tmpdir(), 'reset-watch-'));
afterEach(() => { vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }); });

it('resolves through the fleet convention without registry edits', async () => {
  expect(resolveFleetSubcommand('reset-watch')).toEqual({ module: './fleet-reset-watch.js', exportName: 'cmdFleetResetWatch' });
  expect(typeof (await import('../src/cli/fleet-reset-watch.js')).cmdFleetResetWatch).toBe('function');
});

it('runs serial passes immediately then at the interval until the deadline', async () => {
  const order: string[] = [], { records, emit } = collect();
  const run = vi.fn(async () => { order.push('run'); return pass(); });
  const c = clock();
  const result = await watchResetReleases({ timeoutMs: 1000, pollMs: 400 },
    { run, now: c.now, emit, sleep: async ms => { order.push('sleep'); await c.sleep(ms); } });
  expect(result).toMatchObject({ outcome: 'deadline', passes: 3, released: 0, errors: 0, lastError: null });
  expect(c.sleeps).toEqual([400, 400, 200]);
  expect(order).toEqual(['run', 'sleep', 'run', 'sleep', 'run', 'sleep']); // no overlap
  expect(records.map(r => r.type)).toEqual(['pass', 'pass', 'pass', 'end']);
  expect(records[3]).toEqual({ v: 1, type: 'end', outcome: 'deadline', passes: 3, released: 0, errors: 0, lastError: null });
});

it('a stop file before the first pass runs zero passes; mid-watch it ends after the completed pass', async () => {
  const run = vi.fn(), { records, emit } = collect();
  const early = await watchResetReleases({ timeoutMs: 1000, stopFile: '/stop' },
    { run, ...clock(), probe: () => 'stop', emit });
  expect(early).toMatchObject({ outcome: 'cancelled', passes: 0 });
  expect(run).not.toHaveBeenCalled();
  expect(records).toEqual([{ v: 1, type: 'end', outcome: 'cancelled', passes: 0, released: 0, errors: 0, lastError: null }]);
  let probes = 0;
  const mid = await watchResetReleases({ timeoutMs: 60_000, pollMs: 1000, stopFile: '/stop' },
    { run: vi.fn(async () => pass({ released: [row('lane-a')] })), ...clock(),
      probe: () => (++probes === 1 ? 'go' : 'stop'), emit });
  expect(mid).toMatchObject({ outcome: 'cancelled', passes: 1, released: 1 });
  expect(records.map(r => r.type)).toEqual(['end', 'pass', 'end']);
  expect(records[1]).toMatchObject({ released: 1, lanes: ['lane-a'] });
});

it('an abort mid-sleep cancels before the next pass; signal handlers are restored', async () => {
  const controller = new AbortController(), run = vi.fn(async () => pass());
  const before = [process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')];
  const result = await watchResetReleases({ timeoutMs: 60_000, signal: controller.signal },
    { run, ...clock(() => { controller.abort(); process.emit('SIGTERM'); }) });
  expect(result).toMatchObject({ outcome: 'cancelled', passes: 1 });
  expect(run).toHaveBeenCalledTimes(1);
  expect([process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')]).toEqual(before);
});

it('a thrown pass fails visibly once — never retried in a tight loop', async () => {
  const run = vi.fn(async (): Promise<ResetReleaseResult> => { throw new Error('provider blew up'); });
  const { records, emit } = collect();
  const result = await watchResetReleases({ timeoutMs: 60_000 }, { run, ...clock(), emit });
  expect(result).toMatchObject({ outcome: 'failed', passes: 0, lastError: 'provider blew up' });
  expect(run).toHaveBeenCalledTimes(1);
  expect(records).toEqual([{ v: 1, type: 'end', outcome: 'failed', passes: 0, released: 0,
    errors: 0, lastError: 'provider blew up' }]);
});

it('rejects bad arguments before any work: exit 2, no pass, no output', async () => {
  const run = vi.fn();
  expect((await cmd(['--help'], { run })).code).toBe(0);
  for (const args of [
    [], ['--bogus'], ['positional'], ['--json', '--json'], ['--timeout-ms'], ['--timeout-ms=10'],
    ['--timeout-ms', 'abc'], ['--timeout-ms', '0'], ['--timeout-ms', '1e3'],
    ['--timeout-ms', '10', '--timeout-ms', '20'], ['--timeout-ms', String(RESET_WATCH_MAX_TIMEOUT_MS + 1)],
    ['--timeout-ms', '10', '--poll-ms', '0'], ['--timeout-ms', '10', '--poll-ms', String(RESET_WATCH_MAX_POLL_MS + 1)],
    ['--timeout-ms', '10', '--poll-ms', '1', '--poll-ms', '2'],
    ['--timeout-ms', '10', '--runs-dir', 'relative'], ['--timeout-ms', '10', '--runs-dir'],
    ['--timeout-ms', '10', '--stop-file'], ['--timeout-ms', '10', '--stop-file', '/a', '--stop-file', '/b'],
    ['--poll-ms', '10'],
  ]) {
    const { code, lines, stderr } = await cmd(args, { run, ...clock() });
    expect(code).toBe(2);
    expect(lines).toEqual([]);
    expect(stderr).toContain('Usage: ashlr fleet reset-watch');
  }
  expect(run).not.toHaveBeenCalled();
});

it('emits scrubbed JSONL pass lines and a terminal summary, exit 0 on a clean deadline', async () => {
  const run = vi.fn(async () => pass({ released: [row('lane-a')] }));
  const { code, lines } = await cmd(['--timeout-ms', '1000', '--poll-ms', '400', '--json'], { run, ...clock() });
  expect(code).toBe(0);
  expect(lines.map(l => (JSON.parse(l) as ResetWatchRecord).type)).toEqual(['pass', 'pass', 'pass', 'end']);
  expect(JSON.parse(lines[0]!)).toMatchObject({ v: 1, at: AT, checked: 2, released: 1, lanes: ['lane-a'], errors: [] });
});

it('exits 1 on lane errors and never prints raw paths or secret-shaped text', async () => {
  const dirty = { lane: 'lane-x', message: `audit append failed at ${process.env.HOME}/runs/x for github_pat_${'a'.repeat(30)}` };
  const run = vi.fn(async () => pass({ errors: [dirty] }));
  for (const args of [['--timeout-ms', '10', '--json'], ['--timeout-ms', '10']]) {
    const { code, lines } = await cmd(args, { run, ...clock() });
    expect(code).toBe(1);
    expect(lines.join('\n')).not.toContain(process.env.HOME!);
    expect(lines.join('\n')).not.toContain('github_pat_');
  }
  const { lines } = await cmd(['--timeout-ms', '10', '--json'], { run, ...clock() });
  expect(JSON.parse(lines[0]!)).toMatchObject({ type: 'pass', errors: [{ lane: 'lane-x', message: expect.stringContaining('~') }] });
});

it('exits 1 when a pass throws and 130 on cancellation', async () => {
  const failing = vi.fn(async (): Promise<ResetReleaseResult> => { throw new Error('kaboom'); });
  expect((await cmd(['--timeout-ms', '60', '--json'], { run: failing, ...clock() })).code).toBe(1);
  const controller = new AbortController(),
    { code, lines } = await cmd(['--timeout-ms', '60000', '--json'],
      { run: vi.fn(async () => pass()), signal: controller.signal, ...clock(() => controller.abort()) });
  expect(code).toBe(130);
  expect(JSON.parse(lines.at(-1)!)).toMatchObject({ type: 'end', outcome: 'cancelled' });
});

it('drives the real runResetReleaseOnce twice and never releases the manual hold', async () => {
  const T0 = Date.parse('2026-10-31T19:00:00Z'), UNTIL = '2026-11-04T00:00:00Z', runsDir = join(root, 'runs');
  const slot = (held_by: string, held_reason: string, held_until?: string) =>
    ({ target: 1, floor: 0, ceiling: 2, held: true, held_reason, held_until, held_by, last_change: T0 / 1000 });
  mkdirSync(join(runsDir, 'queue'), { recursive: true });
  writeFileSync(join(runsDir, 'queue/slots.json'), JSON.stringify({
    'lane-a': slot('autobackoff', `autobackoff fake job=j-1 until=${UNTIL} src=fake`, UNTIL),
    'lane-b': slot('Mason t1221u', 'manual: operator'),
  }));
  writeFileSync(join(runsDir, 'queue/status.json'), JSON.stringify({
    last_tick: '2026-10-31T19:10:00Z',
    lanes: { 'lane-a': { held: true }, 'lane-b': { held: true } },
    budget: { 'lane-a': { weekly_used_pct: 3 }, 'lane-b': { weekly_used_pct: 0 } },
  }));
  const { records, emit } = collect();
  const result = await watchResetReleases({ timeoutMs: 2, pollMs: 1, runsDir }, { ...clock(), emit });
  expect(result).toMatchObject({ outcome: 'deadline', passes: 2, released: 1, errors: 0 });
  expect(records.map(r => r.type)).toEqual(['pass', 'pass', 'end']);
  const lanes = (await readLaneTargets({ runsDir })).lanes;
  expect(lanes.find(l => l.lane === 'lane-a')).toMatchObject({ held: false, changedBy: expect.stringContaining('reset-detect') });
  expect(lanes.find(l => l.lane === 'lane-b')).toMatchObject({ held: true, heldReason: 'manual: operator' });
  expect((await readResetReleases(runsDir)).map(r => r.lane)).toEqual(['lane-a']);
});
