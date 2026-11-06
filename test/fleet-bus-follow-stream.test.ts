import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendBusInbox, listBusInboxAfter, type BusInboxPage } from '../src/core/fleet/bus-inbox.js';
import { followBusStream, type BusFollowRecord } from '../src/core/fleet/bus-follow-stream.js';
import { cmdFleetBusFollow } from '../src/cli/fleet-bus-follow.js';
import { cmdFleet } from '../src/cli/fleet.js';
import { resolveFleetSubcommand } from '../src/cli/fleet-subcommand-resolve.js';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'bus-follow-')); });
afterEach(() => { vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }); });

function post(id: string, to = 'worker-a', fields: object = {}, now?: number) {
  const envelope = { id, from: 'sender', to, priority: 'P2' as const, ttl: 600_000, body: { kind: 'note' }, ...fields };
  const options = now === undefined ? { root } : { root, now: () => now };
  return appendBusInbox(envelope, options).status;
}
function collect() {
  const records: BusFollowRecord[] = [];
  return { records, emit: (record: BusFollowRecord) => { records.push(record); } };
}
const messages = (records: BusFollowRecord[]) =>
  records.filter((row): row is Extract<BusFollowRecord, { type: 'message' }> => row.type === 'message');
/** Streams with a manual deadline clock: expire() ends it at the next wake. */
function follow(request: Partial<Parameters<typeof followBusStream>[0]> = {}, deps: Partial<Parameters<typeof followBusStream>[1]> = {}) {
  const records: BusFollowRecord[] = [];
  let now = 0;
  const pending = followBusStream({ after: 0, durationMs: 5000, intervalMs: 100, root, ...request },
    { emit: (record: BusFollowRecord) => { records.push(record); }, clock: () => now, ...deps });
  return { records, pending, expire: () => { now = 10_000; } };
}

it('streams a message appended after start and ends with a resume checkpoint (real reader)', async () => {
  let now = 0;
  const { records, emit } = collect();
  const pending = followBusStream({ after: 0, durationMs: 5000, intervalMs: 100, root },
    { emit, clock: () => now });
  await new Promise(resolve => setTimeout(resolve, 50));
  expect(post('late')).toBe('posted');
  await vi.waitFor(() => expect(messages(records)).toHaveLength(1), { timeout: 20000, interval: 200 });
  now = 6000;
  const result = await pending;
  expect(result).toMatchObject({ status: 'expired', cursor: 1, delivered: 1 });
  expect(records[0]).toMatchObject({ type: 'message', cursor: 1, envelope: { id: 'late', to: 'worker-a', priority: 'P2' } });
  expect(records.at(-1)).toEqual({ type: 'checkpoint', cursor: 1 });
});

it('delivers only exact --to matches while checkpoints advance past filtered rows', async () => {
  post('other-1', 'worker-b'); post('mine'); post('other-2', 'worker-b');
  const { records, pending, expire } = follow({ to: 'worker-a' });
  expire();
  const result = await pending;
  expect(result.status).toBe('expired');
  expect(messages(records).map(row => row.envelope.id)).toEqual(['mine']);
  expect(messages(records)[0]!.cursor).toBe(2);
  expect(records.at(-1)).toEqual({ type: 'checkpoint', cursor: 3 });
});

it('resumes from an emitted checkpoint without redelivering messages', async () => {
  post('first');
  const before = follow();
  before.expire();
  await before.pending;
  const cursor = (before.records.at(-1) as Extract<BusFollowRecord, { type: 'checkpoint' }>).cursor;
  expect(cursor).toBe(1);
  post('second');
  const after = follow({ after: cursor });
  after.expire();
  const result = await after.pending;
  expect(result.status).toBe('expired');
  expect(messages(after.records).map(row => row.envelope.id)).toEqual(['second']);
  expect(result.cursor).toBe(2);
});

