import { afterEach, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runBusBacklogDrain, type BusBacklogDrainDependencies } from '../examples/agents/bus-backlog-drain.js';
import type { BusEnvelope } from '../src/core/fleet/bus-envelope.js';
import {
  appendBusInbox, BUS_INBOX_MAX_BYTES, BUS_INBOX_MAX_MESSAGES, BUS_INBOX_MAX_READ,
  inspectBusInbox, listBusInboxAfter, type BusInboxInspection, type BusInboxReceipt,
} from '../src/core/fleet/bus-inbox.js';

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));

const envelope = (id: string, to = 'fake-other', ttl = 60000): BusEnvelope =>
  ({ id, from: 'fake-peer', to, priority: 'P2', ttl, body: { fake: 'data' } });
const receipt = (cursor: number, to = 'fake-agent'): BusInboxReceipt =>
  ({ cursor, receivedAt: 100, envelope: envelope(`fake-${cursor}`, to) });
const inspection = (source: BusInboxInspection['source']): BusInboxInspection => ({
  source, retainedCount: null, retainedBytes: null,
  maxMessages: BUS_INBOX_MAX_MESSAGES, maxBytes: BUS_INBOX_MAX_BYTES,
  liveCount: null, expiredCount: null,
});
const available = () => vi.fn<typeof inspectBusInbox>(() => inspection('available'));

function store() {
  const root = mkdtempSync(join(tmpdir(), 'fake-drain-'));
  roots.push(root);
  return { root: join(root, 'inbox'), now: () => 100 };
}

/** Bulk-seeds a valid private store; per-row appends are too slow for >100 rows. */
function seed(root: string, rows: BusInboxReceipt[]) {
  mkdirSync(join(root, 'bus-inbox'), { recursive: true, mode: 0o700 });
  writeFileSync(join(root, 'bus-inbox', 'messages.json'), JSON.stringify(rows), { mode: 0o600 });
}

function run(deps: BusBacklogDrainDependencies, args = ['--to', 'fake-agent']) {
  const lines: string[] = [];
  const code = runBusBacklogDrain(args, { ...deps, write: text => lines.push(text) });
  expect(lines).toHaveLength(1);
  return { code, line: lines[0]!, result: JSON.parse(lines[0]!) as Record<string, unknown> };
}

it('drains more than one hundred retained rows with matches only on the final page', () => {
  const options = store();
  const hits = [206, 207, 208].map(cursor => receipt(cursor));
  hits.forEach((row, i) => { row.envelope.id = `fake-hit-${i + 1}`; });
  seed(options.root, [
    ...Array.from({ length: 205 }, (_, i) => receipt(i + 1, 'fake-other')),
    ...hits,
  ]);
  const read = vi.fn(listBusInboxAfter);
  const { code, result } = run({ options, read });
  expect(code).toBe(0);
  expect(result).toEqual({
    status: 'complete', to: 'fake-agent', scanned: 208, nextCursor: 208, scanCapReached: false,
    messages: hits,
  });
  // Destination filtering yields no matches on the first two pages, yet every
  // page cursor still advances until the final page and one confirmation read.
  expect(read.mock.calls.map(call => [call[0], call[1]])).toEqual([
    [0, BUS_INBOX_MAX_READ], [100, BUS_INBOX_MAX_READ], [200, BUS_INBOX_MAX_READ], [208, BUS_INBOX_MAX_READ],
  ]);
});

it('advances the cursor over expired records without returning them', () => {
  const options = store();
  for (const [id, to, ttl] of [
    ['fake-expired-peer', 'fake-other', 10],
    ['fake-expired-match', 'fake-agent', 10],
    ['fake-live-match', 'fake-agent', 60000],
    ['fake-live-peer', 'fake-other', 60000],
  ] as const) {
    expect(appendBusInbox(envelope(id, to, ttl), options).status).toBe('posted');
  }
  const read = vi.fn(listBusInboxAfter);
  const { code, result } = run({ options: { root: options.root, now: () => 1000 }, read });
  expect(code).toBe(0);
  expect(result).toEqual({
    status: 'complete', to: 'fake-agent', scanned: 4, nextCursor: 4, scanCapReached: false,
    messages: [{ cursor: 3, receivedAt: 100, envelope: { ...envelope('fake-live-match', 'fake-agent'), ttl: 59100 } }],
  });
  expect(read.mock.calls.map(call => call[0])).toEqual([0, 4]);
});

it('reports an empty live backlog as complete, never as missing', () => {
  const options = store();
  expect(appendBusInbox(envelope('fake-short', 'fake-agent', 10), options).status).toBe('posted');
  expect(appendBusInbox(envelope('fake-peer'), options).status).toBe('posted');
  const { code, result } = run({ options: { root: options.root, now: () => 1000 } });
  expect(code).toBe(0);
  expect(result).toEqual({ status: 'complete', to: 'fake-agent', messages: [], scanned: 2, nextCursor: 2, scanCapReached: false });
});

