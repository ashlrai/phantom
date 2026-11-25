import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChannelHealthReport } from '../src/core/fleet/channel-health.js';
import { cmdFleetChannelHealth } from '../src/cli/fleet-channel-health.js';

vi.mock('../src/core/fleet/channel-health.js', () => ({ readChannelHealth: vi.fn() }));
import { readChannelHealth } from '../src/core/fleet/channel-health.js';

const asOf = '2026-11-12T22:29:00.000Z';
const report: ChannelHealthReport = { schemaVersion: 1, asOf, channels: [{
  channel: 'slack', state: 'LIVE', configured: true, processAlive: true, runtimeHost: 'fake-host',
  lastInboundAt: null, lastReplyAt: null, unansweredCount: 0, asOf, missing: [],
  proof: { requestCoverage: 'idle', futureDatedCount: 0 },
}] };

afterEach(() => vi.restoreAllMocks());

describe('channel health proof CLI', () => {
  it('explains idle LIVE health and distinguishes zero from unknown', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.mocked(readChannelHealth).mockResolvedValue(report);
    expect(await cmdFleetChannelHealth([])).toBe(0);
    expect(log.mock.calls[1]?.[0]).toContain('coverage=idle answered=unknown futureDatedExcluded=0');
    expect(log.mock.calls[2]?.[0]).toContain('No request round trip was verified');
    vi.mocked(readChannelHealth).mockResolvedValue({ ...report, channels: [{ ...report.channels[0]!,
      proof: { requestCoverage: 'idle', answeredCount: 0, futureDatedCount: 0 } }] });
    log.mockClear();
    expect(await cmdFleetChannelHealth([])).toBe(0);
    expect(log.mock.calls[1]?.[0]).toContain('answered=0');
  });

  it('prints verified replies and excluded future observations', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.mocked(readChannelHealth).mockResolvedValue({ ...report, channels: [{ ...report.channels[0]!,
      proof: { requestCoverage: 'verified', answeredCount: 2, futureDatedCount: 3 } }] });
    expect(await cmdFleetChannelHealth([])).toBe(0);
    expect(log.mock.calls[1]?.[0]).toContain('coverage=verified answered=2 futureDatedExcluded=3');
  });

  it('preserves JSON and degraded exit status', async () => {
    const degraded: ChannelHealthReport = { ...report, channels: [{ ...report.channels[0]!, state: 'DEGRADED' }] };
    vi.mocked(readChannelHealth).mockResolvedValue(degraded);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await cmdFleetChannelHealth(['--json'])).toBe(1);
    expect(log).toHaveBeenCalledExactlyOnceWith(JSON.stringify(degraded));
  });

  it('documents the health exit contract without reading or sending', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.mocked(readChannelHealth).mockClear();
    expect(await cmdFleetChannelHealth(['--help'])).toBe(0);
    expect(log.mock.calls[0]?.[0]).toContain('Exit 0 means channel health is LIVE');
    expect(log.mock.calls[0]?.[0]).toContain('does not itself prove task assignment, execution, or a request round trip');
    expect(readChannelHealth).not.toHaveBeenCalled();
  });

  it('contains no send, process, or write operation', () => {
    const source = readFileSync(new URL('../src/cli/fleet-channel-health.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/\b(?:execFile|spawn|exec|fork|writeFile|appendFile|send)\s*\(/);
    expect(source.match(/^import .*$/gm)).toHaveLength(1);
  });

  it('only invokes the injected reader for a health request', async () => {
    const deps = { host: 'fake-host' };
    vi.mocked(readChannelHealth).mockResolvedValue(report);
    vi.mocked(readChannelHealth).mockClear();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await cmdFleetChannelHealth([], deps)).toBe(0);
    expect(readChannelHealth).toHaveBeenCalledExactlyOnceWith(deps);
  });
});
