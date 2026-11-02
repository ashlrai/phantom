import * as childProcess from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { Writable } from 'node:stream';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cmdFleetContextDrain } from '../src/cli/fleet-context-drain.js';
import { drainContextReplySpool } from '../src/core/fleet/context-spool-drain.js';
import { contextReplyRecordPath, savePendingContextReply } from '../src/core/fleet/context-reply-spool.js';
import { listBusInboxAfter } from '../src/core/fleet/bus-inbox.js';
import { validateBusEnvelope, type BusEnvelope } from '../src/core/fleet/bus-envelope.js';

// Wrap (not replace) the child-runner surfaces: drain may never launch one,
// while spawnSync-based ACL checks keep working untouched.
vi.mock('node:child_process', async importOriginal => {
  const mod = await importOriginal<typeof import('node:child_process')>();
  return { ...mod, spawn: vi.fn(mod.spawn), execFile: vi.fn(mod.execFile), exec: vi.fn(mod.exec), fork: vi.fn(mod.fork) };
});

const RECORD = /^reply-[0-9a-f]{32}\.json$/;
const LOWEST_RECORD = `reply-${'0'.repeat(32)}.json`;
const VALID_NAME = `reply-${'a'.repeat(32)}.json`;

let root: string, spoolDir: string, busRoot: string, out: string, err: string;
const sink = (write: (s: string) => void) => new Writable({ write(c, _e, done) { write(String(c)); done(); } });
const io = () => ({ stdout: sink(s => { out += s; }), stderr: sink(s => { err += s; }) });
const env = (value: BusEnvelope) => { const checked = validateBusEnvelope(value); if (!checked.ok) throw new Error('bad fixture'); return checked.value; };
const reply = (id: string, ttl = 60000): BusEnvelope =>
  env({ id, from: 'worker', to: 'requester', priority: 'P2', ttl, body: { command: 'touch must-not-run', note: `body-${id}` } });
const spool = (envelope: BusEnvelope, preparedAt = Date.now()) =>
  savePendingContextReply(spoolDir, { reply: envelope, preparedAt, workerExit: { status: 'returned', exitCode: 0 } });
const name = (id: string) => basename(contextReplyRecordPath(spoolDir, id)!);
const recordNames = async () => (await readdir(spoolDir)).filter(n => RECORD.test(n));
const inboxCount = () => { const page = listBusInboxAfter(0, 100, { root: busRoot }); return page.status === 'ok' ? page.messages.length : -1; };
const drainArgs = (...extra: string[]) => ['--spool-dir', spoolDir, '--json', ...extra];
const report = () => JSON.parse(out) as Record<string, unknown>;

/** Two saved-record identities whose deterministic names sort stuck before later. */
const orderedPair = () => {
  const a = name('reply-stuck'), b = name('reply-deliverable');
  return a < b
    ? { stuckId: 'reply-stuck', laterId: 'reply-deliverable', stuck: a, later: b }
    : { stuckId: 'reply-deliverable', laterId: 'reply-stuck', stuck: b, later: a };
};

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'context-drain-cont-'));
  vi.stubEnv('HOME', root); vi.stubEnv('ASHLR_HOME', join(root, '.ashlr')); vi.stubEnv('ASHLR_RUNS_DIR', join(root, '.ashlr-runs'));
  spoolDir = join(root, 'spool'); busRoot = join(root, 'bus'); out = ''; err = '';
});
afterEach(async () => { vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); });

