import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cmdFleetContextDeliver } from '../src/cli/fleet-context-deliver.js';
import {
  contextReplyRecordPath, savePendingContextReply, SPOOL_MAX_RECORDS,
} from '../src/core/fleet/context-reply-spool.js';
import { listBusInboxAfter } from '../src/core/fleet/bus-inbox.js';
import { validateBusEnvelope, type BusEnvelope } from '../src/core/fleet/bus-envelope.js';

let root: string, snapshot: string, prompt: string, requestFile: string, marker: string, busRoot: string, spoolDir: string;
let out: string, err: string;
const request = (ttl = 60000): BusEnvelope => ({ id: 'request', from: 'requester', to: 'worker', priority: 'P1', ttl, body: { command: 'never execute this' } });
const sink = (write: (s: string) => void) => new Writable({ write(c, _e, done) { write(String(c)); done(); } });
const io = () => ({ stdout: sink(s => { out += s; }), stderr: sink(s => { err += s; }) });
const childArgv = (exit: number) => [process.execPath, '-e',
  `require('node:fs').appendFileSync(${JSON.stringify(marker)},'spawn\\n');process.stdin.on('data',()=>{});process.stdin.on('end',()=>process.exit(${exit}))`];
const runArgs = (exit = 0) => ['--snapshot', snapshot, '--prompt', prompt, '--request-file', requestFile,
  '--reply-id', 'reply', '--spool-dir', spoolDir, '--', ...childArgv(exit)];
const records = async () => (await readdir(spoolDir)).filter(n => /^reply-[0-9a-f]{32}\.json$/.test(n));
const env = (value: BusEnvelope) => { const checked = validateBusEnvelope(value); if (!checked.ok) throw new Error('bad fixture'); return checked; };
const spool = (reply: BusEnvelope, preparedAt = Date.now()) =>
  savePendingContextReply(spoolDir, { reply, preparedAt, workerExit: { status: 'returned', exitCode: 0 } });
const recordJson = (wire: string) => JSON.stringify({ version: 1, wire, preparedAt: Date.now(), workerExit: { status: 'returned', exitCode: 0 } });

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'context-deliver-'));
  vi.stubEnv('HOME', root); vi.stubEnv('ASHLR_HOME', join(root, '.ashlr')); vi.stubEnv('ASHLR_RUNS_DIR', join(root, '.ashlr-runs'));
  await mkdir(join(root, '.ashlr-runs'), { mode: 0o700 });
  snapshot = join(root, 'snapshot.json'); prompt = join(root, 'prompt.txt'); requestFile = join(root, 'request.json');
  marker = join(root, 'spawn.txt'); busRoot = join(root, 'bus'); spoolDir = join(root, 'spool'); out = ''; err = '';
  await writeFile(snapshot, JSON.stringify({ node: { jobId: 'CURRENT', upstreamJobIds: [] }, tasks: [], outputs: [], byteBudget: 2000 }));
  await writeFile(prompt, 'private prompt'); await writeFile(requestFile, JSON.stringify(request()));
});
afterEach(async () => { vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); });

it.each([0, 7])('spools a failed publication (worker %s) and retries it without rerunning the worker', async exit => {
  await writeFile(busRoot, 'refuse directory');
  expect(await cmdFleetContextDeliver(runArgs(exit), io(), { root: busRoot })).toBe(exit || 1);
  expect(err).toContain(`"workerExit":{"status":"returned","exitCode":${exit}}`);
  expect(err).toContain('"delivery":{"status":"pending"');
  expect(await readFile(marker, 'utf8')).toBe('spawn\n');
  const [name] = await records();
  const recordPath = join(spoolDir, name!);
  await rm(busRoot);
  err = '';
  expect(await cmdFleetContextDeliver(['--retry', recordPath], io(), { root: busRoot })).toBe(0);
  expect(err).toContain(`"workerExit":{"status":"returned","exitCode":${exit}}`);
  expect(err).toContain('"delivery":{"status":"posted"}');
  expect(await readFile(marker, 'utf8')).toBe('spawn\n');
  await expect(readFile(recordPath)).rejects.toMatchObject({ code: 'ENOENT' });
  const page = listBusInboxAfter(0, 50, { root: busRoot });
  expect(page.status === 'ok' && page.messages.length).toBe(1);
}, 20000);

it('leaves no pending record after a successful publication', async () => {
  expect(await cmdFleetContextDeliver(runArgs(), io(), { root: busRoot })).toBe(0);
  expect(err).toContain('"delivery":{"status":"posted"}');
  expect(await records()).toHaveLength(0);
  expect(await readFile(marker, 'utf8')).toBe('spawn\n');
}, 20000);

