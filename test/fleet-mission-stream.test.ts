import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { afterEach, expect, it, vi } from 'vitest';

const watched = vi.hoisted(() => ({ changed: () => {}, close: vi.fn() }));
vi.mock('node:fs', async (original) => ({
  ...await original<typeof import('node:fs')>(),
  watch: vi.fn((_root, _options, listener) => {
    watched.changed = listener;
    return { close: watched.close, on: vi.fn() };
  }),
}));
import { handleMissionStream } from '../src/core/verse/verse-stream.js';

afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });

it('coalesces file changes, closes watchers at expiry and sends no file contents', async () => {
  vi.useFakeTimers();
  const req = new EventEmitter() as IncomingMessage;
  const res = Object.assign(new EventEmitter(), { writeHead: vi.fn(), write: vi.fn(() => true), end: vi.fn() }) as unknown as ServerResponse;
  await handleMissionStream(req, res, { id: 'test', expiresAt: Date.now() + 1000 }, ['/fixture']);
  watched.changed(); watched.changed();
  await vi.advanceTimersByTimeAsync(150);
  expect(res.write).toHaveBeenCalledExactlyOnceWith('event: mission\ndata: {}\n\n');
  await vi.advanceTimersByTimeAsync(850);
  expect(watched.close).toHaveBeenCalledOnce();
  expect(res.end).toHaveBeenCalledOnce();
});

it('refuses an expired read session before opening a watcher', async () => {
  const req = new EventEmitter() as IncomingMessage;
  const res = { writeHead: vi.fn(), end: vi.fn() } as unknown as ServerResponse;
  await handleMissionStream(req, res, { id: 'expired', expiresAt: 0 }, ['/fixture']);
  expect(res.writeHead).toHaveBeenCalledWith(401, expect.anything());
  expect(watched.close).not.toHaveBeenCalled();
});
