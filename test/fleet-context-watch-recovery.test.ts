import * as childProcess from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm, readdir, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cmdFleetContextWatch } from '../src/cli/fleet-context-watch.js';
import { watchContextReplySpool } from '../src/core/fleet/context-spool-watch.js';
import { savePendingContextReply } from '../src/core/fleet/context-reply-spool.js';
import { listBusInboxAfter } from '../src/core/fleet/bus-inbox.js';
import { validateBusEnvelope, type BusEnvelope } from '../src/core/fleet/bus-envelope.js';

// Wrap (not replace) the child-runner surfaces: the watch may never launch a
// worker, while spawnSync-based ACL checks keep working untouched.
vi.mock('node:child_process', async importOriginal => {
  const mod = await importOriginal<typeof import('node:child_process')>();
  return { ...mod, spawn: vi.fn(mod.spawn), execFile: vi.fn(mod.execFile), exec: vi.fn(mod.exec), fork: vi.fn(mod.fork) };
});

let root: string, spoolDir: string, busRoot: string, out: string, err: string;
const sink = (write: (s: string) => void) => new Writable({ write(c, _e, done) { write(String(c)); done(); } });
const io = () => ({ stdout: sink(s => { out += s; }), stderr: sink(s => { err += s; }) });
const env = (value: BusEnvelope) => { const checked = validateBusEnvelope(value); if (!checked.ok) throw new Error('bad fixture'); return checked.value; };
const reply = (id: string, ttl = 60000): BusEnvelope =>
  env({ id, from: 'worker', to: 'requester', priority: 'P2', ttl, body: { command: 'touch must-not-run', note: `body-${id}` } });
const spool = (envelope: BusEnvelope, preparedAt = Date.now()) =>
  savePendingContextReply(spoolDir, { reply: envelope, preparedAt, workerExit: { status: 'returned', exitCode: 0 } });
const recordNames = async () => (await readdir(spoolDir)).filter(n => /^reply-[0-9a-f]{32}\.json$/.test(n));
const inboxCount = () => { const page = listBusInboxAfter(0, 100, { root: busRoot }); return page.status === 'ok' ? page.messages.length : -1; };
const report = () => JSON.parse(out) as Record<string, unknown>;
const watchArgs = (...extra: string[]) =>
  ['--spool-dir', spoolDir, '--duration-ms', '60000', '--interval-ms', '1000', '--limit', '4', '--json', ...extra];

/** Deterministic bounded watch: a fake monotonic clock that only advances when
 * the injected interval delay runs, plus optional per-delay effects. */
const fakeDeps = (...effects: Array<() => void | Promise<void>>) => {
  let t = 0;
  const delays: number[] = [];
  return {
    delays,
    deps: {
      clock: () => t,
      delay: async (ms: number) => { delays.push(ms); t += ms; await effects.shift()?.(); },
    },
  };
};

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'context-watch-'));
  vi.stubEnv('HOME', root); vi.stubEnv('ASHLR_HOME', join(root, '.ashlr')); vi.stubEnv('ASHLR_RUNS_DIR', join(root, '.ashlr-runs'));
  spoolDir = join(root, 'spool'); busRoot = join(root, 'bus'); out = ''; err = '';
});
afterEach(async () => { vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); });

it('delivers a reply exactly once after the bus recovers, never running a worker', async () => {
  expect(spool(reply('reply-retry'))).toBe('saved');
  await writeFile(busRoot, 'not a directory'); // the bus cannot accept posts
  const sigint = process.listenerCount('SIGINT'), sigterm = process.listenerCount('SIGTERM');
  const { deps } = fakeDeps(() => rm(busRoot));
  const code = await cmdFleetContextWatch([...watchArgs(), '--apply'], io(), { root: busRoot }, deps);
  expect(code).toBe(0);
  const result = report();
  expect(result).toMatchObject({ status: 'ok', mode: 'apply', reason: 'duration-expired', delivered: 1, unresolved: 0, exitCode: 0 });
  expect(result.counts).toEqual({ unavailable: 1, posted: 1 });
  expect(result.sweeps).toBeGreaterThanOrEqual(2);
  expect(inboxCount()).toBe(1);
  expect(await recordNames()).toHaveLength(0);
  expect(process.listenerCount('SIGINT')).toBe(sigint);
  expect(process.listenerCount('SIGTERM')).toBe(sigterm);
  for (const spy of [childProcess.spawn, childProcess.execFile, childProcess.exec, childProcess.fork]) {
    expect(spy).not.toHaveBeenCalled();
  }
}, 30000);