it('reports a missing store instead of a successful empty backlog', () => {
  const options = store();
  const read = vi.fn<typeof listBusInboxAfter>();
  const { code, result } = run({ options, read });
  expect(code).toBe(3);
  expect(result).toEqual({ status: 'missing', to: 'fake-agent', messages: [], scanned: 0, nextCursor: 0, scanCapReached: false });
  expect(read).not.toHaveBeenCalled();
});

it('reports a failed store without reading pages', () => {
  const read = vi.fn<typeof listBusInboxAfter>();
  for (const inspect of [
    vi.fn<typeof inspectBusInbox>(() => inspection('unavailable')),
    vi.fn<typeof inspectBusInbox>(() => { throw new Error('fake private detail'); }),
  ]) {
    const { code, result, line } = run({ inspect, read });
    expect(code).toBe(4);
    expect(result).toMatchObject({ status: 'read-failed', reason: 'unavailable', scanned: 0, nextCursor: 0 });
    expect(line).not.toContain('fake private detail');
  }
  expect(read).not.toHaveBeenCalled();
});

it('fails after partial progress with matches and the resume cursor preserved', () => {
  const read = vi.fn<typeof listBusInboxAfter>();
  read.mockReturnValueOnce({ status: 'ok', nextCursor: 100, messages: [receipt(5), receipt(6, 'fake-other')] });
  read.mockReturnValueOnce({ status: 'unavailable' });
  const { code, result } = run({ inspect: available(), read });
  expect(code).toBe(4);
  expect(result).toEqual({
    status: 'read-failed', reason: 'unavailable', to: 'fake-agent',
    messages: [receipt(5)], scanned: 100, nextCursor: 100, scanCapReached: false,
  });
  expect(read.mock.calls.map(call => call[0])).toEqual([0, 100]);
});

it('masks thrown reader exceptions and rejects a backwards cursor', () => {
  const throwing = vi.fn<typeof listBusInboxAfter>(() => { throw new Error('fake private detail'); });
  const first = run({ inspect: available(), read: throwing });
  expect(first.code).toBe(4);
  expect(first.result).toMatchObject({ status: 'read-failed', reason: 'unavailable' });
  expect(first.line).not.toContain('fake private detail');
  const backwards = vi.fn<typeof listBusInboxAfter>(() => ({ status: 'ok', messages: [], nextCursor: 0 }));
  const second = run({ inspect: available(), read: backwards }, ['--to', 'fake-agent', '--after', '5']);
  expect(second.code).toBe(4);
  expect(second.result).toEqual({
    status: 'read-failed', reason: 'cursor-invalid', to: 'fake-agent',
    messages: [], scanned: 0, nextCursor: 5, scanCapReached: false,
  });
});

it('bounds the scan at the retained maximum and reports the cap', () => {
  const read = vi.fn<typeof listBusInboxAfter>((after = 0) =>
    ({ status: 'ok', messages: [], nextCursor: after + BUS_INBOX_MAX_READ }));
  const { code, result } = run({ inspect: available(), read }, ['--to', 'fake-agent', '--after', '40']);
  expect(code).toBe(0);
  expect(read).toHaveBeenCalledTimes(Math.ceil(BUS_INBOX_MAX_MESSAGES / BUS_INBOX_MAX_READ));
  expect(result).toEqual({ status: 'complete', to: 'fake-agent', messages: [], scanned: 1100, nextCursor: 1140, scanCapReached: true });
});

it('resumes scanning at --after', () => {
  const read = vi.fn<typeof listBusInboxAfter>((after = 0) => ({ status: 'ok', messages: [], nextCursor: after }));
  const { code, result } = run({ inspect: available(), read }, ['--to', 'fake-agent', '--after', '200']);
  expect(code).toBe(0);
  expect(read).toHaveBeenCalledTimes(1);
  expect(read.mock.calls[0]).toEqual([200, BUS_INBOX_MAX_READ, undefined]);
  expect(result).toEqual({ status: 'complete', to: 'fake-agent', messages: [], scanned: 0, nextCursor: 200, scanCapReached: false });
});

it('rejects invalid arguments before touching the store', () => {
  const inspect = available(), read = vi.fn<typeof listBusInboxAfter>();
  for (const args of [
    [], ['--to'], ['--to', ''], ['--to', 'two words'], ['--to', 'a'.repeat(129)], ['--to', 'é'],
    ['--after', '5'],
    ['--to', 'fake-agent', '--after'], ['--to', 'fake-agent', '--after', '-1'],
    ['--to', 'fake-agent', '--after', '01'], ['--to', 'fake-agent', '--after', 'x'],
    ['--to', 'fake-agent', '--to', 'fake-agent'], ['--to', 'fake-agent', '--bogus', 'x'],
    ['--to', '--after'], ['--to', 'fake-agent', 'extra'],
  ]) {
    const { code, result } = run({ inspect, read }, args);
    expect(code).toBe(2);
    expect(result).toEqual({ status: 'invalid-arguments' });
  }
  expect(inspect).not.toHaveBeenCalled();
  expect(read).not.toHaveBeenCalled();
});