it('advances checkpoints over expired retained rows (sparse cursors)', async () => {
  post('stale-1', 'worker-a', { ttl: 5_000 }, 0);
  post('fresh');
  post('stale-2', 'worker-a', { ttl: 5_000 }, 0);
  const { records, pending, expire } = follow();
  expire();
  const result = await pending;
  expect(result.status).toBe('expired');
  expect(messages(records).map(row => [row.cursor, row.envelope.id])).toEqual([[2, 'fresh']]);
  expect(records.at(-1)).toEqual({ type: 'checkpoint', cursor: 3 });
});

it('never emits a checkpoint ahead of records accepted by the output stream', async () => {
  post('one'); post('two');
  const calls: string[] = [];
  let now = 0, release: (() => void) | undefined;
  const pending = followBusStream({ after: 0, durationMs: 1500, intervalMs: 100, root }, {
    clock: () => now,
    emit: (record: BusFollowRecord) => new Promise<void>(resolve => {
      calls.push(record.type);
      if (calls.length === 1) release = () => resolve(); else resolve();
    }),
  });
  await vi.waitFor(() => expect(calls).toEqual(['message']), { timeout: 20000 });
  // While the first message's acceptance is pending no further record may be offered.
  await new Promise(resolve => setTimeout(resolve, 50));
  expect(calls).toEqual(['message']);
  release!();
  await vi.waitFor(() => expect(calls).toEqual(['message', 'message', 'checkpoint']), { timeout: 20000 });
  now = 2000;
  await vi.waitFor(() => expect(calls).toEqual(['message', 'message', 'checkpoint', 'checkpoint']), { timeout: 20000 });
  expect((await pending).status).toBe('expired');
});

it('cancels promptly on an injected signal and removes signal listeners', async () => {
  const controller = new AbortController();
  const emitted: string[] = [];
  const sigint = process.listenerCount('SIGINT'), sigterm = process.listenerCount('SIGTERM');
  const started = performance.now();
  const pending = cmdFleetBusFollow(
    ['--after', '0', '--duration-ms', '30000', '--interval-ms', '60000', '--root', root, '--json'],
    { signal: controller.signal, emit: (json: string) => { emitted.push(json); } });
  setTimeout(() => controller.abort(), 30);
  expect(await pending).toBe(0);
  expect(performance.now() - started).toBeLessThan(5000);
  expect(emitted).toEqual([]);
  expect(process.listenerCount('SIGINT')).toBe(sigint);
  expect(process.listenerCount('SIGTERM')).toBe(sigterm);
});

it('fails closed on unavailable, malformed or beyond-store pages without advancing a checkpoint', async () => {
  post('retained');
  const { records, emit } = collect();
  const envelope = { id: 'x', from: 'a', to: 'b', priority: 'P2' as const, ttl: 1_000, body: null };
  const malformed: BusInboxPage = { status: 'ok', messages: [{ cursor: 5, receivedAt: 0, envelope }], nextCursor: 2 };
  const request = { after: 0, durationMs: 250, intervalMs: 100, root };
  expect(await followBusStream(request, { emit, list: () => ({ status: 'unavailable' }) }))
    .toMatchObject({ status: 'source-unavailable', cursor: 0, delivered: 0 });
  expect(await followBusStream(request, { emit, list: () => malformed }))
    .toMatchObject({ status: 'source-unavailable', cursor: 0, delivered: 0 });
  // The real reader refuses a resume cursor beyond the store's high-water mark.
  expect(await followBusStream({ ...request, after: 99 }, { emit }))
    .toMatchObject({ status: 'source-unavailable', cursor: 99, delivered: 0 });
  expect(records).toEqual([]);
});

it('retries retryable reads within the deadline and still expires cleanly', async () => {
  post('ok');
  let calls = 0;
  const { records, emit } = collect();
  const list: typeof listBusInboxAfter = (after, limit, options) =>
    ++calls === 1 ? { status: 'retryable' } : listBusInboxAfter(after, limit, options);
  const result = await followBusStream({ after: 0, durationMs: 400, intervalMs: 100, root }, { emit, list });
  expect(result.status).toBe('expired');
  expect(calls).toBeGreaterThan(1);
  expect(messages(records).map(row => row.envelope.id)).toEqual(['ok']);
});

