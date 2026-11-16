import { afterEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetRuntimeIdentity } from '../src/cli/fleet-runtime-identity.js';
import { readRuntimeIdentity, STALE_AFTER_SECONDS, type RuntimeIdentityDeps } from '../src/core/fleet/runtime-identity.js';

const NOW = Date.parse('2026-01-01T12:00:00.000Z');
const HOME = '/home/fakeuser';
const STATE_PATH = `${HOME}/.ashlr-runs/guardian/state.json`;

function deps(over: Partial<RuntimeIdentityDeps> = {}): RuntimeIdentityDeps {
  return {
    hostname: () => 'fake-host',
    platform: () => 'fakeos',
    now: () => new Date(NOW),
    homeDir: () => HOME,
    statePath: () => STATE_PATH,
    statMtimeMs: () => NOW - 60_000,
    readSourcePackageJson: () => JSON.stringify({ version: '1.2.3' }),
    installedVersion: () => '1.2.3',
    exec: () => JSON.stringify({ Self: { HostName: 'fake-tailnet-node' } }),
    ...over,
  };
}

function capture() {
  const out: string[] = [];
  vi.spyOn(console, 'log').mockImplementation((...a) => { out.push(a.join(' ')); });
  vi.spyOn(console, 'error').mockImplementation(() => {});
  return out;
}

afterEach(() => vi.restoreAllMocks());

describe('readRuntimeIdentity clock-skew proof', () => {
  it('reports a future state mtime as an observation, never as fresh', () => {
    const future = NOW + 5 * 60_000;
    const id = readRuntimeIdentity(deps({ statMtimeMs: () => future }));
    expect(id.fleetState.mtime).toBe(new Date(future).toISOString());
    expect(id.fleetState.ageSeconds).toBe('unknown');
    expect(id.fleetState.stale).toBe('unknown');
    expect(id.reasons.join('\n')).toContain('clock skew');
  });

  it('reports a far-future mtime the same way, not as age 0', () => {
    const id = readRuntimeIdentity(deps({ statMtimeMs: () => NOW + 365 * 24 * 3600_000 }));
    expect(id.fleetState.ageSeconds).toBe('unknown');
    expect(id.fleetState.stale).toBe('unknown');
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 1e20, -1e20])(
    'rejects nonfinite or out-of-range mtime %s without throwing',
    (mtimeMs) => {
      const id = readRuntimeIdentity(deps({ statMtimeMs: () => mtimeMs }));
      expect(id.fleetState).toMatchObject({ mtime: 'unknown', ageSeconds: 'unknown', stale: 'unknown' });
      expect(id.reasons.join('\n')).toContain('fleetState');
    },
  );

  it('reports an unreadable clock as unknown freshness, keeping the mtime observation', () => {
    const id = readRuntimeIdentity(deps({ now: () => new Date(Number.NaN) }));
    expect(id.fleetState.mtime).toBe('2026-01-01T11:59:00.000Z');
    expect(id.fleetState.ageSeconds).toBe('unknown');
    expect(id.fleetState.stale).toBe('unknown');
    expect(id.reasons.join('\n')).toContain('fleetState');
  });

  it('treats an mtime exactly equal to now as age 0, not stale', () => {
    const id = readRuntimeIdentity(deps({ statMtimeMs: () => NOW }));
    expect(id.fleetState).toMatchObject({ ageSeconds: 0, stale: false });
    expect(id.reasons).toEqual([]);
  });

  it('keeps the stale boundary: exactly STALE_AFTER_SECONDS is fresh, one second more is stale', () => {
    const edge = readRuntimeIdentity(deps({ statMtimeMs: () => NOW - STALE_AFTER_SECONDS * 1000 }));
    expect(edge.fleetState).toMatchObject({ ageSeconds: STALE_AFTER_SECONDS, stale: false });
    const over = readRuntimeIdentity(deps({ statMtimeMs: () => NOW - (STALE_AFTER_SECONDS + 1) * 1000 }));
    expect(over.fleetState).toMatchObject({ ageSeconds: STALE_AFTER_SECONDS + 1, stale: true });
  });

  it('still reports an ordinary past mtime with its real age', () => {
    const id = readRuntimeIdentity(deps({ statMtimeMs: () => NOW - 42_000 }));
    expect(id.fleetState).toMatchObject({ mtime: '2026-01-01T11:59:18.000Z', ageSeconds: 42, stale: false });
    expect(id.reasons).toEqual([]);
  });
});

describe('cmdFleetRuntimeIdentity clock-skew output', () => {
  it('prints unknown freshness and the skew reason in --json mode', async () => {
    const out = capture();
    expect(await cmdFleetRuntimeIdentity(['--json'], deps({ statMtimeMs: () => NOW + 60_000 }))).toBe(0);
    const id = JSON.parse(out.join('\n')) as ReturnType<typeof readRuntimeIdentity>;
    expect(id.fleetState.ageSeconds).toBe('unknown');
    expect(id.fleetState.stale).toBe('unknown');
    expect(id.reasons.join('\n')).toContain('clock skew');
    expect(out.join('\n')).not.toContain(HOME);
  });

  it('prints unknown freshness and the skew reason in human mode', async () => {
    const out = capture();
    expect(await cmdFleetRuntimeIdentity([], deps({ statMtimeMs: () => NOW + 60_000 }))).toBe(0);
    const text = out.join('\n');
    expect(text).toContain('fleetState.ageSeconds: unknown');
    expect(text).toContain('fleetState.stale: unknown');
    expect(text).toContain('reason: fleetState');
    expect(text).not.toContain(HOME);
    expect(text).not.toMatch(/\w=\S/);
  });
});
