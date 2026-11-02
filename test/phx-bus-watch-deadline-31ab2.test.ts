import { afterEach, expect, it, vi } from 'vitest';
import { cmdCommsBus } from '../src/cli/comms-bus.js';
import type { listBusInboxAfter } from '../src/core/fleet/bus-inbox.js';

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

it('times out during persistent contention and releases timers and listeners', async () => {
  vi.useFakeTimers();
  const signal = new AbortController(), emit = vi.fn();
  const list = vi.fn<typeof listBusInboxAfter>().mockReturnValue({ status: 'retryable' });
  const beforeInt = process.listenerCount('SIGINT'), beforeTerm = process.listenerCount('SIGTERM');
  const remove = vi.spyOn(signal.signal, 'removeEventListener');
  const run = cmdCommsBus(['watch', '--interval-ms', '100', '--timeout-ms', '250'], {}, { signal: signal.signal, list, emit });
  expect(list).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(250);
  expect(await run).toBe(0);
  expect(list).toHaveBeenCalledTimes(3);
  expect(emit).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
  expect(process.listenerCount('SIGINT')).toBe(beforeInt);
  expect(process.listenerCount('SIGTERM')).toBe(beforeTerm);
  expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
});

it('emits empty pages only before the deadline, including when a poll is due at the deadline', async () => {
  vi.useFakeTimers();
  const list = vi.fn<typeof listBusInboxAfter>().mockReturnValue({ status: 'ok', messages: [], nextCursor: 0 });
  const emit = vi.fn();
  const run = cmdCommsBus(['watch', '--interval-ms', '100', '--timeout-ms', '200'], {}, { list, emit });
  await vi.advanceTimersByTimeAsync(200);
  expect(await run).toBe(0);
  expect(list).toHaveBeenCalledTimes(2);
  expect(emit).toHaveBeenCalledTimes(2);
  expect(emit).toHaveBeenCalledWith('{"status":"ok","messages":[],"nextCursor":0}');
  expect(vi.getTimerCount()).toBe(0);
});

it('stops earlier at max-pages and clears the deadline timer', async () => {
  vi.useFakeTimers();
  const emit = vi.fn();
  const run = cmdCommsBus(['watch', '--interval-ms', '100', '--timeout-ms', '1000', '--max-pages', '2'], {}, {
    list: () => ({ status: 'ok', messages: [], nextCursor: 0 }), emit,
  });
  await vi.advanceTimersByTimeAsync(100);
  expect(await run).toBe(0);
  expect(emit).toHaveBeenCalledTimes(2);
  expect(vi.getTimerCount()).toBe(0);
});

it('preserves terminal failures before the deadline, even after contention', async () => {
  vi.useFakeTimers();
  const list = vi.fn<typeof listBusInboxAfter>().mockReturnValueOnce({ status: 'retryable' }).mockReturnValue({ status: 'unavailable' });
  const emit = vi.fn();
  const run = cmdCommsBus(['watch', '--interval-ms', '100', '--timeout-ms', '200'], {}, { list, emit });
  await vi.advanceTimersByTimeAsync(100);
  expect(await run).toBe(1);
  expect(emit).toHaveBeenCalledExactlyOnceWith('{"status":"unavailable"}');
  expect(vi.getTimerCount()).toBe(0);
});

it('cancellation wins over a result and clears the deadline', async () => {
  vi.useFakeTimers();
  const signal = new AbortController(), emit = vi.fn();
  const list = vi.fn<typeof listBusInboxAfter>().mockImplementation(() => { signal.abort(); return { status: 'unavailable' }; });
  expect(await cmdCommsBus(['watch', '--timeout-ms', '100'], {}, { signal: signal.signal, list, emit })).toBe(0);
  expect(emit).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

it('checks elapsed time after a synchronous poll before emitting', async () => {
  vi.useFakeTimers();
  const now = vi.spyOn(performance, 'now').mockReturnValueOnce(0).mockReturnValueOnce(0).mockReturnValue(1);
  const emit = vi.fn();
  expect(await cmdCommsBus(['watch', '--timeout-ms', '1'], {}, {
    list: () => ({ status: 'ok', messages: [], nextCursor: 0 }), emit,
  })).toBe(0);
  expect(now).toHaveBeenCalled();
  expect(emit).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

it('rejects invalid timeouts and watch-only use without reading', async () => {
  vi.useFakeTimers();
  const log = vi.spyOn(console, 'log').mockImplementation(() => {}), list = vi.fn<typeof listBusInboxAfter>();
  for (const value of [[], ['0'], ['3600001'], ['-1'], ['1.5'], ['1e2'], ['01'], ['9007199254740992'], ['1', '--timeout-ms', '2']]) {
    expect(await cmdCommsBus(['watch', '--timeout-ms', ...value], {}, { list })).toBe(2);
  }
  expect(await cmdCommsBus(['read', '--timeout-ms', '1'], {}, { list })).toBe(2);
  expect(await cmdCommsBus(['post', '--file', 'fake', '--timeout-ms', '1'], {}, { list })).toBe(2);
  expect(list).not.toHaveBeenCalled();
  expect(log.mock.calls.every(call => call[0] === '{"status":"invalid"}')).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
});

it('accepts both timeout bounds and explains what completion means', async () => {
  vi.useFakeTimers();
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  for (const timeout of ['1', '3600000']) {
    expect(await cmdCommsBus(['watch', '--timeout-ms', timeout, '--max-pages', '1'], {}, {
      list: () => ({ status: 'ok', messages: [], nextCursor: 0 }), emit: () => {},
    })).toBe(0);
  }
  expect(await cmdCommsBus(['watch', '--help'])).toBe(0);
  expect(log).toHaveBeenCalledWith(expect.stringContaining('deadline completes observation successfully; it does not guarantee a reply'));
  expect(vi.getTimerCount()).toBe(0);
});