it('keeps watching an empty spool and delivers a reply that arrives later', async () => {
  await mkdir(spoolDir, { mode: 0o700 });
  const { deps } = fakeDeps(() => { expect(spool(reply('reply-late'))).toBe('saved'); });
  const summary = await watchContextReplySpool(
    { spoolDir, durationMs: 300, intervalMs: 100, limit: 4, apply: true },
    { root: busRoot }, deps);
  expect(summary).toMatchObject({ reason: 'duration-expired', sweeps: 3, batches: 3, attempts: 1, delivered: 1, unresolved: 0, exitCode: 0 });
  expect(summary.counts).toEqual({ posted: 1 });
  expect(inboxCount()).toBe(1);
}, 30000);

it('follows nextRecord past a retained failure so it cannot starve another record', async () => {
  expect(spool(reply('reply-good'))).toBe('saved');
  // Highest possible record name: the corrupt batch member sorts last, so a
  // limit-1 sweep must chain a second batch past whatever the first retains.
  await mkdir(spoolDir, { mode: 0o700, recursive: true });
  await writeFile(join(spoolDir, `reply-${'f'.repeat(32)}.json`), 'not json', { mode: 0o600 });
  const { deps } = fakeDeps();
  const summary = await watchContextReplySpool(
    { spoolDir, durationMs: 100, intervalMs: 100, limit: 1, apply: true },
    { root: busRoot }, deps);
  expect(summary).toMatchObject({ reason: 'duration-expired', sweeps: 1, batches: 2, attempts: 2, lastSweepComplete: true });
  expect(summary.counts).toEqual({ posted: 1, corrupt: 1 });
  // The retained corrupt record is unresolved, never a delivery.
  expect(summary).toMatchObject({ delivered: 1, unresolved: 1, exitCode: 1 });
  expect(inboxCount()).toBe(1);
  expect(await recordNames()).toEqual([`reply-${'f'.repeat(32)}.json`]);
}, 30000);

it('ends a stalled pass instead of busy-looping when overflow freezes the cursor', async () => {
  await mkdir(spoolDir, { mode: 0o700 });
  await Promise.all(Array.from({ length: 2100 }, (_, i) => writeFile(join(spoolDir, `junk-${i}`), 'x', { mode: 0o600 })));
  const { deps, delays } = fakeDeps();
  const summary = await watchContextReplySpool(
    { spoolDir, durationMs: 300, intervalMs: 100, limit: 4, apply: true },
    { root: busRoot }, deps);
  expect(summary.reason).toBe('duration-expired');
  expect(summary.sweeps).toBe(3);
  // First pass: one batch to discover the stall, one to confirm it. Later
  // passes stall on the first batch — every pass ends in a real interval wait.
  expect(summary.batches).toBeLessThanOrEqual(4);
  expect(delays).toEqual([100, 100, 100]);
}, 30000);

it('preview runs one batch, writes nothing and exits', async () => {
  for (const id of ['a', 'b']) expect(spool(reply(`reply-${id}`))).toBe('saved');
  const before = await readdir(spoolDir);
  const code = await cmdFleetContextWatch(watchArgs(), io(), { root: busRoot });
  expect(code).toBe(0);
  expect(report()).toMatchObject({ status: 'ok', mode: 'preview', reason: 'preview-complete', sweeps: 1, batches: 1, attempts: 0, delivered: 0, unresolved: 2 });
  expect(report().counts).toEqual({});
  expect(await readdir(spoolDir)).toEqual(before);
  expect(inboxCount()).toBe(0);
  await expect(lstat(busRoot)).rejects.toMatchObject({ code: 'ENOENT' });
}, 30000);

it('cancelling interrupts the interval sleep promptly', async () => {
  await mkdir(spoolDir, { mode: 0o700 });
  const controller = new AbortController();
  const started = Date.now();
  const summary = await watchContextReplySpool(
    { spoolDir, durationMs: 3_600_000, intervalMs: 60_000, limit: 4, apply: true },
    { root: busRoot },
    {
      signal: controller.signal,
      // Mirrors the default abortable wait; abort lands mid-sleep.
      delay: (ms, signal) => new Promise<void>(resolve => {
        const done = (): void => { clearTimeout(timer); signal?.removeEventListener('abort', done); resolve(); };
        const timer = setTimeout(done, ms);
        signal?.addEventListener('abort', done, { once: true });
        setImmediate(() => controller.abort());
      }),
    });
  expect(summary).toMatchObject({ status: 'cancelled', reason: 'cancelled', exitCode: 1 });
  expect(Date.now() - started).toBeLessThan(30_000);
}, 30000);

