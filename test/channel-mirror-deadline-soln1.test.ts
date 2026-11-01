import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CHANNEL_PUBLISH_TIMEOUT_MS, createChannelReceiver } from '../src/core/fleet/channel-envelope.js';

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
function runsDir() {
  const dir = mkdtempSync(join(tmpdir(), 'fake-mirror-deadline-'));
  directories.push(dir);
  return dir;
}
const inboxPath = (root: string) => join(root, 'leader', 'MASON-INBOX.md');
afterEach(() => {
  vi.useRealTimers();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('channel bus mirror deadline', () => {
  it('bounds a hung mirror: the persisted receipt is acked at the deadline and the next receive proceeds', async () => {
    vi.useFakeTimers();
    const root = runsDir();
    const gate = deferred<void>();
    const started = deferred<void>();
    const events: string[] = [];
    const publish = vi.fn()
      .mockImplementationOnce(() => { events.push('publish'); started.resolve(); return gate.promise; })
      .mockImplementation(async () => { events.push('publish'); });
    const acknowledge = vi.fn(async () => { events.push('ack'); });
    const receive = createChannelReceiver({ ...options, runsDir: root, publish, acknowledge, publishTimeoutMs: 100 });
    const first = receive(message);
    const next = receive({ ...message, body: 'fake next message' });
    await started.promise;
    // The durable inbox entry and receipt commit landed before the mirror wait began.
    const inbox = readFileSync(inboxPath(root), 'utf8');
    expect(inbox).toContain(message.body);
    expect(inbox.match(/^## /gm)).toHaveLength(1);
    let settled = false;
    void first.then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(99);
    expect(settled).toBe(false);
    expect(acknowledge).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(await first).toMatchObject({ ok: true, ack: { channel: 'email', status: 'accepted' }, publishState: 'failed' });
    expect(await next).toMatchObject({ ok: true, ack: { channel: 'email', status: 'accepted' }, publishState: 'published' });
    expect(events).toEqual(['publish', 'ack', 'publish', 'ack']);
    expect(acknowledge).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);

    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      gate.reject(new Error('fake late mirror failure'));
      await Promise.resolve();
      vi.useRealTimers();
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(unhandled).not.toHaveBeenCalled();
      expect(publish).toHaveBeenCalledTimes(2);
    } finally { process.off('unhandledRejection', unhandled); }

    // The receipt was committed before the mirror wait, so a restarted
    // receiver still dedupes the same sender and body.
    const retry = await createChannelReceiver({ ...options, runsDir: root, publish: null })({ ...message, channel: 'mobile' });
    expect(retry).toMatchObject({ ok: true, ack: { channel: 'mobile', status: 'duplicate' } });
  });

  it('keeps a resolved publication published and clears its timer', async () => {
    vi.useFakeTimers();
    const publish = vi.fn(async () => {});
    const receive = createChannelReceiver({ ...options, write: async () => persisted, publish, publishTimeoutMs: 100 });
    expect(await receive(message)).toMatchObject({ ok: true, ack: { status: 'accepted' }, publishState: 'published' });
    expect(publish).toHaveBeenCalledTimes(1);
    expect(CHANNEL_PUBLISH_TIMEOUT_MS).toBe(2_000);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('reports a rejected publication as failed and still acks the receipt', async () => {
    vi.useFakeTimers();
    const publish = vi.fn(async () => { throw new Error('fake mirror failure'); });
    const acknowledge = vi.fn(async () => {});
    const receive = createChannelReceiver({ ...options, write: async () => persisted, publish, acknowledge, publishTimeoutMs: 100 });
    expect(await receive(message)).toMatchObject({ ok: true, ack: { status: 'accepted' }, publishState: 'failed' });
    expect(acknowledge).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not mirror or add another inbox entry for a duplicate', async () => {
    const root = runsDir();
    const publish = vi.fn(async () => {});
    const receive = createChannelReceiver({ ...options, runsDir: root, publish, publishTimeoutMs: 100 });
    const first = await receive(message);
    const duplicate = await receive({ ...message, channel: 'telegram' });
    expect(first.ok && first.ack.status).toBe('accepted');
    expect(duplicate).toMatchObject({ ok: true, ack: { channel: 'telegram', status: 'duplicate' }, publishState: 'skipped' });
    if (!first.ok || !duplicate.ok) throw new Error('expected successful receipts');
    expect(duplicate.ack.dedupeKey).toBe(first.ack.dedupeKey);
    const inbox = readFileSync(inboxPath(root), 'utf8');
    expect(inbox.match(/^## /gm)).toHaveLength(1);
    expect(publish).toHaveBeenCalledTimes(1);
  });

  it.each([0, -1, 1.5, NaN, Infinity, 2_147_483_648, null])('rejects invalid publish timeout %s before any write', (value) => {
    const root = runsDir();
    const publish = vi.fn();
    expect(() => createChannelReceiver({ ...options, runsDir: root, publish, publishTimeoutMs: value as number })).toThrow(RangeError);
    expect(publish).not.toHaveBeenCalled();
    expect(existsSync(inboxPath(root))).toBe(false);
  });
});
