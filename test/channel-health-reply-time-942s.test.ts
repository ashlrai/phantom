import { describe, expect, it } from 'vitest';
import { readChannelHealth, type ChannelSource } from '../src/core/fleet/channel-health.js';

const now = new Date('2026-11-13T18:00:00.000Z');
const old = '2026-11-13T16:00:00.000Z';
const recent = '2026-11-13T17:50:00.000Z';
const future = '2026-11-13T18:01:00.000Z';
const sentinel = 'fake-malformed-reply-sentinel';
const source = (over: Partial<ChannelSource> = {}): ChannelSource => ({
  configMissing: () => [], processAlive: () => true, inbound: () => [], replies: () => [], ...over,
});
const run = (over: Partial<ChannelSource>) => readChannelHealth({
  now: () => now, host: 'test', sources: { slack: source(over), imessage: source(over) },
});

describe('malformed channel reply timestamps', () => {
  it('reports unknown without exposing malformed observations', async () => {
    const report = await run({ replies: () => ['bad-time', sentinel] });
    for (const channel of report.channels) {
      expect(channel).toMatchObject({ state: 'UNKNOWN', lastReplyAt: null, proof: { requestCoverage: 'idle' } });
      expect(channel.missing).toContain(`${channel.channel} reply evidence time invalid`);
    }
    expect(JSON.stringify(report)).not.toContain(sentinel);
  });
  it('retains valid activity and the diagnostic without inferring correlation', async () => {
    const report = await run({ inbound: () => [recent], replies: () => [old, recent, sentinel] });
    for (const channel of report.channels) {
      expect(channel).toMatchObject({ state: 'UNKNOWN', lastReplyAt: recent, proof: { requestCoverage: 'unproven' } });
      expect(channel.missing).toContain(`${channel.channel} reply evidence time invalid`);
    }
  });
  it('keeps positive failure precedence and the diagnostic', async () => {
    const report = await run({ inbound: () => ['2026-11-13T17:30:00.000Z'], replies: () => [sentinel] });
    for (const channel of report.channels) {
      expect(channel.state).toBe('DEGRADED');
      expect(channel.missing).toContain(`${channel.channel} reply evidence time invalid`);
    }
  });
  it('preserves valid old and future timestamp behavior', async () => {
    const idle = await run({ replies: () => [old] });
    const dated = await run({ replies: () => [old, future] });
    for (const channel of idle.channels) expect(channel).toMatchObject({ state: 'LIVE', lastReplyAt: old });
    for (const channel of dated.channels) {
      expect(channel).toMatchObject({ state: 'UNKNOWN', lastReplyAt: old });
      expect(channel.missing).toContain(`${channel.channel} future-dated receipt ignored`);
    }
  });
});
