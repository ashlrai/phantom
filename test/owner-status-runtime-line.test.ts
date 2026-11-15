import { describe, expect, it } from 'vitest';
import { formatRuntimeLine, RUNTIME_LINE_MAX_CHARS } from '../src/core/agents/owner-status-runtime-line.js';
import type { ChannelHealth, ChannelHealthReport } from '../src/core/fleet/channel-health.js';
import type { FleetStateIdentity, RuntimeIdentity } from '../src/core/fleet/runtime-identity.js';

const NOW = new Date('2026-11-13T20:27:00.000Z'); // 15:27 ET
const minutesAgo = (m: number): string => new Date(NOW.getTime() - m * 60_000).toISOString();

const fleetState = (over: Partial<FleetStateIdentity> = {}): FleetStateIdentity =>
  ({ path: '~/.ashlr-runs/guardian/state.json', mtime: minutesAgo(2), ageSeconds: 120, stale: false, ...over });

const identity = (over: Partial<RuntimeIdentity> = {}): RuntimeIdentity => ({
  host: 'MacBook-Pro', platform: 'darwin', asOf: NOW.toISOString(),
  installedVersion: '3.31.2', sourceVersion: '3.31.2', versionDrift: false,
  fleetState: fleetState(), tailnetName: 'mbp', reasons: [], ...over,
});

const channel = (over: Partial<ChannelHealth> = {}): ChannelHealth => ({
  channel: 'slack', configured: true, processAlive: true, runtimeHost: 'MacBook-Pro',
  lastInboundAt: null, lastReplyAt: null, unansweredCount: 0, state: 'LIVE', missing: [], asOf: NOW.toISOString(), ...over,
});

const health = (channels: ChannelHealth[]): ChannelHealthReport => ({ schemaVersion: 1, asOf: NOW.toISOString(), channels });

describe('formatRuntimeLine', () => {
  it('prints host, versions, fleet age and both channel states', () => {
    const line = formatRuntimeLine(
      identity({ installedVersion: '3.31.2', sourceVersion: '3.31.4', versionDrift: true }),
      health([channel(), channel({ channel: 'imessage', state: 'BLOCKED', missing: ['imessage bridge process not running'] })]),
      NOW,
    );
    expect(line).toBe('Runtime: MacBook-Pro (3.31.2, source 3.31.4 drift), fleet state 2m old · Slack LIVE · iMessage BLOCKED (missing: bridge process)');
  });

  it('prints unknown pieces for a null identity', () => {
    const line = formatRuntimeLine(null, health([channel()]), NOW);
    expect(line).toBe('Runtime: unknown (unknown, source unknown), fleet state unknown · Slack LIVE · iMessage unknown');
  });

  it('prints unknown channels for a null health report and no drift flag', () => {
    const line = formatRuntimeLine(identity(), null, NOW);
    expect(line).toBe('Runtime: MacBook-Pro (3.31.2, source 3.31.2), fleet state 2m old · Slack unknown · iMessage unknown');
  });

  it('prints drift only when the identity says so', () => {
    expect(formatRuntimeLine(identity({ versionDrift: false, sourceVersion: '9.9.9' }), null, NOW)).toContain('(3.31.2, source 9.9.9),');
    expect(formatRuntimeLine(identity({ versionDrift: true }), null, NOW)).toContain('(3.31.2, source 3.31.2 drift)');
  });

  it('marks a fleet-state read older than 15 minutes stale', () => {
    const line = formatRuntimeLine(identity({ fleetState: fleetState({ mtime: minutesAgo(20), ageSeconds: 1200, stale: true }) }), null, NOW);
    expect(line).toContain('fleet state 20m old (stale)');
  });

  it('measures age against the reply clock, falls back to ageSeconds, then unknown', () => {
    expect(formatRuntimeLine(identity({ fleetState: fleetState({ mtime: minutesAgo(0.75), ageSeconds: 45 }) }), null, NOW)).toContain('fleet state 45s old');
    expect(formatRuntimeLine(identity({ fleetState: fleetState({ mtime: 'unknown', ageSeconds: 300 }) }), null, NOW)).toContain('fleet state 5m old');
    expect(formatRuntimeLine(identity({ fleetState: fleetState({ mtime: 'unknown', ageSeconds: 'unknown', stale: 'unknown' }) }), null, NOW)).toContain('fleet state unknown');
  });

  it('redacts IPv4 and any /Users path from every interpolated piece', () => {
    const line = formatRuntimeLine(
      identity({ host: 'box-10.1.2.3' }),
      health([channel({ missing: ['slack config /Users/syntheticowner/.ashlr 10.1.2.3 not configured'] })]),
      NOW,
    );
    expect(line).toContain('box-[ip]');
    expect(line).toContain('(missing: config ~/.ashlr [ip])');
    expect(line).not.toContain('10.1.2.3');
    expect(line).not.toContain('syntheticowner');
    expect(line).not.toContain('/Users/');
  });

  it('caps the line at 240 chars', () => {
    const line = formatRuntimeLine(identity({ host: 'h'.repeat(400) }), null, NOW);
    expect(line).toHaveLength(RUNTIME_LINE_MAX_CHARS);
    expect(RUNTIME_LINE_MAX_CHARS).toBe(240);
    expect(line.endsWith('…')).toBe(true);
  });
});
