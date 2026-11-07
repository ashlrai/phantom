import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { cmdCommsBus } from '../src/cli/comms-bus.js';
import { appendBusInbox, listBusInboxAfter, type BusInboxPage } from '../src/core/fleet/bus-inbox.js';

const roots: string[] = [];
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'bounded-bus-'));
  roots.push(root);
  return { root, now: () => 100 };
}
function post(id: string, to: string, options: ReturnType<typeof setup>) {
  expect(appendBusInbox({ id, from: 'fake-leader', to, priority: 'P1', ttl: 1000, body: 'fake' }, options).status).toBe('posted');
}
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it('emits two pages, releases resources, and resumes from the persistent cursor', async () => {
  vi.useFakeTimers();
  const options = setup(), pages: BusInboxPage[] = [], signal = new AbortController();
  for (const id of ['one', 'two', 'three']) post(id, 'fake-worker', options);
  const beforeInt = process.listenerCount('SIGINT'), beforeTerm = process.listenerCount('SIGTERM');
  const remove = vi.spyOn(signal.signal, 'removeEventListener');
  const run = cmdCommsBus(['watch', '--limit', '1', '--interval-ms', '100', '--max-pages', '2'], options, {
    signal: signal.signal, emit: json => pages.push(JSON.parse(json) as BusInboxPage),
  });
  expect(pages).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(100);
  expect(await run).toBe(0);
  expect(pages.map(page => page.status === 'ok' ? [page.nextCursor, page.messages.map(row => row.envelope.id)] : page.status))
    .toEqual([[1, ['one']], [2, ['two']]]);
  expect(vi.getTimerCount()).toBe(0);
  expect(process.listenerCount('SIGINT')).toBe(beforeInt);
  expect(process.listenerCount('SIGTERM')).toBe(beforeTerm);
  expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));

  const resumed: BusInboxPage[] = [];
  expect(await cmdCommsBus(['watch', '--after', '2', '--max-pages', '1'], options, {
    emit: json => resumed.push(JSON.parse(json) as BusInboxPage),
  })).toBe(0);
  expect(resumed.map(page => page.status === 'ok' ? [page.nextCursor, page.messages.map(row => row.envelope.id)] : page.status))
    .toEqual([[3, ['three']]]);
  expect(vi.getTimerCount()).toBe(0);
});

it('counts filtered empty pages while advancing the scanned cursor', async () => {
  vi.useFakeTimers();
  const options = setup(), pages: BusInboxPage[] = [];
  post('one', 'other', options); post('two', 'other', options); post('three', 'fake-worker', options);
  const run = cmdCommsBus(['watch', '--to', 'fake-worker', '--limit', '1', '--interval-ms', '100', '--max-pages', '2'], options, {
    emit: json => pages.push(JSON.parse(json) as BusInboxPage),
  });
  await vi.advanceTimersByTimeAsync(100);
  expect(await run).toBe(0);
  expect(pages).toEqual([{ status: 'ok', messages: [], nextCursor: 1 }, { status: 'ok', messages: [], nextCursor: 2 }]);
  expect(vi.getTimerCount()).toBe(0);
});

it('retries contention without spending a page or advancing the cursor', async () => {
  vi.useFakeTimers();
  const options = setup(), pages: BusInboxPage[] = [];
  post('one', 'fake-worker', options); post('two', 'fake-worker', options);
  const list = vi.fn<typeof listBusInboxAfter>().mockImplementationOnce(listBusInboxAfter)
    .mockReturnValueOnce({ status: 'retryable' }).mockImplementation(listBusInboxAfter);
  const run = cmdCommsBus(['watch', '--limit', '1', '--interval-ms', '100', '--max-pages', '2'], options, {
    list, emit: json => pages.push(JSON.parse(json) as BusInboxPage),
  });
  await vi.advanceTimersByTimeAsync(100);
  expect(pages).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(100);
  expect(await run).toBe(0);
  expect(list.mock.calls.map(call => call[0])).toEqual([0, 1, 1]);
  expect(pages.map(page => page.status === 'ok' ? page.nextCursor : page.status)).toEqual([1, 2]);
  expect(vi.getTimerCount()).toBe(0);
});

it('rejects invalid bounds and rejects the watch-only option on read and post', async () => {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {}), list = vi.fn(listBusInboxAfter);
  const invalid = [[], ['0'], ['10001'], ['-1'], ['1.5'], ['1e2'], ['01'], ['9007199254740992'], ['2', '--max-pages', '3']];
  for (const value of invalid) {
    expect(await cmdCommsBus(['watch', '--max-pages', ...value], setup(), { list })).toBe(2);
  }
  expect(await cmdCommsBus(['read', '--max-pages', '1'], setup(), { list })).toBe(2);
  expect(await cmdCommsBus(['post', '--file', 'fake', '--max-pages', '1'], setup(), { list })).toBe(2);
  expect(list).not.toHaveBeenCalled();
  expect(log.mock.calls).toHaveLength(invalid.length + 2);
  expect(log.mock.calls.every(call => call[0] === '{"status":"invalid"}')).toBe(true);
});

it('accepts the upper bound and still exits on a non-retryable failure', async () => {
  const emit = vi.fn();
  const before = process.listenerCount('SIGTERM');
  expect(await cmdCommsBus(['watch', '--max-pages', '10000'], setup(), {
    list: () => ({ status: 'unavailable' }), emit,
  })).toBe(1);
  expect(emit).toHaveBeenCalledWith('{"status":"unavailable"}');
  expect(process.listenerCount('SIGTERM')).toBe(before);
});