it('reports unsafe storage and stops without retrying', async () => {
  await mkdir(spoolDir, { mode: 0o755 });
  const { deps, delays } = fakeDeps();
  const summary = await watchContextReplySpool(
    { spoolDir, durationMs: 300, intervalMs: 100, limit: 4, apply: true },
    { root: busRoot }, deps);
  expect(summary).toMatchObject({ status: 'unsafe', reason: 'unsafe', exitCode: 2 });
  expect(delays).toHaveLength(0);
});

it('expires on an empty spool as bounded completion with nothing unresolved', async () => {
  await mkdir(spoolDir, { mode: 0o700 });
  const { deps } = fakeDeps();
  const summary = await watchContextReplySpool(
    { spoolDir, durationMs: 250, intervalMs: 100, limit: 4, apply: true },
    { root: busRoot }, deps);
  expect(summary).toMatchObject({ status: 'ok', reason: 'duration-expired', delivered: 0, unresolved: 0, lastSweepComplete: true, exitCode: 0 });
});

it('never prints reply ids, bodies or filesystem paths', async () => {
  expect(spool(reply('secret-reply-id-beta'))).toBe('saved');
  const { deps } = fakeDeps();
  const code = await cmdFleetContextWatch([...watchArgs(), '--apply'], io(), { root: busRoot }, deps);
  expect(code).toBe(0);
  for (const leak of ['secret-reply-id-beta', 'body-secret-reply-id-beta', 'must-not-run', spoolDir, busRoot, root]) {
    expect(out).not.toContain(leak);
  }
}, 30000);

it.each([
  [] as const,
  ['--json'] as const,
  ['--spool-dir', spoolDir, '--json'] as const,
  ['--spool-dir', 'relative/path', '--duration-ms', '1000', '--interval-ms', '100', '--limit', '4', '--json'] as const,
  ['--spool-dir', spoolDir, '--duration-ms', '0', '--interval-ms', '100', '--limit', '4', '--json'] as const,
  ['--spool-dir', spoolDir, '--duration-ms', '3600001', '--interval-ms', '100', '--limit', '4', '--json'] as const,
  ['--spool-dir', spoolDir, '--duration-ms', 'x', '--interval-ms', '100', '--limit', '4', '--json'] as const,
  ['--spool-dir', spoolDir, '--duration-ms', '1000', '--interval-ms', '99', '--limit', '4', '--json'] as const,
  ['--spool-dir', spoolDir, '--duration-ms', '1000', '--interval-ms', '60001', '--limit', '4', '--json'] as const,
  ['--spool-dir', spoolDir, '--duration-ms', '1000', '--interval-ms', '100', '--limit', '0', '--json'] as const,
  ['--spool-dir', spoolDir, '--duration-ms', '1000', '--interval-ms', '100', '--limit', '65', '--json'] as const,
  ['--spool-dir', spoolDir, '--duration-ms', '1000', '--interval-ms', '100', '--limit', '4'] as const,
  ['--spool-dir', spoolDir, '--duration-ms', '1000', '--interval-ms', '100', '--limit', '4', '--json', '--wat'] as const,
  ['--spool-dir', spoolDir, '--duration-ms', '1000', '--interval-ms', '100', '--limit', '4', '--json', '--apply', '--apply'] as const,
  ['--spool-dir', spoolDir, '--duration-ms', '1000', '--duration-ms', '1000', '--interval-ms', '100', '--limit', '4', '--json'] as const,
] as const)('rejects invalid invocation %j without launching a sweep', async (...args) => {
  expect(spool(reply('reply-idle'))).toBe('saved');
  const sigint = process.listenerCount('SIGINT');
  expect(await cmdFleetContextWatch([...args], io(), { root: busRoot })).toBe(2);
  expect(out).toBe('');
  expect(err).toContain('Usage:');
  expect(await recordNames()).toHaveLength(1);
  expect(inboxCount()).toBe(0);
  expect(process.listenerCount('SIGINT')).toBe(sigint);
  err = '';
});

it('prints usage for --help', async () => {
  expect(await cmdFleetContextWatch(['--help'], io(), { root: busRoot })).toBe(0);
  expect(out).toContain('context-watch');
});
