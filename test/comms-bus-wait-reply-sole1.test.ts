import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { cmdCommsBus } from '../src/cli/comms-bus.js';
import { appendBusInbox, listBusInboxAfter, type BusInboxReceipt } from '../src/core/fleet/bus-inbox.js';

const roots: string[] = [];
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'bus-wait-reply-'));
  roots.push(root);
  return { root, now: () => 100 };
}
function envelope(id: string, inReplyTo: string | null, from = 'fake-worker', to = 'fake-coordinator', priority = 'P1') {
  return { id, from, to, priority, ttl: 60000, body: inReplyTo === null ? { text: 'fake' } : { inReplyTo } };
}
const untilReply = (timeout = '5000', checkpoint?: string) =>
  ['watch', '--until-reply', '--in-reply-to', 'fake-request', '--timeout-ms', timeout, '--interval-ms', '100',
    ...(checkpoint ? ['--checkpoint', checkpoint] : [])];
const ids = (page: { messages: BusInboxReceipt[] }) => page.messages.map(row => row.envelope.id);

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it('posts a request, then delivers only the correlated reply page after unrelated records', async () => {
  vi.useFakeTimers();
  const options = setup(), pages: any[] = [];
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const file = join(options.root, 'request.json');
  writeFileSync(file, JSON.stringify(envelope('fake-request', null, 'fake-coordinator', 'fake-worker')), { mode: 0o600 });
  expect(await cmdCommsBus(['post', '--file', file], options)).toBe(0);
  expect(JSON.parse(String(log.mock.calls.at(-1)?.[0]))).toMatchObject({ status: 'posted', id: 'fake-request', cursor: 1 });
  expect(appendBusInbox(envelope('fake-unrelated-reply', 'other-request'), options).status).toBe('posted');

  const list = vi.fn(listBusInboxAfter);
  const run = cmdCommsBus([...untilReply(), '--limit', '1'], options, { list, emit: json => pages.push(JSON.parse(json)) });
  expect(list).toHaveBeenCalledTimes(1);
  expect(pages).toHaveLength(0);
  // Each unrelated page advances the scan cursor without emitting output.
  await vi.advanceTimersByTimeAsync(200);
  expect(list.mock.calls.map(call => call[0])).toEqual([0, 1, 2]);
  expect(pages).toHaveLength(0);

  expect(appendBusInbox(envelope('fake-reply', 'fake-request'), options).status).toBe('posted');
  await vi.advanceTimersByTimeAsync(100);
  expect(await run).toBe(0);
  expect(list.mock.calls.map(call => call[0])).toEqual([0, 1, 2, 2]);
  expect(pages).toHaveLength(1);
  expect(ids(pages[0])).toEqual(['fake-reply']);
  expect(pages[0].nextCursor).toBe(3);
  expect(vi.getTimerCount()).toBe(0);
}, 30000);

it('exits 1 at the deadline when only unrelated records arrive', async () => {
  vi.useFakeTimers();
  const options = setup(), emit = vi.fn();
  for (const id of ['fake-unrelated-a', 'fake-unrelated-b']) {
    expect(appendBusInbox(envelope(id, 'other-request'), options).status).toBe('posted');
  }
  const run = cmdCommsBus(untilReply('250'), options, { emit });
  await vi.advanceTimersByTimeAsync(250);
  expect(await run).toBe(1);
  expect(emit).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
}, 30000);

it('conjoins every supplied filter before completing', async () => {
  vi.useFakeTimers();
  const options = setup(), pages: any[] = [];
  // Each near-miss fails exactly one supplied filter.
  for (const row of [
    envelope('fake-wrong-priority', 'fake-request', 'fake-worker', 'fake-coordinator', 'P2'),
    envelope('fake-wrong-sender', 'fake-request', 'fake-other', 'fake-coordinator', 'P0'),
    envelope('fake-wrong-recipient', 'fake-request', 'fake-worker', 'fake-other', 'P0'),
    envelope('fake-wrong-correlation', 'other-request', 'fake-worker', 'fake-coordinator', 'P0'),
  ]) expect(appendBusInbox(row, options).status).toBe('posted');
  const run = cmdCommsBus([...untilReply(), '--from', 'fake-worker', '--to', 'fake-coordinator', '--priority', 'P0'], options, {
    emit: json => pages.push(JSON.parse(json)),
  });
  await vi.advanceTimersByTimeAsync(100);
  expect(pages).toHaveLength(0);
  expect(appendBusInbox(envelope('fake-reply', 'fake-request', 'fake-worker', 'fake-coordinator', 'P0'), options).status).toBe('posted');
  await vi.advanceTimersByTimeAsync(100);
  expect(await run).toBe(0);
  expect(pages).toHaveLength(1);
  expect(ids(pages[0])).toEqual(['fake-reply']);
  expect(vi.getTimerCount()).toBe(0);
}, 30000);

