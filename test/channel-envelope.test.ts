import { describe, expect, it, vi } from 'vitest';
import { createChannelReceiver, INBOUND_CHANNELS, CHANNEL_DEDUPE_WINDOW_MS } from '../src/core/fleet/channel-envelope.js';

const sender = 'fake-person-alice';
const start = Date.parse('2026-01-01T00:09:59Z');
function setup() {
  let time = start;
  const write = vi.fn(async () => ({ ok: true as const, at: 'fake-time', bytes: 1 }));
  const receive = createChannelReceiver({ allowedSenderIds: new Set([sender, 'fake-person-bob']), write, now: () => new Date(time) });
  return { write, receive, time: (value: number) => { time = value; } };
}
const message = { channel: 'email' as const, verifiedSenderId: sender, body: '  Hello\r\nworld  ' };

describe('shared channel envelope', () => {
  it('lands simultaneous cross-channel copies once and replies to each source', async () => {
    const { receive, write } = setup();
    const [first, second] = await Promise.all([receive(message), receive({ ...message, channel: 'telegram', body: 'Hello\nworld' })]);
    expect(write).toHaveBeenCalledTimes(1);
    expect(first.ok && first.ack.status).toBe('accepted');
    expect(second.ok && second.ack).toEqual({ channel: 'telegram', dedupeKey: first.ok && first.envelope.dedupeKey, status: 'duplicate' });
  });

  it('rejects unknown senders without writing or returning their data', async () => {
    const { receive, write } = setup();
    expect(await receive({ ...message, verifiedSenderId: 'fake-stranger' })).toEqual({ ok: false, reason: 'sender-not-allowed' });
    expect(write).not.toHaveBeenCalled();
  });

  it.each(INBOUND_CHANNELS)('%s normalizes to the same shape and names its source in the ack', async (channel) => {
    const { receive } = setup();
    const result = await receive({ ...message, channel });
    expect(result).toEqual({ ok: true, envelope: {
      channel, verifiedSenderId: sender, receivedAt: new Date(start).toISOString(), body: 'Hello\nworld', dedupeKey: expect.stringMatching(/^[a-f0-9]{64}$/),
    }, ack: { channel, dedupeKey: expect.any(String), status: 'accepted' } });
  });

  it('dedupes across clock buckets and accepts again at ten minutes', async () => {
    const { receive, write, time } = setup();
    const first = await receive(message);
    time(start + 2000);
    const duplicate = await receive({ ...message, channel: 'cli' });
    expect(duplicate.ok && duplicate.ack.status).toBe('duplicate');
    time(start + CHANNEL_DEDUPE_WINDOW_MS);
    const next = await receive(message);
    expect(next.ok && next.ack.status).toBe('accepted');
    expect(next.ok && next.envelope.dedupeKey).not.toBe(first.ok && first.envelope.dedupeKey);
    expect(write).toHaveBeenCalledTimes(2);
  });

  it('keeps different senders and different bodies distinct', async () => {
    const { receive, write } = setup();
    await receive(message);
    await receive({ ...message, verifiedSenderId: 'fake-person-bob' });
    await receive({ ...message, body: 'another message' });
    expect(write).toHaveBeenCalledTimes(3);
  });

  it('does not reserve a key after a failed write', async () => {
    const { receive, write } = setup();
    write.mockRejectedValueOnce(new Error('fake sink failure'));
    expect(await receive(message)).toEqual({ ok: false, reason: 'write-failed' });
    const retry = await receive(message);
    expect(retry.ok && retry.ack.status).toBe('accepted');
    expect(write).toHaveBeenCalledTimes(2);
  });

  it('rejects secret-shaped bodies and identities without echoing or writing them', async () => {
    const { receive, write } = setup();
    const body = 'password=plainly-fake-example';
    expect(await receive({ ...message, body })).toEqual({ ok: false, reason: 'secret-shaped' });
    const secretSender = 'password=plainly-fake-example';
    const other = createChannelReceiver({ allowedSenderIds: new Set([secretSender]), write });
    expect(await other({ ...message, verifiedSenderId: secretSender })).toEqual({ ok: false, reason: 'invalid' });
    expect(write).not.toHaveBeenCalled();
  });

  it('rejects empty, oversized, invalid channel and invalid time inputs', async () => {
    const { receive, write, time } = setup();
    expect(await receive({ ...message, body: '  ' })).toEqual({ ok: false, reason: 'empty' });
    expect(await receive({ ...message, body: 'x'.repeat(6001) })).toEqual({ ok: false, reason: 'too-long' });
    expect(await receive({ ...message, channel: 'unknown' as 'email' })).toEqual({ ok: false, reason: 'invalid' });
    time(NaN);
    expect(await receive(message)).toEqual({ ok: false, reason: 'invalid' });
    expect(write).not.toHaveBeenCalled();
  });
});
