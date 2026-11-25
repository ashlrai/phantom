import { describe, expect, it } from 'vitest';
import { readChannelHealth, type ChannelSource, type ReplyBindingEvidence } from '../src/core/fleet/channel-health.js';

const now = new Date('2026-11-13T18:00:00.000Z');
const ago = (minutes: number) => new Date(now.getTime() - minutes * 60_000).toISOString();
const source = (overrides: Partial<ChannelSource> = {}): ChannelSource => ({
  configMissing: () => [], processAlive: () => true, inbound: () => [], replies: () => [], ...overrides,
});
const run = async (binding: ReplyBindingEvidence, inbound: string[] = [], replies: string[] = []) =>
  (await readChannelHealth({ now: () => now, host: 'fake', sources: {
    slack: source({ inbound: () => inbound, replies: () => replies, replyBinding: () => binding }), imessage: source(),
  } })).channels[0]!;
const binding = (answeredAt: string[], unansweredAt: string[]): ReplyBindingEvidence =>
  ({ store: 'ok', answeredAt, unansweredAt, futureDated: 0 });

describe('reply binding time evidence', () => {
  it('retains overdue inbound when an unanswered time is malformed', async () => {
    const result = await run(binding([], ['invalid']), [ago(20)]);
    expect(result).toMatchObject({ state: 'DEGRADED', unansweredCount: 1,
      missing: ['slack reply binding time invalid'], proof: { requestCoverage: 'unproven' } });
    expect(result.proof).not.toHaveProperty('answeredCount');
  });

  it('cannot verify an idle source with a malformed answered time', async () => {
    const result = await run(binding(['invalid'], []));
    expect(result).toMatchObject({ state: 'UNKNOWN', missing: ['slack reply binding time invalid'] });
    expect(result.proof).not.toHaveProperty('answeredCount');
  });

  it('preserves activity and withholds mixed binding evidence without leaking it', async () => {
    const result = await run(binding([ago(5), 'private-sentinel'], [ago(4)]), [ago(5)], [ago(3)]);
    expect(result).toMatchObject({ state: 'UNKNOWN', lastInboundAt: ago(5), lastReplyAt: ago(3),
      unansweredCount: 1, proof: { requestCoverage: 'unproven' } });
    expect(result.missing).toContain('slack reply binding time invalid');
    expect(JSON.stringify(result)).not.toContain('private-sentinel');
    expect(result.proof).not.toHaveProperty('answeredCount');
  });

  it('preserves valid answered and unanswered binding behavior', async () => {
    expect(await run(binding([ago(5)], []), [ago(5)])).toMatchObject({ state: 'LIVE', unansweredCount: 0,
      proof: { requestCoverage: 'verified', answeredCount: 1 } });
    expect(await run(binding([], [ago(20)]), [ago(20)])).toMatchObject({ state: 'DEGRADED', unansweredCount: 1,
      proof: { requestCoverage: 'unproven', answeredCount: 0 } });
  });
});
