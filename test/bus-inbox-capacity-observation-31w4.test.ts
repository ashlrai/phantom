import { afterEach, expect, it } from 'vitest';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendBusInbox, BUS_INBOX_MAX_BYTES, BUS_INBOX_MAX_MESSAGES, inspectBusInbox, listBusInboxAfter } from '../src/core/fleet/bus-inbox.js';

const roots: string[] = [];
const setup = () => {
  const root = mkdtempSync(join(tmpdir(), 'bus-capacity-'));
  roots.push(root);
  return root;
};
const message = (id: string, ttl = 100) => ({ id, from: 'fake-a', to: 'fake-b', priority: 'P2', ttl, body: { text: 'synthetic-é' } });
const unknown = { retainedCount: null, retainedBytes: null, maxMessages: BUS_INBOX_MAX_MESSAGES,
  maxBytes: BUS_INBOX_MAX_BYTES, liveCount: null, expiredCount: null };
const fileOf = (root: string) => join(root, 'bus-inbox', 'messages.json');

afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));

it('distinguishes each missing path and never creates storage', () => {
  const parent = setup(), root = join(parent, 'absent');
  expect(inspectBusInbox({ root, now: () => 0 })).toEqual({ source: 'missing', ...unknown });
  expect(existsSync(root)).toBe(false);
  mkdirSync(root, { mode: 0o700 });
  expect(inspectBusInbox({ root, now: () => 0 })).toEqual({ source: 'missing', ...unknown });
  expect(readdirSync(root)).toEqual([]);
  mkdirSync(join(root, 'bus-inbox'), { mode: 0o700 });
  expect(inspectBusInbox({ root, now: () => 0 })).toEqual({ source: 'missing', ...unknown });
  expect(readdirSync(join(root, 'bus-inbox'))).toEqual([]);
});

it('reports an empty valid file and exact persisted UTF-8 bytes including whitespace', () => {
  const root = setup(), directory = join(root, 'bus-inbox');
  mkdirSync(directory, { mode: 0o700 });
  const file = fileOf(root);
  writeFileSync(file, '[]\n', { mode: 0o600 });
  expect(inspectBusInbox({ root, now: () => 0 })).toEqual({ source: 'available', ...unknown,
    retainedCount: 0, retainedBytes: 3, liveCount: 0, expiredCount: 0 });
  const text = JSON.stringify([{ cursor: 1, receivedAt: 10, envelope: message('fake') }], null, 2) + '\n';
  writeFileSync(file, text);
  expect(inspectBusInbox({ root, now: () => 10 })).toEqual({ source: 'available', ...unknown,
    retainedCount: 1, retainedBytes: Buffer.byteLength(text), liveCount: 1, expiredCount: 0 });
  expect(readFileSync(file, 'utf8')).toBe(text);
  expect(readdirSync(directory)).toEqual(['messages.json']);
});

it('counts retained live and expired records at the exact TTL boundary without renewing or compacting', () => {
  const root = setup(), directory = join(root, 'bus-inbox'), file = fileOf(root);
  mkdirSync(directory, { mode: 0o700 });
  writeFileSync(file, JSON.stringify([
    { cursor: 1, receivedAt: 100, envelope: message('expired', 10) },
    { cursor: 2, receivedAt: 100, envelope: message('live', 11) },
    { cursor: 3, receivedAt: 120, envelope: message('future', 1) },
  ]), { mode: 0o600 });
  const before = readFileSync(file), stat = lstatSync(file);
  expect(inspectBusInbox({ root, now: () => 110 })).toEqual({ source: 'available', ...unknown,
    retainedCount: 3, retainedBytes: before.length, liveCount: 2, expiredCount: 1 });
  expect(inspectBusInbox({ root, now: () => 121 })).toMatchObject({ liveCount: 0, expiredCount: 3, retainedCount: 3 });
  expect(readFileSync(file)).toEqual(before);
  expect(lstatSync(file).mtimeMs).toBe(stat.mtimeMs);
  expect(readdirSync(join(root, 'bus-inbox'))).toEqual(['messages.json']);
  expect(listBusInboxAfter(0, 50, { root, now: () => 110 })).toMatchObject({ status: 'ok', nextCursor: 3 });
  expect(appendBusInbox(message('expired', 10), { root, now: () => 110 }).status).toBe('duplicate');
});

it('exposes a full retained store even when every record has expired', () => {
  const root = setup(), directory = join(root, 'bus-inbox');
  mkdirSync(directory, { mode: 0o700 });
  const rows = Array.from({ length: BUS_INBOX_MAX_MESSAGES }, (_, index) => ({
    cursor: index + 1, receivedAt: 0, envelope: message(`fake-${index}`, 1),
  }));
  const text = JSON.stringify(rows), file = fileOf(root);
  writeFileSync(file, text, { mode: 0o600 });
  expect(inspectBusInbox({ root, now: () => 1 })).toEqual({ source: 'available', ...unknown,
    retainedCount: BUS_INBOX_MAX_MESSAGES, retainedBytes: Buffer.byteLength(text),
    liveCount: 0, expiredCount: BUS_INBOX_MAX_MESSAGES });
  expect(appendBusInbox(message('extra'), { root, now: () => 1 }).status).toBe('full');
  expect(readFileSync(file, 'utf8')).toBe(text);
  writeFileSync(file, JSON.stringify([...rows, { cursor: rows.length + 1, receivedAt: 0, envelope: message('extra') }]));
  expect(inspectBusInbox({ root, now: () => 1 })).toEqual({ source: 'unavailable', ...unknown });
});

it('keeps storage counts while marking TTL counts unknown for invalid or throwing clocks', () => {
  const root = setup();
  expect(appendBusInbox(message('fake'), { root, now: () => 0 }).status).toBe('posted');
  for (const now of [() => -1, () => NaN, () => Infinity, () => 1.5, () => Number.MAX_SAFE_INTEGER + 1,
    () => { throw new Error('synthetic clock failure'); }]) {
    expect(inspectBusInbox({ root, now })).toEqual({ source: 'available', ...unknown,
      retainedCount: 1, retainedBytes: readFileSync(fileOf(root)).length });
  }
});

it('fails closed on corrupt rows, oversized files and unsafe paths without exposing contents', () => {
  const root = setup();
  expect(appendBusInbox(message('private-synthetic-id'), { root, now: () => 0 }).status).toBe('posted');
  const file = fileOf(root), original = readFileSync(file, 'utf8');
  const row = JSON.parse(original)[0];
  for (const text of ['[', JSON.stringify([{ ...row, cursor: 2 }]), JSON.stringify([row, { ...row, cursor: 2 }]),
    JSON.stringify([{ ...row, envelope: { ...row.envelope, ttl: 0 } }]), ' '.repeat(BUS_INBOX_MAX_BYTES + 1)]) {
    writeFileSync(file, text);
    expect(inspectBusInbox({ root, now: () => 0 })).toEqual({ source: 'unavailable', ...unknown });
    expect(readFileSync(file, 'utf8')).toBe(text);
  }
  writeFileSync(file, original);
  if (process.platform !== 'win32') {
    chmodSync(file, 0o644);
    expect(inspectBusInbox({ root, now: () => 0 })).toEqual({ source: 'unavailable', ...unknown });
    chmodSync(file, 0o600);
    rmSync(file);
    symlinkSync(join(root, 'missing-target'), file);
    expect(inspectBusInbox({ root, now: () => 0 })).toEqual({ source: 'unavailable', ...unknown });
  }
});
