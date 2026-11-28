import { describe, expect, it } from 'vitest';
import { formatRuntimeLine, RUNTIME_LINE_MAX_CHARS } from '../src/core/agents/owner-status-runtime-line.js';
import { readRuntimeIdentity, type RuntimeIdentityDeps } from '../src/core/fleet/runtime-identity.js';

const now = new Date('2026-11-13T20:27:00.000Z');
const deps: RuntimeIdentityDeps = {
  hostname: () => 'test-host', platform: () => 'test', now: () => now,
  homeDir: () => '/synthetic', statePath: () => '/synthetic/state',
  statMtimeMs: () => now.getTime() + 1_000,
  readSourcePackageJson: () => '{"version":"1.0.0"}',
  installedVersion: () => '1.0.0', exec: () => '{"Self":{"HostName":"test"}}',
};

const identity = () => readRuntimeIdentity(deps);
const line = (state: ReturnType<typeof identity>['fleetState'], clock = now) =>
  formatRuntimeLine({ ...identity(), fleetState: state }, null, clock);

describe('owner runtime clock truth', () => {
  it('preserves the reader’s unknown freshness for a future mtime, even with a conflicting fallback', () => {
    const report = identity();
    expect(report.fleetState.ageSeconds).toBe('unknown');
    expect(report.fleetState.stale).toBe('unknown');
    expect(formatRuntimeLine(report, null, now)).toContain('fleet state unknown');
    expect(line({ ...report.fleetState, ageSeconds: 0 })).toContain('fleet state unknown');
  });

  it('rejects an invalid reply clock for both mtime and fallback', () => {
    const invalid = new Date(NaN);
    for (const mtime of [now.toISOString(), 'unknown']) {
      expect(line({ ...identity().fleetState, mtime, ageSeconds: 0 }, invalid)).toContain('fleet state unknown');
    }
  });

  it.each([NaN, Infinity, -Infinity, -1])('rejects invalid fallback age %s', ageSeconds => {
    expect(line({ ...identity().fleetState, mtime: 'unknown', ageSeconds })).toContain('fleet state unknown');
  });

  it('uses the reply clock for normal and stale timestamps and accepts a valid fallback', () => {
    const state = identity().fleetState;
    expect(line({ ...state, mtime: new Date(now.getTime() - 45_000).toISOString(), ageSeconds: 999 })).toContain('fleet state 45s old');
    expect(line({ ...state, mtime: new Date(now.getTime() - 901_000).toISOString() })).toContain('fleet state 15m old (stale)');
    expect(line({ ...state, mtime: 'unknown', ageSeconds: 300 })).toContain('fleet state 5m old');
    expect(line({ ...state, mtime: 'unknown', ageSeconds: 0 })).toContain('fleet state 0s old');
  });

  it('keeps the owner-facing line within its cap', () => {
    const report = identity();
    report.host = 'x'.repeat(400);
    const result = formatRuntimeLine(report, null, now);
    expect(result).toHaveLength(RUNTIME_LINE_MAX_CHARS);
    expect(result.endsWith('…')).toBe(true);
  });
});
