import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CHANNEL_ACK_TIMEOUT_MS, createChannelReceiver, type ChannelEnvelope } from '../src/core/fleet/channel-envelope.js';

const message = { channel: 'email' as const, verifiedSenderId: 'fake-sender', body: 'fake first message' };
const options = { allowedSenderIds: new Set([message.verifiedSenderId]), now: () => new Date('2026-10-31T04:13:00Z') };
const persisted = { ok: true as const, at: 'fake-time', bytes: 1 };
const directories: string[] = [];
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
afterEach(() => {
  vi.useRealTimers();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('channel acknowledgement deadline', () => {
  it('releases the queue at the deadline and handles a late transport rejection', async () => {
    vi.useFakeTimers();
    const gate = deferred<void>();
    const started = deferred<void>();
    const events: string[] = [];
    const write = vi.fn(async (entry: ChannelEnvelope) => { events.push(`write:${entry.body}`); return persisted; });
    const acknowledge = vi.fn(() => {
      events.push('ack');
      if (events.length === 2) { started.resolve(); return gate.promise; }
      return Promise.resolve();
    });
    const receive = createChannelReceiver({ ...options, write, acknowledge, acknowledgementTimeoutMs: 100 });
    const first = receive(message);
    const next = receive({ ...message, body: 'fake next message' });
    await started.promise;
    await vi.advanceTimersByTimeAsync(99);
    expect(events).toEqual(['write:fake first message', 'ack']);
    await vi.advanceTimersByTimeAsync(1);
    expect((await first)).toMatchObject({ ok: true, ack: { channel: 'email', status: 'accepted' } });
    expect((await next)).toMatchObject({ ok: true, ack: { channel: 'email', status: 'accepted' } });
    expect(events).toEqual(['write:fake first message', 'ack', 'write:fake next message', 'ack']);
    expect(acknowledge).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);

    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      gate.reject(new Error('fake late transport failure'));
      await Promise.resolve();
      vi.useRealTimers();
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(unhandled).not.toHaveBeenCalled();
      expect(acknowledge).toHaveBeenCalledTimes(2);
    } finally { process.off('unhandledRejection', unhandled); }
  });

  it('returns immediately on early success and clears the timer', async () => {
    vi.useFakeTimers();
    const acknowledge = vi.fn(async () => {});
    const receive = createChannelReceiver({ ...options, write: async () => persisted, acknowledge });
    expect(await receive(message)).toMatchObject({ ok: true, ack: { status: 'accepted' } });
    expect(acknowledge).toHaveBeenCalledTimes(1);
    expect(CHANNEL_ACK_TIMEOUT_MS).toBeGreaterThan(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('times out duplicate acknowledgement without another write', async () => {
    vi.useFakeTimers();
    const started = deferred<void>();
    const write = vi.fn(async () => persisted);
    const acknowledge = vi.fn().mockResolvedValueOnce(undefined).mockImplementationOnce(() => {
      started.resolve();
      return new Promise<void>(() => {});
    });
    const receive = createChannelReceiver({ ...options, write, acknowledge, acknowledgementTimeoutMs: 10 });
    const first = await receive(message);
    const duplicate = receive({ ...message, channel: 'telegram' });
    await started.promise;
    await vi.advanceTimersByTimeAsync(10);
    const result = await duplicate;
    expect(result).toMatchObject({ ok: true, ack: { channel: 'telegram', status: 'duplicate' } });
    if (!first.ok || !result.ok) throw new Error('expected successful receipts');
    expect(result.ack.dedupeKey).toBe(first.ack.dedupeKey);
    expect(write).toHaveBeenCalledTimes(1);
    expect(acknowledge).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not apply the acknowledgement deadline to pending persistence', async () => {
    vi.useFakeTimers();
    const gate = deferred<typeof persisted>();
    const started = deferred<void>();
    const acknowledge = vi.fn(async () => {});
    const receive = createChannelReceiver({ ...options, acknowledgementTimeoutMs: 10, acknowledge,
      write: () => { started.resolve(); return gate.promise; } });
    let settled = false;
    const result = receive(message).then((value) => { settled = true; return value; });
    await started.promise;
    await vi.advanceTimersByTimeAsync(100);
    expect(settled).toBe(false);
    expect(acknowledge).not.toHaveBeenCalled();
    gate.resolve(persisted);
    expect(await result).toMatchObject({ ok: true, ack: { status: 'accepted' } });
    expect(acknowledge).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('preserves the inbox and receipt across receiver restart after timeout', async () => {
    vi.useFakeTimers();
    const runsDir = mkdtempSync(join(tmpdir(), 'fake-ack-deadline-'));
    directories.push(runsDir);
    const started = deferred<void>();
    const receive = createChannelReceiver({ ...options, runsDir, acknowledgementTimeoutMs: 10,
      acknowledge: () => { started.resolve(); return new Promise<void>(() => {}); } });
    const first = receive(message);
    await started.promise;
    const path = join(runsDir, 'leader', 'MASON-INBOX.md');
    const before = readFileSync(path, 'utf8');
    expect(before).toContain(message.body);
    expect(before.match(/^## /gm)).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(10);
    const accepted = await first;
    const duplicate = await createChannelReceiver({ ...options, runsDir })({ ...message, channel: 'mobile' });
    expect(accepted).toMatchObject({ ok: true, ack: { status: 'accepted' } });
    expect(duplicate).toMatchObject({ ok: true, ack: { channel: 'mobile', status: 'duplicate' } });
    if (!accepted.ok || !duplicate.ok) throw new Error('expected successful receipts');
    expect(duplicate.ack.dedupeKey).toBe(accepted.ack.dedupeKey);
    expect(readFileSync(path, 'utf8')).toBe(before);
  });

  it.each([0, -1, 1.5, NaN, Infinity, 2_147_483_648, null])('rejects invalid timeout %s', (value) => {
    expect(() => createChannelReceiver({ ...options, acknowledgementTimeoutMs: value as number })).toThrow(RangeError);
  });
});
