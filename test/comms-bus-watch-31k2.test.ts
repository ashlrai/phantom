import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cmdCommsBus } from '../src/cli/comms-bus.js';
import { appendBusInbox, listBusInboxAfter } from '../src/core/fleet/bus-inbox.js';

const roots: string[] = [];
const setup = () => {
  const root = mkdtempSync(join(tmpdir(), 'bus-watch-')); roots.push(root);
  return { root, now: () => 100 };
};
const message = (id: string, ttl = 100) => ({ id, from: 'a', to: 'b', priority: 'P1', ttl, body: 'fake' });
afterEach(() => {
  vi.useRealTimers(); vi.restoreAllMocks();
  roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true }));
});

it('replays from the requested cursor and polls for newly arriving pages', async () => {
  vi.useFakeTimers();
  const options = setup(), abort = new AbortController(), pages: any[] = [];
  for (const id of ['one', 'two', 'three']) expect(appendBusInbox(message(id), options).status).toBe('posted');
  const run = cmdCommsBus(['watch', '--after', '1', '--limit', '1', '--interval-ms', '100'], options, {
    signal: abort.signal, emit: json => pages.push(JSON.parse(json)),
  });
  expect(pages.map(p => p.messages.map((row: any) => row.cursor))).toEqual([[2]]);
  await vi.advanceTimersByTimeAsync(100);
  expect(appendBusInbox(message('four'), options).status).toBe('posted');
  await vi.advanceTimersByTimeAsync(100);
  await vi.advanceTimersByTimeAsync(100);
  expect(pages.map(p => [p.nextCursor, p.messages.map((row: any) => row.cursor)])).toEqual([[2, [2]], [3, [3]], [4, [4]], [4, []]]);
  abort.abort();
  expect(await run).toBe(0);
});

it('emits an entirely expired page and advances past it', async () => {
  vi.useFakeTimers();
  const options = setup(), abort = new AbortController(), pages: any[] = [];
  expect(appendBusInbox(message('expired'), options).status).toBe('posted');
  const list = vi.fn(listBusInboxAfter);
  const run = cmdCommsBus(['watch', '--interval-ms', '100'], { ...options, now: () => 200 }, {
    signal: abort.signal, list, emit: json => pages.push(JSON.parse(json)),
  });
  await vi.advanceTimersByTimeAsync(100);
  expect(pages).toEqual([{ status: 'ok', messages: [], nextCursor: 1 }, { status: 'ok', messages: [], nextCursor: 1 }]);
  expect(list.mock.calls.map(call => call[0])).toEqual([0, 1]);
  abort.abort(); expect(await run).toBe(0);
});

it('retries contention at the same cursor without emitting a duplicate page', async () => {
  vi.useFakeTimers();
  const options = setup(), abort = new AbortController(), pages: any[] = [];
  expect(appendBusInbox(message('one'), options).status).toBe('posted');
  const list = vi.fn<typeof listBusInboxAfter>()
    .mockImplementationOnce(listBusInboxAfter)
    .mockReturnValueOnce({ status: 'retryable' })
    .mockImplementation(listBusInboxAfter);
  const run = cmdCommsBus(['watch', '--interval-ms', '100'], options, { signal: abort.signal, list, emit: json => pages.push(JSON.parse(json)) });
  await vi.advanceTimersByTimeAsync(100);
  expect(pages).toHaveLength(1);
  expect(appendBusInbox(message('two'), options).status).toBe('posted');
  await vi.advanceTimersByTimeAsync(100);
  expect(list.mock.calls.map(call => call[0])).toEqual([0, 1, 1]);
  expect(pages.map(p => p.messages.map((row: any) => row.cursor))).toEqual([[1], [2]]);
  abort.abort(); expect(await run).toBe(0);
});

it('rejects invalid watch options without polling', async () => {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {}), list = vi.fn(listBusInboxAfter);
  for (const args of [
    ['--after', '-1'], ['--after', '1e3'], ['--after', '9007199254740992'], ['--limit', '0'], ['--limit', '101'],
    ['--interval-ms', '99'], ['--interval-ms', '60001'], ['--interval-ms', '1.5'], ['--interval-ms'],
    ['--interval-ms', '100', '--interval-ms', '100'], ['--file', 'fake'], ['extra'],
  ]) expect(await cmdCommsBus(['watch', ...args], {}, { list })).toBe(2);
  expect(list).not.toHaveBeenCalled();
  expect(log.mock.calls.every(call => call[0] === '{"status":"invalid"}')).toBe(true);
});

it('aborts while idle and removes signal listeners and timers', async () => {
  vi.useFakeTimers();
  const abort = new AbortController(), beforeInt = process.listenerCount('SIGINT'), beforeTerm = process.listenerCount('SIGTERM');
  const add = vi.spyOn(abort.signal, 'addEventListener'), remove = vi.spyOn(abort.signal, 'removeEventListener');
  const run = cmdCommsBus(['watch'], setup(), { signal: abort.signal, emit: () => {} });
  expect(vi.getTimerCount()).toBe(1);
  expect(process.listenerCount('SIGINT')).toBe(beforeInt + 1);
  expect(process.listenerCount('SIGTERM')).toBe(beforeTerm + 1);
  abort.abort(); expect(await run).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
  expect(process.listenerCount('SIGINT')).toBe(beforeInt);
  expect(process.listenerCount('SIGTERM')).toBe(beforeTerm);
  expect(remove).toHaveBeenCalledWith('abort', add.mock.calls[0]![1]);
});

it.each(['SIGINT', 'SIGTERM'] as const)('stops on %s and removes listeners', async signal => {
  vi.useFakeTimers();
  const before = process.listenerCount(signal);
  const run = cmdCommsBus(['watch'], setup(), { emit: () => {} });
  process.emit(signal);
  expect(await run).toBe(0);
  expect(process.listenerCount(signal)).toBe(before);
  expect(vi.getTimerCount()).toBe(0);
});

it('emits non-retryable failures and cleans up even if output throws', async () => {
  const before = process.listenerCount('SIGINT'), emit = vi.fn();
  expect(await cmdCommsBus(['watch'], {}, { list: () => ({ status: 'unavailable' }), emit })).toBe(1);
  expect(emit).toHaveBeenCalledWith('{"status":"unavailable"}');
  await expect(cmdCommsBus(['watch'], {}, { list: () => ({ status: 'ok', messages: [], nextCursor: 0 }), emit: () => { throw Error('output failed'); } })).rejects.toThrow('output failed');
  expect(process.listenerCount('SIGINT')).toBe(before);
});
