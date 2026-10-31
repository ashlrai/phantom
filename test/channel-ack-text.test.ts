import { describe, expect, it, vi } from 'vitest';
import { formatChannelAck } from '../src/core/fleet/channel-ack-text.js';
import { createChannelReceiver, INBOUND_CHANNELS } from '../src/core/fleet/channel-envelope.js';

const FAKE_RECEIPT = 'a'.repeat(64);

// ---- unit: accepted / duplicate text ----
describe('formatChannelAck', () => {
  it('returns accepted text with the full receipt', () => {
    const ack = { channel: 'email', dedupeKey: FAKE_RECEIPT, status: 'accepted' };
    expect(formatChannelAck(ack)).toBe(
      `Received by Phantom. Receipt: ${FAKE_RECEIPT}`,
    );
  });

  it('returns duplicate text with the full receipt', () => {
    const ack = { channel: 'telegram', dedupeKey: FAKE_RECEIPT, status: 'duplicate' };
    expect(formatChannelAck(ack)).toBe(
      `Already received by Phantom; no duplicate interjection added. Receipt: ${FAKE_RECEIPT}`,
    );
  });

  it.each(INBOUND_CHANNELS)('preserves the receipt for %s in accepted text', (channel) => {
    const ack = { channel, dedupeKey: FAKE_RECEIPT, status: 'accepted' };
    expect(formatChannelAck(ack)).toContain(FAKE_RECEIPT);
    expect(formatChannelAck(ack)).toBe(
      `Received by Phantom. Receipt: ${FAKE_RECEIPT}`,
    );
  });

  it.each(INBOUND_CHANNELS)('preserves the receipt for %s in duplicate text', (channel) => {
    const ack = { channel, dedupeKey: FAKE_RECEIPT, status: 'duplicate' };
    expect(formatChannelAck(ack)).toBe(
      `Already received by Phantom; no duplicate interjection added. Receipt: ${FAKE_RECEIPT}`,
    );
  });
});

// ---- integration: receiver + formatter ----
describe('integration with createChannelReceiver', () => {
  it('yields accepted then duplicate with same receipt', async () => {
    const sender = 'fake-channel-integration';
    const body = 'integration test body';
    let written = 0;
    const write = vi.fn(async () => { written++; return { ok: true as const, at: 'fake-time', bytes: 1 }; });
    const received: string[] = [];
    const acknowledge = vi.fn(async (ack) => {
      received.push(formatChannelAck(ack));
    });
    const receive = createChannelReceiver({
      allowedSenderIds: new Set([sender]),
      write,
      acknowledge,
      now: () => new Date(Date.parse('2026-01-01T00:00:00Z')),
    });
    const first = await receive({ channel: 'email', verifiedSenderId: sender, body });
    const second = await receive({ channel: 'cli', verifiedSenderId: sender, body });

    expect(first.ok).toBe(true);
    expect(first.ack.status).toBe('accepted');
    expect(second.ok).toBe(true);
    expect(second.ack.status).toBe('duplicate');
    expect(second.ack.dedupeKey).toBe(first.ok ? first.envelope.dedupeKey : '');

    expect(written).toBe(1);
    expect(received).toHaveLength(2);
    expect(received[0]).toBe(`Received by Phantom. Receipt: ${first.ok ? first.envelope.dedupeKey : ''}`);
    expect(received[1]).toBe(`Already received by Phantom; no duplicate interjection added. Receipt: ${second.ack.dedupeKey}`);
  });
});
