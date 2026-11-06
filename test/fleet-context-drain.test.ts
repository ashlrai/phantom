import * as childProcess from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm, symlink, readdir, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { Writable } from 'node:stream';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cmdFleetContextDrain } from '../src/cli/fleet-context-drain.js';
import { contextReplyRecordPath, savePendingContextReply } from '../src/core/fleet/context-reply-spool.js';
import { acquireLocalStoreLockWithOutcome, releaseLocalStoreLock } from '../src/core/fleet/local-store-lock.js';
import { listBusInboxAfter } from '../src/core/fleet/bus-inbox.js';
import { validateBusEnvelope, type BusEnvelope } from '../src/core/fleet/bus-envelope.js';

// Wrap (not replace) the child-runner surfaces: drain may never launch one,
// while spawnSync-based ACL checks keep working untouched.
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
const drainArgs = (...extra: string[]) => ['--spool-dir', spoolDir, '--json', ...extra];
const report = () => JSON.parse(out) as Record<string, unknown>;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'context-drain-'));
  vi.stubEnv('HOME', root); vi.stubEnv('ASHLR_HOME', join(root, '.ashlr')); vi.stubEnv('ASHLR_RUNS_DIR', join(root, '.ashlr-runs'));
  spoolDir = join(root, 'spool'); busRoot = join(root, 'bus'); out = ''; err = '';
});
afterEach(async () => { vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); });

