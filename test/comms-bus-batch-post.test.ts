import { afterEach, expect, it } from 'vitest';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { cmdCommsBus, type CommsBusDependencies } from '../src/cli/comms-bus.js';
import { listBusInboxAfter } from '../src/core/fleet/bus-inbox.js';
import { MAX_BUS_BATCH_BYTES, type BusBatchReceipt } from '../src/core/fleet/bus-batch-post.js';

const roots: string[] = [];
const envelope = (id: string) => ({ id: `fake-${id}`, from: 'fake-planner', to: `fake-worker-${id}`, priority: 'P1', ttl: 10000, body: { text: 'fake 🌍' } });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'fake-bus-batch-'));
  chmodSync(root, 0o700);
  roots.push(root);
  const options = { root, now: () => 100 };
  let receipt: BusBatchReceipt;
  const run = async (text: string | Buffer, deps: CommsBusDependencies = {}, args = ['post-batch', '--file', '-']) => {
    const code = await cmdCommsBus(args, options, {
      stdin: Readable.from([text]), ...deps,
      emit: json => { receipt = JSON.parse(json) as BusBatchReceipt; },
    });
    return { code, receipt: receipt! };
  };
  return { root, options, run, page: () => listBusInboxAfter(0, 100, options) };
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

it('delivers fanout from a stable file and exact replay dedupes without renewing TTL', async () => {
  const f = fixture(), rows = ['a', 'b', 'c'].map(envelope);
  const file = join(f.root, 'fake-batch.json');
  writeFileSync(file, JSON.stringify(rows), { mode: 0o600 });
  const first = await f.run('', {}, ['post-batch', '--file', file]);
  expect(first.code).toBe(0);
  expect(first.receipt).toEqual({ version: 1, status: 'complete', complete: true, failure: null, unattempted: [],
    accepted: rows.map((row, i) => ({ id: row.id, cursor: i + 1, status: 'posted' })) });
  expect(f.page()).toEqual({ status: 'ok', nextCursor: 3,
    messages: rows.map((row, i) => ({ cursor: i + 1, receivedAt: 100, envelope: row })) });
  f.options.now = () => 200;
  const replay = await f.run(JSON.stringify(rows));
  expect(replay.code).toBe(0);
  expect(replay.receipt.accepted.map(row => row.status)).toEqual(['duplicate', 'duplicate', 'duplicate']);
  const page = f.page();
  expect(page.status === 'ok' && page.messages.map(row => row.envelope.ttl)).toEqual([9900, 9900, 9900]);
  const changed = [rows[0], { ...rows[1], body: 'fake changed' }, rows[2]];
  const conflict = await f.run(JSON.stringify(changed));
  expect(conflict.code).toBe(1);
  expect(conflict.receipt).toMatchObject({ complete: false, accepted: [{ id: 'fake-a', cursor: 1, status: 'duplicate' }],
    failure: { index: 1, status: 'conflict' }, unattempted: ['fake-c'] });
}, 30000);

it('validates every row and rejects even identical duplicate IDs before any append', async () => {
  const f = fixture();
  for (const rows of [[envelope('a'), { ...envelope('b'), ttl: 0 }], [envelope('a'), envelope('a')],
    [], Array.from({ length: 33 }, (_, i) => envelope(String(i))), {}, [envelope('a'), { ...envelope('b'), extra: true }]]) {
    expect((await f.run(JSON.stringify(rows))).code).toBe(2);
    expect(existsSync(join(f.root, 'bus-inbox'))).toBe(false);
  }
});

it('stops at the first capacity failure and permits retrying the unaccepted suffix', async () => {
  const f = fixture();
  const directory = join(f.root, 'bus-inbox');
  mkdirSync(directory, { mode: 0o700 });
  // Seed a real valid snapshot near retained-message capacity without 1023 writes.
  writeFileSync(join(directory, 'messages.json'), JSON.stringify(Array.from({ length: 1023 }, (_, i) =>
    ({ cursor: i + 1, receivedAt: 100, envelope: envelope(`seed-${i}`) }))), { mode: 0o600 });
  const result = await f.run(JSON.stringify(['a', 'b', 'c'].map(envelope)));
  expect(result.code).toBe(1);
  expect(result.receipt).toMatchObject({ accepted: [{ id: 'fake-a', cursor: 1024, status: 'posted' }],
    failure: { index: 1, status: 'full' }, unattempted: ['fake-c'], complete: false });
  expect(listBusInboxAfter(1023, 100, f.options)).toMatchObject({ status: 'ok', nextCursor: 1024,
    messages: [{ envelope: envelope('a') }] });
  const suffix = await f.run(JSON.stringify(['b', 'c'].map(envelope)));
  expect(suffix.receipt).toMatchObject({ accepted: [], failure: { index: 0, status: 'full' }, unattempted: ['fake-c'] });
}, 30000);

