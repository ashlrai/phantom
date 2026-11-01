import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { afterEach, expect, it, vi } from 'vitest';
import { BUS_INBOX_MAX_READ, appendBusInbox, listBusInboxAfter, type BusInboxReceipt } from '../src/core/fleet/bus-inbox.js';
import { requestBusRoundtrip } from '../src/core/fleet/bus-request-roundtrip.js';

const request = { id: 'request', from: 'planner', to: 'worker', priority: 'P2' as const, ttl: 5000, body: { work: 'test' } };
const reply = { id: 'reply', from: 'worker', to: 'planner', priority: 'P2' as const, ttl: 5000, body: { inReplyTo: request.id } };
const roots: string[] = [];
function storage() {
  const root = mkdtempSync(join(tmpdir(), 'bus-lifetime-')); roots.push(root);
  return { root, now: () => 1000 };
}
afterEach(() => {
  vi.useRealTimers(); vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it('times out promptly with a real stored request when TTL is shorter than the caller timeout', async () => {
  vi.useFakeTimers();
  let clock = 1000;
  vi.spyOn(performance, 'now').mockImplementation(() => clock);
  const options = storage();
  const pending = requestBusRoundtrip({ ...request, ttl: 80 }, 3_600_000, 60_000, options);
  clock += 80;
  await vi.advanceTimersByTimeAsync(80);
  const result = await pending;
  expect(result).toMatchObject({ outcome: 'timeout', receipt: { status: 'posted' }, reply: null });
  expect(result.elapsedMs).toBe(80);
  expect(vi.getTimerCount()).toBe(0);
  expect(listBusInboxAfter(0, 100, options)).toMatchObject({ status: 'ok', messages: [{ envelope: { ...request, ttl: 80 } }] });
});

it('accepts a timely correlated reply and preserves the original bytes for a duplicate retry', async () => {
  vi.spyOn(performance, 'now').mockReturnValue(1000);
  const options = storage();
  const append = vi.fn<typeof appendBusInbox>((input, opts) => {
    const result = appendBusInbox(input, opts);
    expect(appendBusInbox(reply, opts).status).toBe('posted');
    return result;
  });
  const first = await requestBusRoundtrip(request, 3_600_000, 100, options, { append });
  expect(first).toMatchObject({ outcome: 'replied', receipt: { status: 'posted' }, reply: { envelope: { id: reply.id } } });
  const path = join(options.root, 'bus-inbox', 'messages.json');
  const original = readFileSync(path, 'utf8');
  const retryAppend = vi.fn(appendBusInbox);
  const retry = await requestBusRoundtrip(request, 3_600_000, 100, options, { append: retryAppend });
  expect(retry).toMatchObject({ outcome: 'replied', receipt: { status: 'duplicate' }, reply: { envelope: { id: reply.id } } });
  expect(retryAppend.mock.calls[0]?.[0]).toEqual(request);
  expect(readFileSync(path, 'utf8')).toBe(original);
});

it('does not read or append when startedAt has already exhausted the lifetime', async () => {
  const list = vi.fn(listBusInboxAfter), append = vi.fn(appendBusInbox);
  const result = await requestBusRoundtrip(request, 3_600_000, 100, {}, { startedAt: performance.now() - request.ttl, list, append });
  expect(result).toMatchObject({ outcome: 'timeout', receipt: { status: 'not-attempted' } });
  expect(list).not.toHaveBeenCalled(); expect(append).not.toHaveBeenCalled();
});

it('does not post after a slow history page or retryable read exhausts the lifetime', async () => {
  let clock = 1000;
  vi.spyOn(performance, 'now').mockImplementation(() => clock);
  const rows: BusInboxReceipt[] = Array.from({ length: BUS_INBOX_MAX_READ }, (_, i) => ({
    cursor: i + 1, receivedAt: 1000, envelope: { ...reply, id: `old-${i}` },
  }));
  for (const status of ['page', 'retryable'] as const) {
    clock = 1000;
    const append = vi.fn(appendBusInbox);
    const list = vi.fn<typeof listBusInboxAfter>((after = 0) => {
      if (status === 'page' && after === 0) return { status: 'ok', messages: rows, nextCursor: rows.length };
      clock += request.ttl;
      return status === 'page' ? { status: 'ok', messages: [], nextCursor: after } : { status: 'retryable' };
    });
    const result = await requestBusRoundtrip(request, 3_600_000, 100, {}, { list, append });
    expect(result).toMatchObject({ outcome: 'timeout', receipt: { status: 'not-attempted' } });
    expect(list).toHaveBeenCalledTimes(status === 'page' ? 2 : 1); expect(append).not.toHaveBeenCalled();
  }
});

it('clamps retry waits to the remaining TTL and leaves no timer after timeout', async () => {
  vi.useFakeTimers();
  let clock = 1000;
  vi.spyOn(performance, 'now').mockImplementation(() => clock);
  const list = vi.fn<typeof listBusInboxAfter>(() => { clock += 20; return { status: 'retryable' }; });
  const append = vi.fn(appendBusInbox);
  const pending = requestBusRoundtrip({ ...request, ttl: 75 }, 3_600_000, 60_000, {}, { list, append });
  expect(vi.getTimerCount()).toBe(1);
  clock += 55;
  await vi.advanceTimersByTimeAsync(55);
  expect(await pending).toMatchObject({ outcome: 'timeout', receipt: { status: 'not-attempted' } });
  expect(list).toHaveBeenCalledTimes(1); expect(append).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

it('rejects a reply read at the lifetime boundary and gives cancellation precedence', async () => {
  let clock = 1000;
  vi.spyOn(performance, 'now').mockImplementation(() => clock);
  for (const cancel of [false, true]) {
    clock = 1000;
    const controller = new AbortController();
    const list = vi.fn<typeof listBusInboxAfter>()
      .mockReturnValueOnce({ status: 'ok', messages: [], nextCursor: 0 })
      .mockImplementationOnce(() => {
        clock += request.ttl;
        if (cancel) controller.abort();
        return { status: 'ok', messages: [{ cursor: 1, receivedAt: 1000, envelope: reply }], nextCursor: 1 };
      });
    const result = await requestBusRoundtrip(request, 3_600_000, 100, {}, {
      list, signal: controller.signal, append: () => ({ status: 'posted', id: request.id, cursor: 1 }),
    });
    expect(result).toMatchObject({ outcome: cancel ? 'cancelled' : 'timeout', receipt: { status: 'posted' }, reply: null });
  }
});

it('cancels a pending wait and clears its timer', async () => {
  vi.useFakeTimers();
  const controller = new AbortController();
  const pending = requestBusRoundtrip(request, 3_600_000, 60_000, {}, {
    signal: controller.signal, list: () => ({ status: 'retryable' }),
  });
  expect(vi.getTimerCount()).toBe(1);
  controller.abort();
  expect(await pending).toMatchObject({ outcome: 'cancelled', receipt: { status: 'not-attempted' } });
  expect(vi.getTimerCount()).toBe(0);
});