it('rejects invalid arguments before touching the store', async () => {
  const emitted: string[] = [], list = vi.fn(listBusInboxAfter);
  const emit = (json: string) => { emitted.push(json); };
  const good = ['--after', '0', '--duration-ms', '300', '--root', root, '--json'];
  for (const args of [[], good.slice(0, -1), [...good, '--json'], [...good, '--after', '1'], [...good, '--bogus'], [...good, 'extra'],
    ['--duration-ms', '300', '--root', root, '--json'], ['--after', '0', '--root', root, '--json'], ['--after'],
    ['--after', '-1', ...good.slice(2)], ['--after', '1e2', ...good.slice(2)],
    ['--after', '0', '--duration-ms', '0', '--root', root, '--json'],
    ['--after', '0', '--duration-ms', '3600001', '--root', root, '--json'],
    ['--after', '0', '--duration-ms', '100', '--interval-ms', '99', '--root', root, '--json'],
    ['--after', '0', '--duration-ms', '100', '--interval-ms', '60001', '--root', root, '--json'],
    ['--after', '0', '--duration-ms', '100', '--to', 'bad label', '--root', root, '--json'],
    ['--after', '0', '--duration-ms', '100', '--root', 'relative', '--json'],
    ['--after', '0', '--duration-ms', '100', '--root', root, '--to', '--json']]) {
    expect(await cmdFleetBusFollow(args, { emit, list })).toBe(2);
    expect(JSON.parse(emitted.at(-1)!)).toEqual({ status: 'invalid' });
  }
  expect(list).not.toHaveBeenCalled();
  expect(existsSync(join(root, 'bus-inbox'))).toBe(false);
});

it('emits scrubbed JSONL through the CLI and expires with a final checkpoint', async () => {
  post('secret-body', 'worker-a', { body: { token: 'fake-token-value', text: 'sk-' + 'FAKE0000000000000000' } });
  const emitted: string[] = [];
  const code = await cmdFleetBusFollow(['--after', '0', '--duration-ms', '250', '--interval-ms', '100', '--root', root, '--json'],
    { emit: (json: string) => { emitted.push(json); } });
  expect(code).toBe(0);
  const rows = emitted.map(line => JSON.parse(line) as BusFollowRecord);
  expect(rows[0]).toMatchObject({ type: 'message', cursor: 1, envelope: { id: 'secret-body' } });
  expect(emitted.join()).not.toContain('fake-token-value');
  expect(emitted.join()).not.toContain('FAKE0000000000000000');
  expect(rows.at(-1)).toEqual({ type: 'checkpoint', cursor: 1 });
});

it('owns its help and dispatches through the fleet verb convention', async () => {
  const out = vi.spyOn(console, 'log').mockImplementation(() => {});
  expect(await cmdFleetBusFollow(['--help'])).toBe(0);
  expect(out).toHaveBeenCalledWith(expect.stringContaining('Usage: ashlr fleet bus-follow'));
  expect(resolveFleetSubcommand('bus-follow')).toEqual({ module: './fleet-bus-follow.js', exportName: 'cmdFleetBusFollow' });
  const lines: string[] = [];
  vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown, callback?: unknown) => {
    lines.push(String(chunk));
    if (typeof callback === 'function') (callback as (error?: Error | null) => void)();
    return true;
  }) as typeof process.stdout.write);
  post('via-dispatch');
  expect(await cmdFleet(['bus-follow', '--after', '0', '--duration-ms', '250', '--interval-ms', '100', '--root', root, '--json'])).toBe(0);
  const rows = lines.map(line => JSON.parse(line) as BusFollowRecord);
  expect(rows[0]).toMatchObject({ type: 'message', cursor: 1, envelope: { id: 'via-dispatch' } });
  expect(rows.at(-1)).toEqual({ type: 'checkpoint', cursor: 1 });
});
