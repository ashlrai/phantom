import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChannelHealthReport } from '../src/core/fleet/channel-health.js';
import { cmdFleetChannelHealth } from '../src/cli/fleet-channel-health.js';

vi.mock('../src/core/fleet/channel-health.js', () => ({ readChannelHealth: vi.fn() }));
import { readChannelHealth } from '../src/core/fleet/channel-health.js';

const asOf = '2026-11-12T22:29:00.000Z';
const report: ChannelHealthReport = {
  schemaVersion: 1, asOf, channels: [
    { channel: 'slack', state: 'LIVE', configured: true, processAlive: true, runtimeHost: null,
      lastInboundAt: null, lastReplyAt: null, unansweredCount: 0, asOf, missing: [],
      proof: { requestCoverage: 'verified', futureDatedCount: 0,
        durableIngress: { posted: 1, duplicate: 2, failed: 3, unverified: 4 } } },
    { channel: 'imessage', state: 'DEGRADED', configured: true, processAlive: true, runtimeHost: null,
      lastInboundAt: null, lastReplyAt: null, unansweredCount: 1, asOf, missing: [],
      proof: { requestCoverage: 'unproven', futureDatedCount: 0 } },
  ],
};

afterEach(() => vi.restoreAllMocks());

describe('channel health coverage CLI', () => {
  it('prints coverage and only present ingress counts', async () => {
    vi.mocked(readChannelHealth).mockResolvedValue(report);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await cmdFleetChannelHealth([])).toBe(1);
    expect(log.mock.calls[1]?.[0]).toContain('unanswered=0 coverage=verified ingress=posted:1,dup:2,failed:3,unverified:4');
    expect(log.mock.calls[2]?.[0]).toContain('unanswered=1 coverage=unproven');
    expect(log.mock.calls[2]?.[0]).not.toContain('ingress=');
  });

  it('prints zero ingress counts and idle coverage', async () => {
    const channel = report.channels[0]!;
    vi.mocked(readChannelHealth).mockResolvedValue({ ...report, channels: [{ ...channel,
      proof: { requestCoverage: 'idle', futureDatedCount: 0,
        durableIngress: { posted: 0, duplicate: 0, failed: 0, unverified: 0 } } }] });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await cmdFleetChannelHealth([])).toBe(0);
    expect(log.mock.calls[1]?.[0]).toContain('coverage=idle ingress=posted:0,dup:0,failed:0,unverified:0');
  });

  it('preserves the JSON report exactly', async () => {
    vi.mocked(readChannelHealth).mockResolvedValue(report);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await cmdFleetChannelHealth(['--json'])).toBe(1);
    expect(log).toHaveBeenCalledExactlyOnceWith(JSON.stringify(report));
  });
});
