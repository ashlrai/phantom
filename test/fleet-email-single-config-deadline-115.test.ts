import { getEventListeners } from 'node:events';
import { afterEach, expect, it, vi } from 'vitest';
import { cmdFleetEmailOutboxAwait } from '../src/cli/fleet-email-outbox-await.js';

const name = 'fake.reply.eml';
const args = ['--name', name, '--timeout-ms', '300', '--poll-ms', '100', '--json'];
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

it.each(['signal', 'SIGINT', 'SIGTERM'] as const)('cancels a stalled config read via %s and observes late rejection', async (kind) => {
  vi.useFakeTimers();
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const controller = new AbortController();
  const before = [process.listenerCount('SIGINT'), process.listenerCount('SIGTERM'), getEventListeners(controller.signal, 'abort').length];
  let reject!: (error: Error) => void;
  const readConfig = vi.fn(() => new Promise<never>((_resolve, fail) => { reject = fail; }));
  const read = vi.fn();
  const pending = cmdFleetEmailOutboxAwait(args, { signal: controller.signal, readConfig, read });
  await Promise.resolve();
  if (kind === 'signal') controller.abort(); else process.emit(kind);
  expect(await pending).toBe(130);
  expect(JSON.parse(String(log.mock.calls[0]![0]))).toEqual({ name, cancelled: true, timedOut: false });
  reject(new Error('late synthetic failure'));
  await Promise.resolve();
  expect(read).not.toHaveBeenCalled();
  expect([process.listenerCount('SIGINT'), process.listenerCount('SIGTERM'), getEventListeners(controller.signal, 'abort').length]).toEqual(before);
  expect(vi.getTimerCount()).toBe(0);
});

it('times out a stalled config read without polling', async () => {
  vi.useFakeTimers();
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const read = vi.fn();
  const pending = cmdFleetEmailOutboxAwait(args, { readConfig: () => new Promise(() => {}), read });
  await vi.advanceTimersByTimeAsync(300);
  expect(await pending).toBe(1);
  expect(JSON.parse(String(log.mock.calls[0]![0]))).toEqual({ name, cancelled: false, timedOut: true });
  expect(read).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

it('passes only the remaining budget to polling after valid config', async () => {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  let now = 0;
  const sleeps: number[] = [];
  const read = vi.fn(() => ({ entries: [] }));
  const code = await cmdFleetEmailOutboxAwait(args, {
    now: () => now,
    readConfig: async () => { now = 250; return { state: 'ok', path: '/fake/config', config: { v: 1, inboxDir: '/fake/inbox', from: ['fake@example.test'] } }; },
    read,
    sleep: async (ms) => { sleeps.push(ms); now += ms; },
  });
  expect(code).toBe(1);
  expect(sleeps).toEqual([50]);
  expect(JSON.parse(String(log.mock.calls[0]![0]))).toEqual({ name, timedOut: true, cancelled: false });
});

it('preserves normal completion with immediate valid config', async () => {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const read = vi.fn(() => ({ entries: [{ name, state: 'sent' as const }] }));
  expect(await cmdFleetEmailOutboxAwait(args, {
    readConfig: async () => ({ state: 'ok', path: '/fake/config', config: { v: 1, inboxDir: '/fake/inbox', from: ['fake@example.test'] } }),
    read,
  })).toBe(0);
  expect(JSON.parse(String(log.mock.calls[0]![0]))).toEqual({ name, state: 'sent', cancelled: false, timedOut: false });
});
