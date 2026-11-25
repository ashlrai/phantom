import { describe, expect, it } from 'vitest';
import { readChannelHealth, type ChannelSource } from '../src/core/fleet/channel-health.js';

const now = new Date('2026-11-13T18:00:00.000Z');
const ago = (minutes: number) => new Date(now.getTime() - minutes * 60_000).toISOString();
const bad = 'invalid-private-payload';
const source = (over: Partial<ChannelSource> = {}): ChannelSource => ({
  configMissing: () => [], processAlive: () => true, inbound: () => [], replies: () => [], ...over,
});
const run = (slack: ChannelSource, imessage = source()) => readChannelHealth({
  now: () => now, host: 'fake-host', sources: { slack, imessage },
});
const binding = (answeredAt: string[], unansweredAt: string[] = []) => ({
  store: 'ok' as const, answeredAt, unansweredAt, futureDated: 0,
});

describe('invalid inbound timestamp evidence', () => {
  it('marks malformed richer and legacy observations unproven without exposing payloads', async () => {
    for (const slack of [
      source({ inboundEvidence: () => ({ store: 'ok', rows: [{ at: bad, admission: 'failed' }] }) }),
      source({ inbound: () => [bad] }),
    ]) {
      const report = await run(slack);
      expect(report.channels[0]).toMatchObject({ state: 'UNKNOWN', lastInboundAt: null, unansweredCount: 0,
        proof: { requestCoverage: 'unproven', futureDatedCount: 0 }, missing: ['slack invalid inbound timestamp evidence'] });
      expect(JSON.stringify(report)).not.toContain(bad);
    }
  });

  it('retains valid answered and durable evidence without certifying coverage', async () => {
    const report = await run(source({
      inboundEvidence: () => ({ store: 'ok', rows: [{ at: ago(5), admission: 'posted' }, { at: bad }] }),
      replies: () => [ago(4)], replyBinding: () => binding([ago(5)]),
    }));
    expect(report.channels[0]).toMatchObject({ state: 'UNKNOWN', lastInboundAt: ago(5), lastReplyAt: ago(4),
      unansweredCount: 0, proof: { requestCoverage: 'unproven', answeredCount: 1,
        durableIngress: { posted: 1, duplicate: 0, failed: 0, unverified: 0 } } });
  });

  it('preserves known degradation and blocked process', async () => {
    const pending = await run(source({ inbound: () => [ago(20), bad] }));
    expect(pending.channels[0]).toMatchObject({ state: 'DEGRADED', unansweredCount: 1,
      missing: ['slack invalid inbound timestamp evidence'] });
    const failed = await run(source({ inboundEvidence: () => ({ store: 'ok', rows: [
      { at: ago(5), admission: 'failed' }, { at: bad },
    ] }) }));
    expect(failed.channels[0]).toMatchObject({ state: 'DEGRADED', missing: [
      'slack invalid inbound timestamp evidence', 'slack durable ingress failed',
    ] });
    expect((await run(source({ processAlive: () => false, inbound: () => [bad] }))).channels[0]?.state).toBe('BLOCKED');
  });

  it('keeps valid controls and independent channel evidence, then recovers on correction', async () => {
    let rows = [bad];
    const slack = source({ inbound: () => rows });
    const other = source({ inbound: () => [ago(5)] });
    const first = await run(slack, other);
    expect(first.channels[1]).toMatchObject({ state: 'LIVE', lastInboundAt: ago(5), unansweredCount: 1 });
    rows = [ago(120)];
    expect((await run(slack)).channels[0]).toMatchObject({ state: 'LIVE', lastInboundAt: ago(120),
      unansweredCount: 0, proof: { requestCoverage: 'idle' }, missing: [] });
    rows = [];
    expect((await run(slack)).channels[0]).toMatchObject({ state: 'LIVE', proof: { requestCoverage: 'idle' } });
    const future = new Date(now.getTime() + 60_000).toISOString();
    rows = [future];
    expect((await run(slack)).channels[0]).toMatchObject({ state: 'UNKNOWN', proof: { futureDatedCount: 1 } });
  });
});