it('preserves a durable prefix when the next storage operation fails', async () => {
  const f = fixture();
  let calls = 0;
  f.options.now = () => { if (++calls === 2) throw new Error('fake clock unavailable'); return 100; };
  const result = await f.run(JSON.stringify(['a', 'b', 'c'].map(envelope)));
  expect(result.code).toBe(1);
  expect(result.receipt).toMatchObject({ accepted: [{ id: 'fake-a', cursor: 1, status: 'posted' }],
    failure: { index: 1, status: 'unavailable' }, unattempted: ['fake-c'] });
  f.options.now = () => 100;
  expect(f.page()).toMatchObject({ status: 'ok', nextCursor: 1, messages: [{ envelope: envelope('a') }] });
  expect((await f.run(JSON.stringify(['b', 'c'].map(envelope)))).code).toBe(0);
}, 30000);

it('bounds stdin bytes, validates UTF-8 and JSON, and accepts the exact byte limit', async () => {
  const f = fixture(), json = JSON.stringify([envelope('a')]);
  for (const text of ['[', json + '{}', Buffer.from([0xff]), Buffer.alloc(MAX_BUS_BATCH_BYTES + 1, 32)]) {
    expect((await f.run(text)).code).toBe(2);
    expect(existsSync(join(f.root, 'bus-inbox'))).toBe(false);
  }
  const bytes = Buffer.from(json + ' '.repeat(MAX_BUS_BATCH_BYTES - Buffer.byteLength(json)));
  const split = bytes.indexOf(Buffer.from('🌍')) + 2;
  expect((await f.run('', { stdin: Readable.from([bytes.subarray(0, split), bytes.subarray(split)]) })).code).toBe(0);
});

it('does not write on cancellation or input read failures', async () => {
  const f = fixture(), controller = new AbortController();
  controller.abort();
  expect((await f.run(JSON.stringify([envelope('a')]), { signal: controller.signal })).code).toBe(1);
  const broken = new Readable({ read() { this.destroy(new Error('fake read failure')); } });
  expect((await f.run('', { stdin: broken })).code).toBe(1);
  const active = new AbortController();
  const pending = new Readable({ read() { this.push(JSON.stringify([envelope('a')])); active.abort(); } });
  expect((await f.run('', { stdin: pending, signal: active.signal })).code).toBe(1);
  expect((await f.run('', {}, ['post-batch', '--file', join(f.root, 'fake-missing')])).code).toBe(1);
  expect(existsSync(join(f.root, 'bus-inbox'))).toBe(false);
});

it('rejects malformed UTF-8 files while preserving literal replacement characters', async () => {
  const f = fixture(), file = join(f.root, 'fake-batch.json');
  const json = JSON.stringify([{ ...envelope('a'), body: 'FAKE' }]);
  writeFileSync(file, Buffer.concat([Buffer.from(json.slice(0, json.indexOf('FAKE'))), Buffer.from([0xff]),
    Buffer.from(json.slice(json.indexOf('FAKE') + 4))]), { mode: 0o600 });
  expect((await f.run('', {}, ['post-batch', '--file', file])).code).toBe(2);
  expect(existsSync(join(f.root, 'bus-inbox'))).toBe(false);
  writeFileSync(file, JSON.stringify([{ ...envelope('a'), body: '\ufffd' }]));
  expect((await f.run('', {}, ['post-batch', '--file', file])).code).toBe(0);
});

it('accepts only one file flag and does not consume stdin on invalid usage', async () => {
  const f = fixture();
  const stdin = new Readable({ read() { throw new Error('must not consume'); } });
  for (const args of [[], ['--file'], ['--file', '-', '--file', '-'], ['--after', '0'], ['--file', '-', '--to', 'fake-a'], ['--file=-']]) {
    expect((await f.run('', { stdin }, ['post-batch', ...args])).code).toBe(2);
  }
  expect(existsSync(join(f.root, 'bus-inbox'))).toBe(false);
  stdin.destroy();
});
