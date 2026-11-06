import { afterEach, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  appendBusInbox, BUS_INBOX_MAX_BYTES, BUS_INBOX_MAX_MESSAGES,
  inspectBusInbox, listBusInboxAfter,
} from '../src/core/fleet/bus-inbox.js';

const roots: string[] = [];
const setup = () => {
  const root = mkdtempSync(join(tmpdir(), 'bus-reclaim-'));
  roots.push(root);
  return root;
};
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));

const message = (id: string, ttl = 100) =>
  ({ id, from: 'fake-a', to: 'fake-b', priority: 'P2', ttl, body: { fake: id } });
const fileOf = (root: string) => join(root, 'bus-inbox', 'messages.json');
const at = (root: string, now: number) => ({ root, now: () => now });

interface StoredRow { cursor: number; receivedAt: number; envelope: { id: string } }
interface StoredSnapshot { version?: number; highWater?: number; rows?: StoredRow[] }
/** Read whatever snapshot shape is on disk into rows + the high-water mark. */
const stored = (root: string): { highWater: number; rows: StoredRow[] } => {
  const parsed = JSON.parse(readFileSync(fileOf(root), 'utf8')) as StoredSnapshot | StoredRow[];
  return Array.isArray(parsed)
    ? { highWater: parsed.length, rows: parsed }
    : { highWater: parsed.highWater!, rows: parsed.rows! };
};
/** Bulk-seed a version-1 receipt array; per-row appends are too slow for big fills. */
const seed = (root: string, rows: StoredRow[]) => {
  mkdirSync(join(root, 'bus-inbox'), { recursive: true, mode: 0o700 });
  writeFileSync(fileOf(root), JSON.stringify(rows), { mode: 0o600 });
};

it('posts past the count bound after the first records expire and resumes a saved cursor', () => {
  const root = setup();
  // The original failure: every receipt of a full version-1 store has expired.
  seed(root, Array.from({ length: BUS_INBOX_MAX_MESSAGES }, (_, i) =>
    ({ cursor: i + 1, receivedAt: 0, envelope: message(`fake-first-${i}`, 50) })));
  // A consumer drains the store while it is still live and saves its cursor.
  let saved = 0;
  for (let after = 0, guard = 0; guard < 20; guard++) {
    const page = listBusInboxAfter(after, 100, at(root, 10));
    expect(page.status).toBe('ok');
    if (page.status !== 'ok') break;
    after = page.nextCursor;
    if (page.messages.length === 0) break;
    saved = after;
  }
  expect(saved).toBe(BUS_INBOX_MAX_MESSAGES);
  expect(listBusInboxAfter(0, 100, at(root, 200))).toMatchObject({ messages: [], nextCursor: BUS_INBOX_MAX_MESSAGES });
  // The post that used to answer 'full' forever now reclaims and is delivered.
  expect(appendBusInbox(message('fake-second', 1_000_000), at(root, 200)))
    .toEqual({ status: 'posted', id: 'fake-second', cursor: BUS_INBOX_MAX_MESSAGES + 1 });
  expect(stored(root)).toMatchObject({ highWater: BUS_INBOX_MAX_MESSAGES + 1 });
  expect(stored(root).rows).toHaveLength(1);
  expect(listBusInboxAfter(saved, 100, at(root, 200))).toEqual({ status: 'ok', nextCursor: BUS_INBOX_MAX_MESSAGES + 1,
    messages: [{ cursor: BUS_INBOX_MAX_MESSAGES + 1, receivedAt: 200, envelope: message('fake-second', 1_000_000) }] });
  expect(listBusInboxAfter(0, 100, at(root, 200))).toMatchObject({ messages: [{ cursor: BUS_INBOX_MAX_MESSAGES + 1 }] });
  expect(listBusInboxAfter(BUS_INBOX_MAX_MESSAGES + 2, 100, at(root, 200)).status).toBe('invalid');
}, 60_000);

