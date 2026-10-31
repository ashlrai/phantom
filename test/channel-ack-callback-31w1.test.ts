import { describe, expect, it, vi } from 'vitest';
import { createChannelReceiver, type ChannelAck } from '../src/core/fleet/channel-envelope.js';

const message = { channel: 'email' as const, verifiedSenderId: 'fake-sender', body: ' fake message\r\n' };
const persisted = { ok: true as const, at: 'fake-time', bytes: 1 };
const now = () => new Date('2026-01-01T00:00:00Z');

describe('channel acknowledgement callback', () => {
  it('calls after persistence and acknowledges cross-channel duplicates with only ack fields', async () => {
    const events: string[] = [];
    const write = vi.fn(async () => { events.push('write'); return persisted; });
    const acknowledge = vi.fn(async (ack: ChannelAck) => { events.push(ack.status); });
    const receive = createChannelReceiver({ allowedSenderIds: new Set([message.verifiedSenderId]), now, write, acknowledge });

    const first = await receive(message);
    const second = await receive({ ...message, channel: 'telegram', body: 'fake message' });
    expect(first.ok).toBe(true);
    if (!first.ok || !second.ok) throw new Error('expected successful receipts');
    expect(events).toEqual(['write', 'accepted', 'duplicate']);
    expect(write).toHaveBeenCalledTimes(1);
    expect(acknowledge.mock.calls).toEqual([
      [{ channel: 'email', dedupeKey: first.ack.dedupeKey, status: 'accepted' }],
      [{ channel: 'telegram', dedupeKey: first.ack.dedupeKey, status: 'duplicate' }],
    ]);
    expect(second.ack).toEqual(acknowledge.mock.calls[1][0]);
  });

  it('does not acknowledge rejections or failed writes, and retries failed writes', async () => {
    const write = vi.fn()
      .mockResolvedValueOnce({ ok: false, reason: 'full' })
      .mockRejectedValueOnce(new Error('fake write failure'))
      .mockResolvedValue(persisted);
    const acknowledge = vi.fn(async (_ack: ChannelAck) => {});
    const receive = createChannelReceiver({ allowedSenderIds: new Set([message.verifiedSenderId]), now, write, acknowledge });

    expect(await receive({ ...message, verifiedSenderId: 'fake-stranger' })).toEqual({ ok: false, reason: 'sender-not-allowed' });
    expect(await receive({ ...message, body: ' ' })).toEqual({ ok: false, reason: 'empty' });
    expect(await receive(message)).toEqual({ ok: false, reason: 'full' });
    expect(await receive(message)).toEqual({ ok: false, reason: 'write-failed' });
    expect(acknowledge).not.toHaveBeenCalled();
    const retry = await receive(message);
    expect(retry.ok && retry.ack.status).toBe('accepted');
    expect(write).toHaveBeenCalledTimes(3);
    expect(acknowledge).toHaveBeenCalledTimes(1);
  });

  it('keeps successful dedupe bookkeeping when acknowledgement rejects', async () => {
    const write = vi.fn(async () => persisted);
    const acknowledge = vi.fn(async (_ack: ChannelAck) => { throw new Error('fake transport failure'); });
    const receive = createChannelReceiver({ allowedSenderIds: new Set([message.verifiedSenderId]), now, write, acknowledge });

    const first = await receive(message);
    const duplicate = await receive({ ...message, channel: 'desktop' });
    expect(first.ok && first.ack.status).toBe('accepted');
    expect(duplicate.ok && duplicate.ack).toEqual({ channel: 'desktop', dedupeKey: first.ok && first.ack.dedupeKey, status: 'duplicate' });
    expect(write).toHaveBeenCalledTimes(1);
    expect(acknowledge).toHaveBeenCalledTimes(2);
  });

  it('detaches the callback argument from the returned acknowledgement', async () => {
    const receive = createChannelReceiver({
      allowedSenderIds: new Set([message.verifiedSenderId]), now,
      write: async () => persisted,
      acknowledge: async (ack) => { ack.channel = 'cli'; ack.dedupeKey = 'changed'; ack.status = 'duplicate'; },
    });
    const result = await receive(message);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected a successful receipt');
    expect(result.ack).toEqual({ channel: 'email', dedupeKey: result.envelope.dedupeKey, status: 'accepted' });
    expect(result.ack.dedupeKey).not.toBe('changed');
  });

  it('serializes concurrent persistence and callbacks in receive order', async () => {
    let releaseWrite!: () => void;
    let releaseAck!: () => void;
    let writeStarted!: () => void;
    let ackStarted!: () => void;
    const writeGate = new Promise<void>((resolve) => { releaseWrite = resolve; });
    const ackGate = new Promise<void>((resolve) => { releaseAck = resolve; });
    const writing = new Promise<void>((resolve) => { writeStarted = resolve; });
    const acknowledging = new Promise<void>((resolve) => { ackStarted = resolve; });
    const events: string[] = [];
    const write = vi.fn(async () => { events.push('write'); writeStarted(); await writeGate; return persisted; });
    const acknowledge = vi.fn(async (ack: ChannelAck) => {
      events.push(ack.status);
      if (ack.status === 'accepted') { ackStarted(); await ackGate; }
    });
    const receive = createChannelReceiver({ allowedSenderIds: new Set([message.verifiedSenderId]), now, write, acknowledge });
    const first = receive(message);
    const second = receive({ ...message, channel: 'mobile' });
    await writing;
    expect(events).toEqual(['write']);
    releaseWrite();
    await acknowledging;
    expect(events).toEqual(['write', 'accepted']);
    releaseAck();
    const results = await Promise.all([first, second]);
    expect(results.map((result) => result.ok && result.ack.status)).toEqual(['accepted', 'duplicate']);
    expect(events).toEqual(['write', 'accepted', 'duplicate']);
    expect(write).toHaveBeenCalledTimes(1);
  });
});
