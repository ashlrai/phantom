import { afterEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetChannelHealth } from '../src/cli/fleet-channel-health.js';
import { readChannelHealth, type ChannelSource } from '../src/core/fleet/channel-health.js';
import { FLEET_SUBCOMMAND_LOADERS } from '../src/cli/fleet-subcommand-registry.js';

const NOW = new Date('2026-11-13T18:00:00.000Z');
const ago = (min: number): string => new Date(NOW.getTime() - min * 60_000).toISOString();
const src = (over: Partial<ChannelSource> = {}): ChannelSource => ({
  configMissing: () => [], processAlive: () => true, inbound: () => [], replies: () => [], ...over,
});
const run = (slack: ChannelSource, imessage: ChannelSource = src()) =>
  readChannelHealth({ now: () => NOW, host: 'fake-host', sources: { slack, imessage } });

afterEach(() => vi.restoreAllMocks());

describe('channel health', () => {
  it('a later reply cannot clear pending inbound; uncorrelated traffic is not LIVE', async () => {
    const r = await run(src({ inbound: () => [ago(30), ago(20)], replies: () => [ago(19)] }));
    const s = r.channels[0]!;
    expect(s).toMatchObject({ channel: 'slack', state: 'DEGRADED', processAlive: true, runtimeHost: 'fake-host', unansweredCount: 2 });
    expect(s.missing).toContain('slack reply correlation unavailable');
    expect(s.proof).toMatchObject({ requestCoverage: 'unproven', futureDatedCount: 0 });
    expect(s.lastInboundAt).toBe(ago(20));
    expect(s.lastReplyAt).toBe(ago(19));
    expect(s.asOf).toBe(NOW.toISOString());
  });
  it('LIVE inside the 10 minute reply grace; DEGRADED beyond it', async () => {
    expect((await run(src({ inbound: () => [ago(5)] }))).channels[0]).toMatchObject({ state: 'LIVE', unansweredCount: 1 });
    expect((await run(src({ inbound: () => [ago(15)] }))).channels[0]).toMatchObject({ state: 'DEGRADED', unansweredCount: 1 });
  });
  it('ignores inbound older than 60 minutes', async () => {
    expect((await run(src({ inbound: () => [ago(120)] }))).channels[0]).toMatchObject({ state: 'LIVE', unansweredCount: 0 });
  });
  it('BLOCKED names the missing piece for dead process and missing config', async () => {
    const r = await run(src({ configMissing: () => ['slack bot token reference'] }), src({ processAlive: () => false }));
    expect(r.channels[0]).toMatchObject({ state: 'BLOCKED', configured: false, missing: ['slack bot token reference not configured'] });
    expect(r.channels[1]).toMatchObject({ state: 'BLOCKED', configured: true, processAlive: false, missing: ['imessage bridge process not running'] });
  });
  it('UNKNOWN when a source is unreadable or liveness unverifiable', async () => {
    const boom = () => { throw new Error('EACCES /secret/path'); };
    const r = await run(src({ inbound: boom }), src({ processAlive: () => 'unknown' }));
    expect(r.channels[0]).toMatchObject({ state: 'UNKNOWN', missing: ['slack receipt source unreadable'] });
    expect(r.channels[1]).toMatchObject({ state: 'UNKNOWN', processAlive: 'unknown' });
    expect(JSON.stringify(r)).not.toContain('/secret/path');
  });
  it('CLI prints JSON without token-like values and exits 1 when not all LIVE', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const token = 'xoxb-FAKE-0000-fixture';
    const code = await cmdFleetChannelHealth(['--json'], { now: () => NOW, host: 'fake-host', sources: {
      slack: src({ configMissing: () => { throw new Error(token); } }), imessage: src() } });
    const out = String(log.mock.calls[0]?.[0]);
    expect(code).toBe(1);
    expect(JSON.parse(out).channels).toHaveLength(2);
    expect(out).not.toContain(token);
    expect(out).not.toMatch(/xox[bpa]-|xapp-|password/i);
  });
  it('human output lists missing pieces; bad args exit 2; verb is registered', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await cmdFleetChannelHealth([], { now: () => NOW, sources: { slack: src(), imessage: src({ processAlive: () => false }) } });
    expect(log.mock.calls.map(c => c[0]).join('\n')).toContain('missing: imessage bridge process not running');
    expect(await cmdFleetChannelHealth(['--bogus'])).toBe(2);
    expect(FLEET_SUBCOMMAND_LOADERS['channel-health']).toBeTypeOf('function');
  });
});