it('reclaims byte capacity once retained records expire but never evicts live data', () => {
  const root = setup();
  const bulk = (id: string, ttl = 50) => ({ ...message(id, ttl), body: 'f'.repeat(65_000) });
  seed(root, Array.from({ length: 16 }, (_, i) =>
    ({ cursor: i + 1, receivedAt: 0, envelope: bulk(`fake-bulk-${i}`) })));
  const before = readFileSync(fileOf(root), 'utf8');
  expect(Buffer.byteLength(before)).toBeLessThanOrEqual(BUS_INBOX_MAX_BYTES);
  // Sixteen live ~64 KiB receipts leave no room for another: still full.
  expect(appendBusInbox(bulk('fake-more'), at(root, 10)).status).toBe('full');
  expect(readFileSync(fileOf(root), 'utf8')).toBe(before);
  // After expiry the same admission frees the byte bound, keeping the cursor.
  expect(appendBusInbox(message('fake-after-expiry', 1_000_000), at(root, 200)))
    .toEqual({ status: 'posted', id: 'fake-after-expiry', cursor: 17 });
  expect(listBusInboxAfter(0, 50, at(root, 200)))
    .toMatchObject({ messages: [{ cursor: 17, envelope: { id: 'fake-after-expiry' } }], nextCursor: 17 });
}, 60_000);

it('keeps refusing a count-full live store without changing bytes', () => {
  const root = setup();
  seed(root, Array.from({ length: BUS_INBOX_MAX_MESSAGES }, (_, i) =>
    ({ cursor: i + 1, receivedAt: 0, envelope: message(`fake-live-${i}`, 1_000_000) })));
  const before = readFileSync(fileOf(root), 'utf8');
  expect(appendBusInbox(message('fake-extra'), at(root, 10)).status).toBe('full');
  expect(appendBusInbox(message('fake-live-7', 1_000_000), at(root, 10)))
    .toEqual({ status: 'duplicate', id: 'fake-live-7', cursor: 8 });
  expect(readFileSync(fileOf(root), 'utf8')).toBe(before);
}, 60_000);

it('migrates a legacy array preserving live receipts, dedupe and cursor continuity', () => {
  const root = setup();
  seed(root, [
    { cursor: 1, receivedAt: 0, envelope: message('fake-gone', 50) },
    { cursor: 2, receivedAt: 0, envelope: message('fake-kept', 1_000_000) },
    { cursor: 3, receivedAt: 0, envelope: message('fake-gone-too', 50) },
  ]);
  expect(appendBusInbox(message('fake-new', 1_000_000), at(root, 100)))
    .toEqual({ status: 'posted', id: 'fake-new', cursor: 4 });
  // Only live receipts remain, each with its original cursor and receivedAt.
  expect(stored(root)).toEqual({ highWater: 4, rows: [
    { cursor: 2, receivedAt: 0, envelope: message('fake-kept', 1_000_000) },
    { cursor: 4, receivedAt: 100, envelope: message('fake-new', 1_000_000) },
  ] });
  expect(appendBusInbox(message('fake-kept', 1_000_000), at(root, 100)))
    .toEqual({ status: 'duplicate', id: 'fake-kept', cursor: 2 });
  expect(appendBusInbox({ ...message('fake-kept', 1_000_000), body: { fake: 'changed' } }, at(root, 100)).status).toBe('conflict');
  // An ID reclaimed by retention is no longer a dedupe receipt: it posts fresh.
  expect(appendBusInbox(message('fake-gone', 50), at(root, 100)))
    .toEqual({ status: 'posted', id: 'fake-gone', cursor: 5 });
  expect(listBusInboxAfter(0, 50, at(root, 100)))
    .toMatchObject({ messages: [{ cursor: 2 }, { cursor: 4 }, { cursor: 5 }], nextCursor: 5 });
  expect(listBusInboxAfter(3, 50, at(root, 100)))
    .toMatchObject({ messages: [{ cursor: 4 }, { cursor: 5 }], nextCursor: 5 });
  expect(inspectBusInbox(at(root, 100))).toMatchObject({ source: 'available', retainedCount: 3, liveCount: 3, expiredCount: 0 });
}, 60_000);

