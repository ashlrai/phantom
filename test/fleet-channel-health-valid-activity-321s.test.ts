import { describe, expect, it } from 'vitest';
import { readChannelHealth, type ChannelSource } from '../src/core/fleet/channel-health.js';

const asOf = '2026-11-13T18:00:00.000Z';
const past = '2026-11-13T17:40:00.000Z';
const future = '2026-11-13T19:00:00.000Z';
const source = (inbound: string[], replies: string[]): ChannelSource => ({
  configMissing: () => [], processAlive: () => true, inbound: () => inbound, replies: () => replies,
});
const report = (src: ChannelSource) => readChannelHealth({
  now: () => new Date(asOf), host: 'fake-host', sources: { slack: src, imessage: src },
});

describe('valid channel activity', () => {
  it('projects the latest nonfuture observations and preserves degraded pending evidence', async () => {
    const result = await report(source([future, past, 'invalid'], [future, past, 'invalid']));
    expect(result.asOf).toBe(asOf);
    for (const channel of result.channels) {
      expect(channel).toMatchObject({ lastInboundAt: past, lastReplyAt: past, unansweredCount: 1,
        state: 'DEGRADED', proof: { requestCoverage: 'unproven', futureDatedCount: 2 } });
      expect(channel.missing).toContain(`${channel.channel} reply correlation unavailable`);
      expect(channel.missing).toContain(`${channel.channel} future-dated receipt ignored`);
    }
  });

  it('returns null for future-only or invalid activity', async () => {
    const result = await report(source([future, 'invalid'], [future, 'invalid']));
    for (const channel of result.channels) {
      expect(channel).toMatchObject({ lastInboundAt: null, lastReplyAt: null, unansweredCount: 0,
        state: 'UNKNOWN', proof: { requestCoverage: 'idle', futureDatedCount: 2 } });
    }
  });

  it('accepts observations exactly at asOf without verifying a reply', async () => {
    const result = await report(source([future, past, asOf], [future, asOf, past]));
    for (const channel of result.channels) {
      expect(channel).toMatchObject({ lastInboundAt: asOf, lastReplyAt: asOf, unansweredCount: 2,
        state: 'DEGRADED', proof: { requestCoverage: 'unproven', futureDatedCount: 2 } });
    }
  });
});
