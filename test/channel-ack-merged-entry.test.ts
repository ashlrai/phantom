import { describe, expect, it } from 'vitest';
import { formatChannelAck } from '../src/core/fleet/channel-ack-text.js';

const FAKE_RECEIPT = 'k-test-1';

describe('formatChannelAck — cross-channel merge (entryId)', () => {
  it('returns merged text when status is duplicate and entryId is valid', () => {
    const ack = { channel: 'email', dedupeKey: FAKE_RECEIPT, status: 'duplicate', entryId: 't-abc-03' };
    expect(formatChannelAck(ack)).toBe(
      `Already received by Phantom from another channel; this one is attached to that instruction (entry t-abc-03). Receipt: ${FAKE_RECEIPT}`,
    );
  });

  it('returns the old duplicate text when entryId is absent', () => {
    const ack = { channel: 'email', dedupeKey: FAKE_RECEIPT, status: 'duplicate' };
    expect(formatChannelAck(ack)).toBe(
      `Already received by Phantom; no duplicate interjection added. Receipt: ${FAKE_RECEIPT}`,
    );
  });

  it('returns the old duplicate text when entryId contains a space', () => {
    const ack = { channel: 'email', dedupeKey: FAKE_RECEIPT, status: 'duplicate', entryId: 'has space' };
    expect(formatChannelAck(ack)).toBe(
      `Already received by Phantom; no duplicate interjection added. Receipt: ${FAKE_RECEIPT}`,
    );
  });

  it('returns the old duplicate text when entryId exceeds 64 characters', () => {
    const ack = { channel: 'email', dedupeKey: FAKE_RECEIPT, status: 'duplicate', entryId: 'a'.repeat(65) };
    expect(formatChannelAck(ack)).toBe(
      `Already received by Phantom; no duplicate interjection added. Receipt: ${FAKE_RECEIPT}`,
    );
  });

  it('returns the accepted text (unchanged)', () => {
    const ack = { channel: 'telegram', dedupeKey: FAKE_RECEIPT, status: 'accepted' };
    expect(formatChannelAck(ack)).toBe(
      `Received by Phantom. Receipt: ${FAKE_RECEIPT}`,
    );
  });
});
