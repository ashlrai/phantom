import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { cmdCommsBus } from '../src/cli/comms-bus.js';
import type { listBusInboxAfter } from '../src/core/fleet/bus-inbox.js';

const roots: string[] = [];
function deferred() {
  let resolve!: () => void, reject!: (reason: Error) => void;
  const promise = new Promise<void>((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true }));
});

it('waits for each asynchronous delivery before scanning and delivers pages in cursor order', async () => {
  vi.useFakeTimers();
  const first = deferred(), abort = new AbortController(), pages: number[] = [];
  const list = vi.fn<typeof listBusInboxAfter>((after) => ({ status: 'ok', messages: [], nextCursor: after + 1 }));
  const run = cmdCommsBus(['watch', '--interval-ms', '100', '--max-pages', '2'], {}, {
    signal: abort.signal, list,
    emit: json => {
      pages.push(JSON.parse(json).nextCursor);
      if (pages.length === 1) return first.promise;
    },
  });

  await vi.advanceTimersByTimeAsync(500);
  expect(list.mock.calls.map(call => call[0])).toEqual([0]);
  expect(pages).toEqual([1]);
  first.resolve();
  await vi.advanceTimersByTimeAsync(100);
  expect(await run).toBe(0);
  expect(list.mock.calls.map(call => call[0])).toEqual([0, 1]);
  expect(pages).toEqual([1, 2]);
});

it.each(['ok', 'unavailable'] as const)('stops on a rejected %s delivery without exposing the sink error', async status => {
  vi.useFakeTimers();
  const sink = deferred(), abort = new AbortController(), unhandled = vi.fn();
  const diagnostic = vi.spyOn(console, 'error').mockImplementation(() => {});
  const list = vi.fn<typeof listBusInboxAfter>(() => status === 'ok'
    ? { status: 'ok', messages: [], nextCursor: 1 }
    : { status: 'unavailable' });
  process.on('unhandledRejection', unhandled);
  try {
    const run = cmdCommsBus(['watch', '--interval-ms', '100'], {}, {
      signal: abort.signal, list, emit: () => sink.promise,
    });
    await vi.advanceTimersByTimeAsync(500);
    expect(list).toHaveBeenCalledTimes(1);
    sink.reject(new Error('private sink details'));
    expect(await run).toBe(1);
    await vi.advanceTimersByTimeAsync(500);
    expect(list).toHaveBeenCalledTimes(1);
    expect(unhandled).not.toHaveBeenCalled();
    expect(diagnostic.mock.calls).toEqual([['bus watch: delivery failed']]);
  } finally {
    process.off('unhandledRejection', unhandled);
    abort.abort();
  }
});

it('waits for terminal status delivery before returning', async () => {
  const sink = deferred(), abort = new AbortController(), emit = vi.fn(() => sink.promise);
  const list = vi.fn<typeof listBusInboxAfter>(() => ({ status: 'unavailable' }));
  let settled = false;
  const run = cmdCommsBus(['watch'], {}, { signal: abort.signal, list, emit }).then(code => { settled = true; return code; });
  await Promise.resolve();
  expect(settled).toBe(false);
  expect(emit).toHaveBeenCalledWith('{"status":"unavailable"}');
  sink.resolve();
  expect(await run).toBe(1);
  expect(list).toHaveBeenCalledTimes(1);
});

it('retains a previously saved checkpoint after a rejected delivery', async () => {
  const root = mkdtempSync(join(tmpdir(), 'bus-delivery-')); roots.push(root);
  const checkpoint = join(root, 'checkpoint.json');
  const list = vi.fn<typeof listBusInboxAfter>(after => ({ status: 'ok', messages: [], nextCursor: after + 1 }));
  const abort = new AbortController();
  expect(await cmdCommsBus(['watch', '--checkpoint', checkpoint, '--max-pages', '1'], {}, {
    signal: abort.signal, list, emit: () => {},
  })).toBe(0);
  const before = readFileSync(checkpoint, 'utf8');
  const diagnostic = vi.spyOn(console, 'error').mockImplementation(() => {});
  const sink = deferred();
  const run = cmdCommsBus(['watch', '--checkpoint', checkpoint], {}, { signal: abort.signal, list, emit: () => sink.promise });
  sink.reject(new Error('private sink details'));
  expect(await run).toBe(1);
  expect(readFileSync(checkpoint, 'utf8')).toBe(before);
  expect(JSON.parse(before).scanCursor).toBe(1);
  expect(list.mock.calls.map(call => call[0])).toEqual([0, 1]);
  expect(diagnostic.mock.calls).toEqual([['bus watch: delivery failed']]);
});

it('waits for an in-flight sink after cancellation and saves its delivered cursor', async () => {
  const root = mkdtempSync(join(tmpdir(), 'bus-delivery-')); roots.push(root);
  const checkpoint = join(root, 'checkpoint.json'), sink = deferred(), abort = new AbortController();
  const list = vi.fn<typeof listBusInboxAfter>(() => ({ status: 'ok', messages: [], nextCursor: 1 }));
  let settled = false;
  const run = cmdCommsBus(['watch', '--checkpoint', checkpoint], {}, {
    signal: abort.signal, list, emit: () => sink.promise,
  }).then(code => { settled = true; return code; });
  abort.abort();
  await Promise.resolve();
  expect(settled).toBe(false);
  sink.resolve();
  expect(await run).toBe(0);
  expect(JSON.parse(readFileSync(checkpoint, 'utf8')).scanCursor).toBe(1);
  expect(list).toHaveBeenCalledTimes(1);
});
