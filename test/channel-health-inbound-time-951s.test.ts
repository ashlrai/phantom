import { describe, expect, it } from 'vitest';
import { readChannelHealth, type ChannelSource } from '../src/core/fleet/channel-health.js';

const now = '2026-11-13T18:00:00.000Z';
const recent = '2026-11-13T17:59:00.000Z';
const overdue = '2026-11-13T17:40:00.000Z';
const malformed = 'private-malformed-timestamp';

async function report(times: string[], rich: boolean, overrides: Partial<ChannelSource> = {}) {
  const src: ChannelSource = {
    configMissing: () => [], processAlive: () => true, inbound: () => times, replies: () => [],
    ...(rich ? { inboundEvidence: () => ({ store: 'ok' as const, rows: times.map((at) => ({ at })) }) } : {}),
    ...overrides,
  };
  return readChannelHealth({ now: () => new Date(now), host: 'fake-host', sources: { slack: src, imessage: src } });
}

describe.each([false, true])('inbound timestamps (evidence=%s)', (rich) => {
  it('does not certify malformed-only input and never exposes its value', async () => {
    const result = await report([malformed], rich);
    expect(JSON.stringify(result)).not.toContain(malformed);
    for (const channel of result.channels) {
      expect(channel).toMatchObject({ state: 'UNKNOWN', lastInboundAt: null, unansweredCount: 0,
        proof: { futureDatedCount: 0 } });
      expect(channel.missing).toContain(`${channel.channel} inbound evidence time invalid`);
    }
  });

  it('preserves recent and overdue pending observations', async () => {
    for (const [time, state] of [[recent, 'UNKNOWN'], [overdue, 'DEGRADED']] as const) {
      const result = await report([malformed, time], rich);
      for (const channel of result.channels) {
        expect(channel).toMatchObject({ state, lastInboundAt: time, unansweredCount: 1,
          proof: { requestCoverage: 'unproven', futureDatedCount: 0 } });
        expect(channel.missing).toContain(`${channel.channel} inbound evidence time invalid`);
      }
    }
  });

  it('keeps idle and exact-now valid input live', async () => {
    for (const times of [[], [now]]) {
      const result = await report(times, rich);
      for (const channel of result.channels) {
        expect(channel).toMatchObject({ state: 'LIVE', lastInboundAt: times[0] ?? null,
          unansweredCount: times.length, proof: { futureDatedCount: 0 } });
      }
    }
  });

  it('retains the invalid reason alongside a recent outbound failure', async () => {
    const result = await report([malformed], rich, { outboundFailure: () => ({ at: recent }) });
    for (const channel of result.channels) {
      expect(channel.state).toBe('DEGRADED');
      expect(channel.missing).toContain(`${channel.channel} inbound evidence time invalid`);
      expect(channel.missing).toContain(`${channel.channel} outbound send failed`);
    }
  });
});