it('resumes a bounded sweep past a retained failure without deleting it or rerunning a worker', async () => {
  const pair = orderedPair();
  // A real saved record that always fails delivery (TTL already elapsed) and
  // sorts first: with a small limit it starves the deliverable reply today.
  expect(spool(reply(pair.stuckId, 1000), Date.now() - 5000)).toBe('saved');
  expect(spool(reply(pair.laterId))).toBe('saved');

  expect(await cmdFleetContextDrain(drainArgs('--apply', '--limit', '1'), io(), { root: busRoot })).toBe(2);
  let result = report();
  expect(result).toMatchObject({ status: 'ok', mode: 'apply', matched: 2, selected: 1, truncated: true });
  expect(result.records).toEqual([pair.stuck]);
  expect(result.counts).toEqual({ expired: 1 });
  // The cursor advances over the attempted record even though it was retained.
  expect(result.retained).toEqual([pair.stuck]);
  expect(result.nextRecord).toBe(pair.stuck);
  expect(inboxCount()).toBe(0);

  out = '';
  expect(await cmdFleetContextDrain(drainArgs('--apply', '--limit', '1', '--after-record', pair.stuck), io(), { root: busRoot })).toBe(0);
  result = report();
  expect(result).toMatchObject({ matched: 2, selected: 1, truncated: false });
  expect(result.records).toEqual([pair.later]);
  expect(result.counts).toEqual({ posted: 1 });
  expect(result.retained).toEqual([]);
  expect(result.nextRecord).toBeNull();
  expect(inboxCount()).toBe(1);

  // The retained failure was never deleted and no worker ever ran.
  expect(await recordNames()).toEqual([pair.stuck]);
  for (const spy of [childProcess.spawn, childProcess.execFile, childProcess.exec, childProcess.fork]) {
    expect(spy).not.toHaveBeenCalled();
  }
  for (const leak of [pair.stuckId, pair.laterId, `body-${pair.laterId}`, 'must-not-run', spoolDir, busRoot, root]) {
    expect(out).not.toContain(leak);
  }
}, 30000);

it('previews the continuation batch with no effects, then applies it to the end of the sweep', async () => {
  for (const id of ['reply-p1', 'reply-p2', 'reply-p3']) expect(spool(reply(id))).toBe('saved');
  const [n1, n2, n3] = (await recordNames()).sort() as [string, string, string];

  const before = await readdir(spoolDir);
  expect(await cmdFleetContextDrain(drainArgs('--after-record', n1, '--limit', '1'), io(), { root: busRoot })).toBe(0);
  let result = report();
  expect(result).toMatchObject({ status: 'ok', mode: 'preview', matched: 3, selected: 1, truncated: true, exitCode: 0 });
  expect(result.records).toEqual([n2]);
  expect(result.nextRecord).toBe(n2);
  expect(await readdir(spoolDir)).toEqual(before);
  expect(inboxCount()).toBe(0);

  out = '';
  expect(await cmdFleetContextDrain(drainArgs('--apply', '--after-record', n1, '--limit', '1'), io(), { root: busRoot })).toBe(1);
  result = report();
  expect(result.records).toEqual([n2]);
  expect(result.counts).toEqual({ posted: 1 });
  expect(result.nextRecord).toBe(n2);

  out = '';
  expect(await cmdFleetContextDrain(drainArgs('--apply', '--after-record', n2, '--limit', '1'), io(), { root: busRoot })).toBe(0);
  result = report();
  expect(result.records).toEqual([n3]);
  expect(result.counts).toEqual({ posted: 1 });
  expect(result.nextRecord).toBeNull();
  expect(inboxCount()).toBe(2);
  // n1 sat behind the cursor the whole sweep: never attempted, still spooled.
  expect(await recordNames()).toEqual([n1]);
}, 30000);

it('resumes by lexical comparison when the cursor record is gone from disk', async () => {
  for (const id of ['reply-g1', 'reply-g2', 'reply-g3']) expect(spool(reply(id))).toBe('saved');
  const [n1, n2, n3] = (await recordNames()).sort() as [string, string, string];
  await rm(join(spoolDir, n2));

  expect(await cmdFleetContextDrain(drainArgs('--apply', '--after-record', n2), io(), { root: busRoot })).toBe(0);
  const result = report();
  expect(result).toMatchObject({ matched: 2, selected: 1, truncated: false });
  expect(result.records).toEqual([n3]);
  expect(result.counts).toEqual({ posted: 1 });
  expect(result.nextRecord).toBeNull();
  expect(await recordNames()).toEqual([n1]);
  expect(inboxCount()).toBe(1);
}, 30000);