it('previews pending records without publishing or creating anything', async () => {
  for (const id of ['a', 'b', 'c']) expect(spool(reply(`reply-${id}`))).toBe('saved');
  const before = await readdir(spoolDir);
  expect(await cmdFleetContextDrain(drainArgs(), io(), { root: busRoot })).toBe(0);
  expect(report()).toMatchObject({ status: 'ok', mode: 'preview', matched: 3, selected: 3, truncated: false, exitCode: 0 });
  for (const name of report().records as string[]) expect(name).toMatch(/^reply-[0-9a-f]{32}\.json$/);
  expect(await readdir(spoolDir)).toEqual(before);
  expect(inboxCount()).toBe(0);
  await expect(lstat(busRoot)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('applies delivery to each record; a repeat neither republishes nor spawns a worker', async () => {
  for (const id of ['a', 'b', 'c']) expect(spool(reply(`reply-${id}`))).toBe('saved');
  expect(await cmdFleetContextDrain(drainArgs('--apply'), io(), { root: busRoot })).toBe(0);
  expect(report()).toMatchObject({ status: 'ok', mode: 'apply', matched: 3, selected: 3, exitCode: 0, retained: [] });
  expect(report().counts).toEqual({ posted: 3 });
  expect(await recordNames()).toHaveLength(0);
  expect(inboxCount()).toBe(3);
  out = '';
  expect(await cmdFleetContextDrain(drainArgs('--apply'), io(), { root: busRoot })).toBe(0);
  expect(report()).toMatchObject({ matched: 0, selected: 0, exitCode: 0 });
  expect(inboxCount()).toBe(3);
  expect(childProcess.spawn).not.toHaveBeenCalled();
  expect(childProcess.execFile).not.toHaveBeenCalled();
  expect(childProcess.exec).not.toHaveBeenCalled();
  expect(childProcess.fork).not.toHaveBeenCalled();
}, 30000);

it('delivers eligible records when others are corrupt or expired', async () => {
  expect(spool(reply('reply-good-a'))).toBe('saved');
  expect(spool(reply('reply-good-b'))).toBe('saved');
  await writeFile(join(spoolDir, `reply-${'f'.repeat(32)}.json`), 'not json', { mode: 0o600 });
  expect(spool(reply('reply-old', 1000), Date.now() - 5000)).toBe('saved');
  expect(await cmdFleetContextDrain(drainArgs('--apply'), io(), { root: busRoot })).toBe(2);
  const result = report();
  expect(result.counts).toEqual({ posted: 2, corrupt: 1, expired: 1 });
  const retained = result.retained as string[];
  expect(retained).toHaveLength(2);
  expect((await recordNames()).sort()).toEqual(retained);
  expect(inboxCount()).toBe(2);
}, 30000);

it('reports a contended spool as retryable and drains after release', async () => {
  expect(spool(reply('reply-locked'))).toBe('saved');
  const held = acquireLocalStoreLockWithOutcome(join(spoolDir, 'writer.lock'), 0, { anchorPath: spoolDir, exactPrivateStorage: true });
  expect(held.state).toBe('acquired');
  try {
    expect(await cmdFleetContextDrain(drainArgs('--apply'), io(), { root: busRoot })).toBe(1);
    expect(report()).toMatchObject({ counts: { retryable: 1 } });
    expect(report().retained).toHaveLength(1);
    expect(inboxCount()).toBe(0);
    expect(await recordNames()).toHaveLength(1);
  } finally { releaseLocalStoreLock(held.lock); }
  out = '';
  expect(await cmdFleetContextDrain(drainArgs('--apply'), io(), { root: busRoot })).toBe(0);
  expect(inboxCount()).toBe(1);
}, 30000);

it('returns retryable when the bus cannot accept posts, then recovers', async () => {
  expect(spool(reply('reply-bus-a'))).toBe('saved');
  expect(spool(reply('reply-bus-b'))).toBe('saved');
  await writeFile(busRoot, 'not a directory');
  expect(await cmdFleetContextDrain(drainArgs('--apply'), io(), { root: busRoot })).toBe(1);
  expect(report().counts).toEqual({ unavailable: 2 });
  expect(await recordNames()).toHaveLength(2);
  await rm(busRoot);
  out = '';
  expect(await cmdFleetContextDrain(drainArgs('--apply'), io(), { root: busRoot })).toBe(0);
  expect(inboxCount()).toBe(2);
}, 30000);

it('honors --limit with a deterministic record order', async () => {
  const ids = ['o1', 'o2', 'o3', 'o4', 'o5'];
  for (const id of ids) expect(spool(reply(`reply-${id}`))).toBe('saved');
  const sorted = ids.map(id => basename(contextReplyRecordPath(spoolDir, `reply-${id}`)!)).sort();
  expect(await cmdFleetContextDrain(drainArgs('--apply', '--limit', '2'), io(), { root: busRoot })).toBe(1);
  const result = report();
  expect(result).toMatchObject({ matched: 5, selected: 2, truncated: true });
  expect(result.records).toEqual(sorted.slice(0, 2));
  expect(result.counts).toEqual({ posted: 2 });
  expect(result.retained).toEqual([]);
  expect((await recordNames()).sort()).toEqual(sorted.slice(2));
  expect(inboxCount()).toBe(2);
}, 30000);

it('refuses symlinked, missing or non-private spool directories', async () => {
  await mkdir(join(root, 'real-spool'), { mode: 0o700 });
  await symlink(join(root, 'real-spool'), spoolDir);
  expect(await cmdFleetContextDrain(drainArgs('--apply'), io(), { root: busRoot })).toBe(2);
  expect(report().status).toBe('unsafe');
  await rm(spoolDir);
  out = '';
  expect(await cmdFleetContextDrain(drainArgs('--apply'), io(), { root: busRoot })).toBe(2);
  expect(report().status).toBe('unsafe');
  await expect(lstat(spoolDir)).rejects.toMatchObject({ code: 'ENOENT' });
  await mkdir(spoolDir, { mode: 0o755 });
  out = '';
  expect(await cmdFleetContextDrain(drainArgs(), io(), { root: busRoot })).toBe(2);
  expect(report().status).toBe('unsafe');
});

it('bounds enumeration when the directory overflows with unexpected entries', async () => {
  await mkdir(spoolDir, { mode: 0o700 });
  await Promise.all(Array.from({ length: 2100 }, (_, i) => writeFile(join(spoolDir, `junk-${i}`), 'x', { mode: 0o600 })));
  expect(await cmdFleetContextDrain(drainArgs(), io(), { root: busRoot })).toBe(0);
  expect(report()).toMatchObject({ status: 'ok', scanned: 2048, overflow: true });
});

it('never prints reply ids, bodies or filesystem paths', async () => {
  expect(spool(reply('secret-reply-id-alpha'))).toBe('saved');
  await writeFile(join(spoolDir, `reply-${'f'.repeat(32)}.json`), 'not json', { mode: 0o600 });
  expect(await cmdFleetContextDrain(drainArgs('--apply'), io(), { root: busRoot })).toBe(2);
  for (const leak of ['secret-reply-id-alpha', 'body-secret-reply-id-alpha', 'must-not-run', spoolDir, busRoot, root]) {
    expect(out).not.toContain(leak);
  }
  const result = report();
  for (const name of [...result.records as string[], ...result.retained as string[]]) {
    expect(name).toMatch(/^reply-[0-9a-f]{32}\.json$/);
  }
}, 30000);

it.each([
  ['--json'],
  ['--spool-dir', '/tmp/spool'],
  ['--spool-dir', 'relative/path', '--json'],
  ['--spool-dir', '/tmp/spool', '--json', '--limit', '0'],
  ['--spool-dir', '/tmp/spool', '--json', '--limit', '65'],
  ['--spool-dir', '/tmp/spool', '--json', '--limit', '3.5'],
  ['--spool-dir', '/tmp/spool', '--json', '--wat'],
  ['--spool-dir', '/tmp/spool', '--json', '--apply', '--apply'],
  ['--apply'],
  [],
] as const)('rejects invalid invocation %j', async (...args) => {
  expect(await cmdFleetContextDrain([...args], io(), { root: busRoot })).toBe(2);
  expect(out).toBe('');
  expect(err).toContain('Usage:');
  err = '';
});

it('prints usage for --help', async () => {
  expect(await cmdFleetContextDrain(['--help'], io(), { root: busRoot })).toBe(0);
  expect(out).toContain('context-drain');
});
