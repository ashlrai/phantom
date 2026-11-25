import { describe, expect, it } from 'vitest';
import { readChannelHealth, type ChannelSource } from '../src/core/fleet/channel-health.js';

const now = '2026-11-13T18:00:00.000Z';
const recent = '2026-11-13T17:59:00.000Z';
const overdue = '2026-11-13T17:40:00.000Z';
const malformed = 'private-malformed-coverage-time';

async function report(inbound: string[], answeredAt: string[], unansweredAt: string[], rich: boolean) {
  const source: ChannelSource = {
    configMissing: () => [], processAlive: () => true, inbound: () => inbound, replies: () => [],
    replyBinding: () => ({ store: 'ok', answeredAt, unansweredAt, futureDated: 0 }),
    ...(rich ? { inboundEvidence: () => ({ store: 'ok' as const, rows: inbound.map((at) => ({ at })) }) } : {}),
  };
  const result = await readChannelHealth({ now: () => new Date(now), host: 'fake-host', sources: { slack: source, imessage: source } });
  expect(JSON.stringify(result)).not.toContain(malformed);
  return result.channels;
}

describe.each([false, true])('request coverage with rich evidence=%s', (rich) => {
  it('retains answered observations but does not certify malformed input', async () => {
    for (const channel of await report([malformed, recent], [recent], [], rich)) {
      expect(channel).toMatchObject({ state: 'UNKNOWN', lastInboundAt: recent, unansweredCount: 0,
        proof: { requestCoverage: 'unproven', answeredCount: 1 } });
      expect(channel.missing).toContain(`${channel.channel} inbound evidence time invalid`);
    }
  });

  it('does not report malformed-only input as idle', async () => {
    for (const channel of await report([malformed], [], [], rich)) {
      expect(channel).toMatchObject({ state: 'UNKNOWN', lastInboundAt: null, unansweredCount: 0,
        proof: { requestCoverage: 'unproven', answeredCount: 0 } });
    }
  });

  it('keeps overdue requests degraded and coverage unproven', async () => {
    for (const channel of await report([malformed, overdue], [], [overdue], rich)) {
      expect(channel).toMatchObject({ state: 'DEGRADED', lastInboundAt: overdue, unansweredCount: 1,
        proof: { requestCoverage: 'unproven', answeredCount: 0 } });
    }
  });

  it('verifies an entirely valid answered set', async () => {
    for (const channel of await report([recent], [recent], [], rich)) {
      expect(channel).toMatchObject({ state: 'LIVE', lastInboundAt: recent, unansweredCount: 0,
        proof: { requestCoverage: 'verified', answeredCount: 1 } });
    }
  });

  it('reports an entirely valid empty set as idle', async () => {
    for (const channel of await report([], [], [], rich)) {
      expect(channel).toMatchObject({ state: 'LIVE', lastInboundAt: null, unansweredCount: 0,
        proof: { requestCoverage: 'idle', answeredCount: 0 } });
    }
  });
});