it('persists scan progress so a restarted watch resumes past unrelated records', async () => {
  vi.useFakeTimers();
  const options = setup(), path = join(options.root, 'checkpoint.json'), pages: any[] = [];
  const args = untilReply('250', path);
  for (const id of ['fake-unrelated-a', 'fake-unrelated-b']) {
    expect(appendBusInbox(envelope(id, 'other-request'), options).status).toBe('posted');
  }
  const first = cmdCommsBus(args, options, { emit: json => pages.push(JSON.parse(json)) });
  await vi.advanceTimersByTimeAsync(250);
  expect(await first).toBe(1);
  expect(pages).toHaveLength(0);
  expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({ version: 1, scanCursor: 2 });

  expect(appendBusInbox(envelope('fake-reply', 'fake-request'), options).status).toBe('posted');
  const list = vi.fn(listBusInboxAfter);
  expect(await cmdCommsBus(args, options, { list, emit: json => pages.push(JSON.parse(json)) })).toBe(0);
  expect(list.mock.calls[0]?.[0]).toBe(2);
  expect(pages).toHaveLength(1);
  expect(ids(pages[0])).toEqual(['fake-reply']);
  expect(JSON.parse(readFileSync(path, 'utf8')).scanCursor).toBe(3);
  expect(vi.getTimerCount()).toBe(0);
}, 30000);

it('does not persist the matching cursor when output delivery fails', async () => {
  vi.useFakeTimers();
  const options = setup(), path = join(options.root, 'checkpoint.json'), pages: any[] = [];
  expect(appendBusInbox(envelope('fake-reply', 'fake-request'), options).status).toBe('posted');
  const args = untilReply('500', path);
  vi.spyOn(console, 'error').mockImplementation(() => {});
  expect(await cmdCommsBus(args, options, { emit: () => { throw new Error('fake sink failure'); } })).toBe(1);
  expect(existsSync(path)).toBe(false);
  // A healthy sink replays the same page: at-least-once delivery.
  expect(await cmdCommsBus(args, options, { emit: json => pages.push(JSON.parse(json)) })).toBe(0);
  expect(pages).toHaveLength(1);
  expect(ids(pages[0])).toEqual(['fake-reply']);
  expect(JSON.parse(readFileSync(path, 'utf8')).scanCursor).toBe(1);
}, 30000);

it('rejects invalid --until-reply combinations without polling', async () => {
  const options = setup(), log = vi.spyOn(console, 'log').mockImplementation(() => {}), list = vi.fn(listBusInboxAfter);
  for (const args of [
    ['watch', '--until-reply'],
    ['watch', '--until-reply', '--in-reply-to', 'fake-request'],
    ['watch', '--until-reply', '--timeout-ms', '100'],
    ['watch', '--until-reply', '--in-reply-to'],
    ['watch', '--until-reply', '--in-reply-to', 'fake-request', '--timeout-ms', '100', '--max-pages', '1'],
    ['watch', '--until-reply', '--in-reply-to', 'fake-request', '--timeout-ms', '100', '--until-reply'],
    ['watch', '--until-reply=yes', '--in-reply-to', 'fake-request', '--timeout-ms', '100'],
    ['watch', '--until-reply', 'junk', '--in-reply-to', 'fake-request', '--timeout-ms', '100'],
    ['read', '--until-reply', '--in-reply-to', 'fake-request'],
    ['post', '--file', 'fake', '--until-reply'],
  ]) expect(await cmdCommsBus(args, options, { list })).toBe(2);
  expect(list).not.toHaveBeenCalled();
  expect(log.mock.calls.every(call => call[0] === '{"status":"invalid"}')).toBe(true);
  log.mockClear();
  expect(await cmdCommsBus(['watch', '--help'])).toBe(0);
  expect(log).toHaveBeenCalledWith(expect.stringContaining('--until-reply requires --in-reply-to and --timeout-ms'));
  expect(log).toHaveBeenCalledWith(expect.stringContaining('not an authenticated reply'));
});

it('exits 1 on cancellation without claiming a reply arrived', async () => {
  vi.useFakeTimers();
  const options = setup(), emit = vi.fn(), signal = new AbortController();
  const run = cmdCommsBus(untilReply(), options, { signal: signal.signal, emit });
  await vi.advanceTimersByTimeAsync(100);
  signal.abort();
  expect(await run).toBe(1);
  expect(emit).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

it('keeps ordinary watch deadline and cancellation semantics unchanged', async () => {
  vi.useFakeTimers();
  const options = setup(), pages: any[] = [], signal = new AbortController();
  expect(appendBusInbox(envelope('fake-unrelated', 'other-request'), options).status).toBe('posted');
  const deadline = cmdCommsBus(['watch', '--in-reply-to', 'fake-request', '--timeout-ms', '200', '--interval-ms', '100'], options, {
    emit: json => pages.push(JSON.parse(json)),
  });
  await vi.advanceTimersByTimeAsync(200);
  expect(await deadline).toBe(0);
  expect(pages).toHaveLength(2);
  expect(pages.every(page => page.status === 'ok' && page.messages.length === 0)).toBe(true);

  const cancelled = cmdCommsBus(['watch', '--in-reply-to', 'fake-request', '--timeout-ms', '5000', '--interval-ms', '100'], options, {
    signal: signal.signal, emit: () => {},
  });
  await vi.advanceTimersByTimeAsync(100);
  signal.abort();
  expect(await cancelled).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
}, 30000);
