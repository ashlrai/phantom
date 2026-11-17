import { describe, expect, it, vi } from 'vitest';
import { readRuntimeIdentity, type RuntimeIdentityDeps } from '../src/core/fleet/runtime-identity.js';

const HOME = '/synthetic/home';
const A = `${HOME}/state-a.json`;
const B = `${HOME}/state-b.json`;
const NOW = Date.parse('2026-01-01T12:00:00.000Z');

function deps(over: Partial<RuntimeIdentityDeps> = {}): RuntimeIdentityDeps {
  return {
    hostname: () => 'host', platform: () => 'test', now: () => new Date(NOW),
    homeDir: () => HOME, statePath: () => A, statMtimeMs: () => NOW - 60_000,
    readSourcePackageJson: () => '{"version":"1"}', installedVersion: () => '1',
    exec: () => '{"Self":{"HostName":"tailnet"}}', ...over,
  };
}

describe('runtime identity state path binding', () => {
  it('reports and stats the same raw path when the resolver changes', () => {
    const statePath = vi.fn().mockReturnValueOnce(A).mockReturnValueOnce(B);
    const statMtimeMs = vi.fn((path: string) => path === A ? NOW - 60_000 : NOW - 120_000);
    const id = readRuntimeIdentity(deps({ statePath, statMtimeMs }));
    expect(statePath).toHaveBeenCalledTimes(1);
    expect(statMtimeMs).toHaveBeenCalledOnce();
    expect(statMtimeMs).toHaveBeenCalledWith(A);
    expect(id.fleetState).toEqual({ path: '~/state-a.json', mtime: '2026-01-01T11:59:00.000Z', ageSeconds: 60, stale: false });
  });

  it('does not retry a failed resolution or stat an alternate path', () => {
    const statePath = vi.fn().mockImplementationOnce(() => { throw new Error('unavailable'); }).mockReturnValueOnce(B);
    const statMtimeMs = vi.fn(() => NOW);
    const id = readRuntimeIdentity(deps({ statePath, statMtimeMs }));
    expect(statePath).toHaveBeenCalledTimes(1);
    expect(statMtimeMs).not.toHaveBeenCalled();
    expect(id.fleetState).toEqual({ path: 'unknown', mtime: 'unknown', ageSeconds: 'unknown', stale: 'unknown' });
    expect(id.reasons).toContain('fleetState: state file missing or unreadable');
  });

  it('handles a stable path and leaves a failed stat unknown', () => {
    const statMtimeMs = vi.fn(() => NOW - 60_000);
    expect(readRuntimeIdentity(deps({ statMtimeMs })).fleetState.stale).toBe(false);
    expect(statMtimeMs).toHaveBeenCalledWith(A);
    const failed = readRuntimeIdentity(deps({ statMtimeMs: () => { throw new Error('missing'); } }));
    expect(failed.fleetState).toEqual({ path: '~/state-a.json', mtime: 'unknown', ageSeconds: 'unknown', stale: 'unknown' });
    expect(failed.reasons).toContain('fleetState: state file missing or unreadable');
  });

  it('does not stat an unusable path', () => {
    const statMtimeMs = vi.fn(() => NOW);
    const id = readRuntimeIdentity(deps({ statePath: () => '  ', statMtimeMs }));
    expect(statMtimeMs).not.toHaveBeenCalled();
    expect(id.fleetState.stale).toBe('unknown');
    expect(id.reasons).toContain('fleetState: state file missing or unreadable');
  });
});