it('checks incoming IDs before pruning so an expired retry never refreshes or mutates', () => {
  const root = setup();
  expect(appendBusInbox(message('fake-short', 50), at(root, 0)).status).toBe('posted');
  expect(appendBusInbox(message('fake-long', 1_000_000), at(root, 0)).status).toBe('posted');
  const before = readFileSync(fileOf(root), 'utf8');
  // Expired but still retained: an identical retry is a duplicate, not a
  // re-admission, and the transaction does not prune or rewrite the file.
  expect(appendBusInbox(message('fake-short', 50), at(root, 100)))
    .toEqual({ status: 'duplicate', id: 'fake-short', cursor: 1 });
  expect(readFileSync(fileOf(root), 'utf8')).toBe(before);
  expect(appendBusInbox({ ...message('fake-short', 50), body: { fake: 'changed' } }, at(root, 100)).status).toBe('conflict');
  expect(readFileSync(fileOf(root), 'utf8')).toBe(before);
  // A different ID carries out the reclaim under the same writer lock.
  expect(appendBusInbox(message('fake-other', 1_000_000), at(root, 100)))
    .toEqual({ status: 'posted', id: 'fake-other', cursor: 3 });
  expect(stored(root).rows.map(row => row.cursor)).toEqual([2, 3]);
  expect(appendBusInbox(message('fake-short', 50), at(root, 100)))
    .toEqual({ status: 'posted', id: 'fake-short', cursor: 4 });
}, 60_000);

it('keeps the high-water mark when a fully expired legacy array migrates', () => {
  const root = setup();
  seed(root, [1, 2, 3].map(cursor => ({ cursor, receivedAt: 0, envelope: message(`fake-${cursor}`, 50) })));
  expect(appendBusInbox(message('fake-new', 1_000_000), at(root, 100)))
    .toEqual({ status: 'posted', id: 'fake-new', cursor: 4 });
  expect(stored(root)).toEqual({ highWater: 4, rows: [
    { cursor: 4, receivedAt: 100, envelope: message('fake-new', 1_000_000) },
  ] });
  // Saved cursors inside the wiped range stay valid and deliver the new record.
  expect(listBusInboxAfter(2, 50, at(root, 100))).toMatchObject({ messages: [{ cursor: 4 }], nextCursor: 4 });
  expect(listBusInboxAfter(4, 50, at(root, 100))).toMatchObject({ messages: [], nextCursor: 4 });
  expect(listBusInboxAfter(5, 50, at(root, 100)).status).toBe('invalid');
}, 60_000);

it('pages across pruned gaps in order, terminates, and lands on the high-water mark', () => {
  const root = setup();
  seed(root, [1, 2, 3, 4].map(cursor => ({
    cursor, receivedAt: 0, envelope: message(`fake-${cursor}`, cursor % 2 === 0 ? 50 : 1_000_000),
  })));
  expect(appendBusInbox(message('fake-5', 1_000_000), at(root, 100)).status).toBe('posted');
  expect(stored(root).rows.map(row => row.cursor)).toEqual([1, 3, 5]);
  const seen: number[] = [];
  let after = 0;
  for (let guard = 0; guard < 10; guard++) {
    const page = listBusInboxAfter(after, 1, at(root, 100));
    expect(page.status).toBe('ok');
    if (page.status !== 'ok') break;
    seen.push(...page.messages.map(row => row.cursor));
    const previous = after;
    after = page.nextCursor;
    if (page.messages.length === 0) { expect(after).toBe(5); break; }
    expect(after).toBeGreaterThan(previous);
  }
  expect(seen).toEqual([1, 3, 5]);
  expect(listBusInboxAfter(5, 1, at(root, 100))).toMatchObject({ messages: [], nextCursor: 5 });
  // Sparse snapshots keep advancing past a pruned tail to the stored mark.
  writeFileSync(fileOf(root), JSON.stringify({ version: 2, highWater: 10, rows: [
    { cursor: 3, receivedAt: 0, envelope: message('fake-tail-3', 1_000_000) },
    { cursor: 7, receivedAt: 0, envelope: message('fake-tail-7', 1_000_000) },
  ] }), { mode: 0o600 });
  expect(listBusInboxAfter(0, 50, at(root, 0))).toMatchObject({ messages: [{ cursor: 3 }, { cursor: 7 }], nextCursor: 10 });
  expect(listBusInboxAfter(9, 50, at(root, 0))).toMatchObject({ messages: [], nextCursor: 10 });
  expect(listBusInboxAfter(11, 50, at(root, 0)).status).toBe('invalid');
  expect(appendBusInbox(message('fake-eleven', 1_000_000), at(root, 0)))
    .toEqual({ status: 'posted', id: 'fake-eleven', cursor: 11 });
}, 60_000);