it('reports an explicit end of sweep and never wraps back to the first record', async () => {
  const pair = orderedPair();
  expect(spool(reply(pair.stuckId, 1000), Date.now() - 5000)).toBe('saved');
  expect(spool(reply(pair.laterId))).toBe('saved');

  expect(await cmdFleetContextDrain(drainArgs('--apply', '--after-record', pair.stuck), io(), { root: busRoot })).toBe(0);
  expect(report()).toMatchObject({ counts: { posted: 1 }, nextRecord: null });

  // A cursor at the last record selects nothing and still ends the sweep; the
  // retained failure behind the cursor is not re-attempted.
  out = '';
  expect(await cmdFleetContextDrain(drainArgs('--apply', '--after-record', pair.later), io(), { root: busRoot })).toBe(0);
  const result = report();
  expect(result).toMatchObject({ selected: 0, truncated: false, nextRecord: null });
  expect(result.counts).toEqual({});
  expect(await recordNames()).toEqual([pair.stuck]);

  // A new sweep (no cursor) is the only way back: it re-attempts the retained record.
  out = '';
  expect(await cmdFleetContextDrain(drainArgs('--apply'), io(), { root: busRoot })).toBe(2);
  expect(report().counts).toEqual({ expired: 1 });
}, 30000);

it('keeps the resume cursor honest when enumeration overflows the scan cap', async () => {
  await mkdir(spoolDir, { mode: 0o700 });
  await Promise.all(Array.from({ length: 2100 }, (_, i) => writeFile(join(spoolDir, `junk-${i}`), 'x', { mode: 0o600 })));

  expect(await cmdFleetContextDrain(drainArgs(), io(), { root: busRoot })).toBe(0);
  let result = report();
  // Coverage is incomplete: the cursor must stay resumable, never claim the end.
  expect(result).toMatchObject({ status: 'ok', scanned: 2048, overflow: true, matched: 0, selected: 0, nextRecord: LOWEST_RECORD });

  // With an incoming cursor the report echoes exactly that covered point: it
  // must not name a record the bounded scan may never have seen.
  out = '';
  expect(await cmdFleetContextDrain(drainArgs('--apply', '--after-record', VALID_NAME), io(), { root: busRoot })).toBe(1);
  result = report();
  expect(result.overflow).toBe(true);
  expect(result.nextRecord).toBe(VALID_NAME);
}, 30000);

it.each([
  'not-a-record',
  `reply-${'0'.repeat(31)}.json`,
  `reply-${'0'.repeat(33)}.json`,
  `reply-${'g'.repeat(32)}.json`,
  `reply-${'A'.repeat(32)}.json`,
  `reply-${'0'.repeat(32)}`,
  `reply-${'0'.repeat(32)}.JSON`,
  `/tmp/reply-${'0'.repeat(32)}.json`,
  `../spool/reply-${'0'.repeat(32)}.json`,
  ` reply-${'0'.repeat(32)}.json`,
])('rejects malformed or path cursor %j before any effect', async cursor => {
  expect(spool(reply('reply-target'))).toBe('saved');
  const before = await readdir(spoolDir);

  const direct = drainContextReplySpool({ spoolDir, apply: true, afterRecord: cursor }, { root: busRoot });
  expect(direct).toMatchObject({ status: 'invalid', selected: 0, nextRecord: null, exitCode: 2 });
  expect(await cmdFleetContextDrain(drainArgs('--apply', '--after-record', cursor), io(), { root: busRoot })).toBe(2);
  expect(out).toBe('');
  expect(err).toContain('Usage:');
  expect(await readdir(spoolDir)).toEqual(before);
  expect(inboxCount()).toBe(0);
  out = ''; err = '';
}, 30000);

it.each([
  ['--after-record', VALID_NAME, '--after-record', VALID_NAME],
  ['--after-record'],
  ['--after-record', '--apply'],
  ['--after-record', ''],
] as const)('rejects bad --after-record usage %j', async (...extra) => {
  expect(spool(reply('reply-target'))).toBe('saved');
  expect(await cmdFleetContextDrain(drainArgs(...extra), io(), { root: busRoot })).toBe(2);
  expect(out).toBe('');
  expect(err).toContain('Usage:');
  expect(await recordNames()).toHaveLength(1);
  err = '';
});
