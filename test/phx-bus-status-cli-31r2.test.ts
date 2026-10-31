import { afterEach, expect, it, vi } from 'vitest';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cmdCommsBus } from '../src/cli/comms-bus.js';
import { appendBusInbox, BUS_INBOX_MAX_BYTES, BUS_INBOX_MAX_MESSAGES, listBusInboxAfter } from '../src/core/fleet/bus-inbox.js';

const roots: string[] = [];
const setup = () => {
  const root = mkdtempSync(join(tmpdir(), 'bus-status-'));
  roots.push(root);
  return root;
};
const message = (id: string, ttl: number) => ({ id, from: 'fake-sender', to: 'fake-recipient', priority: 'P2', ttl, body: { text: 'fake-private-body-é' } });
const unknown = { retainedCount: null, retainedBytes: null, maxMessages: BUS_INBOX_MAX_MESSAGES,
  maxBytes: BUS_INBOX_MAX_BYTES, liveCount: null, expiredCount: null };

afterEach(() => {
  vi.restoreAllMocks();
  roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true }));
});

it('reports a missing store without creating any files', async () => {
  const parent = setup(), root = join(parent, 'absent');
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  expect(await cmdCommsBus(['status'], { root })).toBe(0);
  expect(log).toHaveBeenCalledOnce();
  expect(JSON.parse(log.mock.calls[0]![0] as string)).toEqual({ source: 'missing', ...unknown });
  expect(existsSync(root)).toBe(false);
  expect(readdirSync(parent)).toEqual([]);
});

it('reports exact retained metadata without exposing bodies or changing records and cursors', async () => {
  const root = setup(), options = { root, now: () => 100 };
  expect(appendBusInbox(message('fake-expired', 10), options).status).toBe('posted');
  expect(appendBusInbox(message('fake-live', 11), options).status).toBe('posted');
  const file = join(root, 'bus-inbox', 'messages.json'), before = readFileSync(file);
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  expect(await cmdCommsBus(['status'], { root, now: () => 110 })).toBe(0);
  const output = log.mock.calls[0]![0] as string;
  expect(JSON.parse(output)).toEqual({ source: 'available', ...unknown, retainedCount: 2,
    retainedBytes: before.length, liveCount: 1, expiredCount: 1 });
  expect(output).not.toContain('fake-private-body');
  expect(readFileSync(file)).toEqual(before);
  expect(readdirSync(join(root, 'bus-inbox'))).toEqual(['messages.json']);
  expect(listBusInboxAfter(0, 50, { root, now: () => 110 })).toMatchObject({ status: 'ok', nextCursor: 2 });
  expect(appendBusInbox(message('fake-expired', 10), options)).toMatchObject({ status: 'duplicate', cursor: 1 });

  log.mockClear();
  expect(await cmdCommsBus(['status'], { root, now: () => NaN })).toBe(0);
  expect(JSON.parse(log.mock.calls[0]![0] as string)).toEqual({ source: 'available', ...unknown,
    retainedCount: 2, retainedBytes: before.length });
});

it('shows a full retained store even when all records are expired', async () => {
  const root = setup(), directory = join(root, 'bus-inbox');
  mkdirSync(directory, { mode: 0o700 });
  const rows = Array.from({ length: BUS_INBOX_MAX_MESSAGES }, (_, i) => ({
    cursor: i + 1, receivedAt: 0, envelope: message(`fake-${i}`, 1),
  }));
  const text = JSON.stringify(rows), file = join(directory, 'messages.json');
  writeFileSync(file, text, { mode: 0o600 });
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  expect(await cmdCommsBus(['status'], { root, now: () => 1 })).toBe(0);
  expect(JSON.parse(log.mock.calls[0]![0] as string)).toEqual({ source: 'available', ...unknown,
    retainedCount: BUS_INBOX_MAX_MESSAGES, retainedBytes: Buffer.byteLength(text), liveCount: 0, expiredCount: BUS_INBOX_MAX_MESSAGES });
  expect(appendBusInbox(message('fake-extra', 1), { root, now: () => 1 }).status).toBe('full');
  expect(readFileSync(file, 'utf8')).toBe(text);
});

it('fails closed for corrupt and inaccessible stores without leaking or changing contents', async () => {
  const root = setup(), directory = join(root, 'bus-inbox'), file = join(directory, 'messages.json');
  mkdirSync(directory, { mode: 0o700 });
  const corrupt = '[fake-private-body';
  writeFileSync(file, corrupt, { mode: 0o600 });
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  expect(await cmdCommsBus(['status'], { root })).toBe(1);
  expect(JSON.parse(log.mock.calls[0]![0] as string)).toEqual({ source: 'unavailable', ...unknown });
  expect(readFileSync(file, 'utf8')).toBe(corrupt);
  if (process.platform !== 'win32') {
    writeFileSync(file, '[]');
    chmodSync(file, 0o644);
    log.mockClear();
    expect(await cmdCommsBus(['status'], { root })).toBe(1);
    expect(JSON.parse(log.mock.calls[0]![0] as string)).toEqual({ source: 'unavailable', ...unknown });
    expect(readFileSync(file, 'utf8')).toBe('[]');
  }
});

it('rejects status arguments and describes retained expired records in help', async () => {
  const root = join(setup(), 'absent');
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  for (const args of [['--after', '0'], ['--help', 'extra'], ['unexpected'], ['--json']]) {
    log.mockClear();
    expect(await cmdCommsBus(['status', ...args], { root })).toBe(2);
    expect(JSON.parse(log.mock.calls[0]![0] as string)).toEqual({ status: 'invalid' });
  }
  for (const flag of ['--help', '-h']) {
    log.mockClear();
    expect(await cmdCommsBus(['status', flag], { root })).toBe(0);
    expect(log.mock.calls[0]![0]).toContain('expired records still occupy retained capacity');
    expect(log.mock.calls[0]![0]).toContain('never resets cursors');
  }
  expect(existsSync(root)).toBe(false);
});