it('repeated delivery dedupes and clears the record', async () => {
  expect(await cmdFleetContextDeliver(runArgs(), io(), { root: busRoot })).toBe(0);
  const stored = JSON.parse(await readFile(join(busRoot, 'bus-inbox', 'messages.json'), 'utf8'));
  const checked = env(stored.rows[0].envelope);
  expect(spool(checked.value)).toBe('saved');
  const recordPath = contextReplyRecordPath(spoolDir, checked.value.id)!;
  expect(await cmdFleetContextDeliver(['--retry', recordPath], io(), { root: busRoot })).toBe(0);
  expect(err).toContain('"delivery":{"status":"duplicate"}');
  await expect(readFile(recordPath)).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await readFile(marker, 'utf8')).toBe('spawn\n');
}, 20000);

it('refuses an expired record without republishing', async () => {
  const reply = env({ id: 'old', from: 'a', to: 'b', priority: 'P2', ttl: 1000, body: { k: 'v' } });
  expect(spool(reply.value, Date.now() - 5000)).toBe('saved');
  const recordPath = contextReplyRecordPath(spoolDir, 'old')!;
  expect(await cmdFleetContextDeliver(['--retry', recordPath], io(), { root: busRoot })).toBe(2);
  expect(err).toContain('"delivery":{"status":"expired"}');
  expect(JSON.parse(await readFile(recordPath, 'utf8')).wire).toBe(reply.json);
  expect(listBusInboxAfter(0, 50, { root: busRoot })).toMatchObject({ messages: [] });
});

it('refuses a record newer than the clock (rollback)', async () => {
  const reply = env({ id: 'future', from: 'a', to: 'b', priority: 'P2', ttl: 60000, body: { k: 'v' } });
  expect(spool(reply.value, Date.now() + 60000)).toBe('saved');
  expect(await cmdFleetContextDeliver(['--retry', contextReplyRecordPath(spoolDir, 'future')!], io(), { root: busRoot })).toBe(2);
  expect(err).toContain('"delivery":{"status":"clock-rollback"}');
  expect(listBusInboxAfter(0, 50, { root: busRoot })).toMatchObject({ messages: [] });
});

it.each(['malformed', 'oversized', 'mismatched', 'symlink'] as const)('refuses a %s record', async kind => {
  const reply = env({ id: 'bad', from: 'a', to: 'b', priority: 'P2', ttl: 60000, body: { k: 'v' } });
  await mkdir(spoolDir, { mode: 0o700 });
  const target = kind === 'mismatched' ? join(spoolDir, `reply-${'0'.repeat(32)}.json`) : contextReplyRecordPath(spoolDir, 'bad')!;
  if (kind === 'malformed') await writeFile(target, 'not json', { mode: 0o600 });
  if (kind === 'oversized') await writeFile(target, `{"version":1,"wire":"${'x'.repeat(140000)}"}`, { mode: 0o600 });
  if (kind === 'mismatched') await writeFile(target, recordJson(reply.json), { mode: 0o600 });
  if (kind === 'symlink') {
    await writeFile(join(root, 'real.json'), recordJson(reply.json), { mode: 0o600 });
    await symlink(join(root, 'real.json'), target);
  }
  expect(await cmdFleetContextDeliver(['--retry', target], io(), { root: busRoot })).toBe(2);
  expect(err).toMatch(/"delivery":{"status":"(corrupt|unsafe)"/);
  expect(listBusInboxAfter(0, 50, { root: busRoot })).toMatchObject({ messages: [] });
});

it('refuses to launch when the spool directory is unusable', async () => {
  await writeFile(spoolDir, 'not a directory');
  expect(await cmdFleetContextDeliver(runArgs(), io(), { root: busRoot })).toBe(2);
  expect(err).toContain('"delivery":{"status":"unsafe"}');
  await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' });
  expect(listBusInboxAfter(0, 50, { root: busRoot })).toMatchObject({ messages: [] });
});

it('bounds the number of pending records', async () => {
  await mkdir(spoolDir, { mode: 0o700 });
  for (let i = 0; i < SPOOL_MAX_RECORDS; i++) {
    await writeFile(join(spoolDir, `reply-${i.toString(16).padStart(32, '0')}.json`), '{}', { mode: 0o600 });
  }
  expect(spool(env({ id: 'extra', from: 'a', to: 'b', priority: 'P3', ttl: 60000, body: {} }).value)).toBe('full');
});

it.each([
  ['--retry'], ['--retry', 'relative/record.json'], ['--retry', '/tmp/x.json', '--'],
  ['--snapshot', '/a', '--prompt', '/b', '--request-file', '/c', '--reply-id', 'r'],
])('rejects invalid invocation %j', async (...args) => {
  expect(await cmdFleetContextDeliver(args, io(), { root: busRoot })).toBe(2);
  await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' });
});
