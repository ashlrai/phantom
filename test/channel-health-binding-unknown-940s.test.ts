import { describe, expect, it } from 'vitest';
import { readChannelHealth, type ChannelSource, type ReplyBindingEvidence } from '../src/core/fleet/channel-health.js';

const now = new Date('2026-11-13T18:00:00.000Z');
const ago = (minutes: number) => new Date(now.getTime() - minutes * 60_000).toISOString();
const source = (overrides: Partial<ChannelSource> = {}): ChannelSource => ({
  configMissing: () => [], processAlive: () => true, inbound: () => [], replies: () => [], ...overrides,
});
const run = async (slack: ChannelSource) => (await readChannelHealth({
  now: () => now, host: 'fake-host', sources: { slack, imessage: source() },
})).channels[0]!;
const unavailable: [string, () => ReplyBindingEvidence][] = [
  ['throw', () => { throw new Error('private exception payload'); }],
  ['missing', () => ({ store: 'missing', answeredAt: [], unansweredAt: [], futureDated: 0 })],
  ['unreadable', () => ({ store: 'unreadable', answeredAt: [], unansweredAt: [], futureDated: 0 })],
];

describe('unavailable reply binding', () => {
  it.each(unavailable)('%s cannot certify idle, expired or recent traffic', async (_kind, replyBinding) => {
    for (const [inbound, coverage] of [[[], 'idle'], [[ago(120)], 'idle'], [[ago(5)], 'unproven']] as const) {
      const result = await run(source({ inbound: () => [...inbound], replyBinding }));
      expect(result).toMatchObject({ state: 'UNKNOWN', missing: ['slack reply binding unreadable'],
        proof: { requestCoverage: coverage, futureDatedCount: 0 }, unansweredCount: coverage === 'idle' ? 0 : 1 });
      expect(result.proof).not.toHaveProperty('answeredCount');
      expect(JSON.stringify(result)).not.toContain('private exception payload');
    }
  });

  it.each(unavailable)('%s retains positive degradation', async (_kind, replyBinding) => {
    const cases: [Partial<ChannelSource>, string, string][] = [
      [{ inbound: () => [ago(20)] }, 'unproven', 'slack reply binding unreadable'],
      [{ inboundEvidence: () => ({ store: 'ok', rows: [{ at: ago(5), admission: 'failed' }] }) }, 'unproven', 'slack durable ingress failed'],
      [{ outboundFailure: () => ({ at: ago(5) }) }, 'idle', 'slack outbound send failed'],
    ];
    for (const [overrides, coverage, reason] of cases) {
      const result = await run(source({ ...overrides, replyBinding }));
      expect(result.state).toBe('DEGRADED');
      expect(result.missing).toContain(reason);
      expect(result.missing).toContain('slack reply binding unreadable');
      expect(result.proof.requestCoverage).toBe(coverage);
      expect(result.proof).not.toHaveProperty('answeredCount');
    }
  });

  it.each(unavailable)('%s preserves blocked configuration and process', async (_kind, replyBinding) => {
    for (const [overrides, missing] of [
      [{ configMissing: () => ['slack bridge'] }, 'slack bridge not configured'],
      [{ processAlive: () => false }, 'slack bridge process not running'],
    ] as [Partial<ChannelSource>, string][]) {
      const result = await run(source({ ...overrides, replyBinding }));
      expect(result).toMatchObject({ state: 'BLOCKED', missing: [missing], proof: { requestCoverage: 'idle' } });
      expect(result.proof).not.toHaveProperty('answeredCount');
    }
  });

  it('supports an absent binder and verifies a readable binding', async () => {
    expect(await run(source())).toMatchObject({ state: 'LIVE', missing: [], proof: { requestCoverage: 'idle' } });
    const result = await run(source({ inbound: () => [ago(5)], replyBinding: () => ({
      store: 'ok', answeredAt: [ago(5)], unansweredAt: [], futureDated: 0,
    }) }));
    expect(result).toMatchObject({ state: 'LIVE', missing: [], unansweredCount: 0,
      proof: { requestCoverage: 'verified', answeredCount: 1, futureDatedCount: 0 } });
  });
});