it('returns the high-water cursor when nothing live remains after reclaim', () => {
  const root = setup();
  expect(appendBusInbox(message('fake-a', 50), at(root, 0)).status).toBe('posted');
  expect(appendBusInbox(message('fake-b', 50), at(root, 0)).status).toBe('posted');
  // Reads never mutate: expired rows stay put but report a useful nextCursor.
  const before = readFileSync(fileOf(root), 'utf8');
  expect(listBusInboxAfter(0, 50, at(root, 100))).toMatchObject({ messages: [], nextCursor: 2 });
  expect(readFileSync(fileOf(root), 'utf8')).toBe(before);
  expect(appendBusInbox(message('fake-c', 50), at(root, 100)).status).toBe('posted');
  expect(stored(root)).toMatchObject({ highWater: 3 });
  expect(stored(root).rows.map(row => row.cursor)).toEqual([3]);
  // The last retained record expiring later still lands on the stored mark.
  expect(listBusInboxAfter(0, 50, at(root, 200))).toMatchObject({ messages: [], nextCursor: 3 });
}, 60_000);

it('refuses malformed snapshots and invalid clocks without mutating storage', () => {
  const root = setup();
  expect(appendBusInbox(message('fake-good', 1_000_000), at(root, 0)).status).toBe('posted');
  const good = readFileSync(fileOf(root), 'utf8');
  const row = (cursor: number, id: string) => ({ cursor, receivedAt: 0, envelope: message(id, 1_000_000) });
  const cases = [
    '{"version":1,"highWater":1,"rows":[]}',
    '{"version":3,"highWater":1,"rows":[]}',
    '{"version":2,"highWater":-1,"rows":[]}',
    '{"version":2,"highWater":1.5,"rows":[]}',
    '{"version":2,"highWater":"1","rows":[]}',
    `{"version":2,"highWater":${Number.MAX_SAFE_INTEGER + 1},"rows":[]}`,
    '{"version":2,"highWater":1}',
    '{"version":2,"rows":[]}',
    '{"version":2,"highWater":1,"rows":{},"extra":0}',
    `{"version":2,"highWater":0,"rows":[${JSON.stringify(row(1, 'fake-good'))}]}`,
    `{"version":2,"highWater":2,"rows":[${JSON.stringify(row(1, 'fake-a'))},${JSON.stringify(row(1, 'fake-b'))}]}`,
    `{"version":2,"highWater":3,"rows":[${JSON.stringify(row(2, 'fake-a'))},${JSON.stringify(row(1, 'fake-b'))}]}`,
    `{"version":2,"highWater":2,"rows":[${JSON.stringify(row(1, 'fake-good'))},${JSON.stringify(row(2, 'fake-good'))}]}`,
    '42', '"text"', 'null', '{"highWater":0,"rows":[],"version":"2"}',
  ];
  for (const text of cases) {
    writeFileSync(fileOf(root), text, { mode: 0o600 });
    expect(listBusInboxAfter(0, 50, at(root, 0)).status).toBe('unavailable');
    expect(appendBusInbox(message('fake-other'), at(root, 0)).status).toBe('unavailable');
    expect(readFileSync(fileOf(root), 'utf8')).toBe(text);
  }
  writeFileSync(fileOf(root), good, { mode: 0o600 });
  for (const now of [() => -1, () => NaN, () => 1.5]) {
    expect(appendBusInbox(message('fake-other'), { root, now }).status).toBe('invalid');
    expect(listBusInboxAfter(0, 50, { root, now }).status).toBe('invalid');
  }
  expect(appendBusInbox(message('fake-other'), { root, now: () => { throw new Error('fake clock'); } }).status).toBe('unavailable');
  expect(readFileSync(fileOf(root), 'utf8')).toBe(good);
}, 60_000);

it('refuses new posts once the cursor space is exhausted, without mutation', () => {
  const root = setup();
  const max = Number.MAX_SAFE_INTEGER;
  seed(root, []);
  writeFileSync(fileOf(root), JSON.stringify({ version: 2, highWater: max, rows: [] }), { mode: 0o600 });
  expect(listBusInboxAfter(0, 50, at(root, 0))).toEqual({ status: 'ok', messages: [], nextCursor: max });
  expect(listBusInboxAfter(max, 50, at(root, 0))).toEqual({ status: 'ok', messages: [], nextCursor: max });
  const before = readFileSync(fileOf(root), 'utf8');
  expect(appendBusInbox(message('fake-nowhere'), at(root, 0)).status).toBe('full');
  expect(readFileSync(fileOf(root), 'utf8')).toBe(before);
}, 60_000);
