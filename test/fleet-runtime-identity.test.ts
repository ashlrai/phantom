import { afterEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetRuntimeIdentity } from '../src/cli/fleet-runtime-identity.js';
import { FLEET_SUBCOMMAND_LOADERS } from '../src/cli/fleet-subcommand-registry.js';
import { readRuntimeIdentity, type RuntimeIdentityDeps } from '../src/core/fleet/runtime-identity.js';

const NOW = Date.parse('2026-01-01T12:00:00.000Z');
const HOME = '/home/fakeuser';

function deps(over: Partial<RuntimeIdentityDeps> = {}): RuntimeIdentityDeps {
  return {
    hostname: () => 'fake-host',
    platform: () => 'fakeos',
    now: () => new Date(NOW),
    homeDir: () => HOME,
    statePath: () => `${HOME}/.ashlr-runs/guardian/state.json`,
    statMtimeMs: () => NOW - 60_000,
    readSourcePackageJson: () => JSON.stringify({ version: '1.2.3' }),
    installedVersion: () => '1.2.3',
    exec: () => JSON.stringify({ Self: { HostName: 'fake-tailnet-node' } }),
    ...over,
  };
}

afterEach(() => vi.restoreAllMocks());

describe('readRuntimeIdentity', () => {
  it('reports a fresh state read with every field known', () => {
    const id = readRuntimeIdentity(deps());
    expect(id).toMatchObject({
      host: 'fake-host', platform: 'fakeos', asOf: '2026-01-01T12:00:00.000Z',
      installedVersion: '1.2.3', sourceVersion: '1.2.3', versionDrift: false,
      tailnetName: 'fake-tailnet-node', reasons: [],
    });
    expect(id.fleetState).toEqual({
      path: '~/.ashlr-runs/guardian/state.json', mtime: '2026-01-01T11:59:00.000Z', ageSeconds: 60, stale: false,
    });
  });

  it('marks state older than 15 minutes stale', () => {
    const id = readRuntimeIdentity(deps({ statMtimeMs: () => NOW - 16 * 60_000 }));
    expect(id.fleetState.ageSeconds).toBe(960);
    expect(id.fleetState.stale).toBe(true);
  });

  it('reports unknown with a reason when the state file is missing', () => {
    const id = readRuntimeIdentity(deps({ statMtimeMs: () => { throw new Error('ENOENT'); } }));
    expect(id.fleetState).toMatchObject({ mtime: 'unknown', ageSeconds: 'unknown', stale: 'unknown' });
    expect(id.reasons.join('\n')).toContain('fleetState');
  });

  it('reports unknown plus a reason when tailscale is missing', () => {
    const id = readRuntimeIdentity(deps({ exec: () => { throw new Error('ENOENT'); } }));
    expect(id.tailnetName).toBe('unknown');
    expect(id.reasons.join('\n')).toContain('tailnetName');
  });

  it('flags version drift, and never claims drift from an unknown side', () => {
    expect(readRuntimeIdentity(deps({ installedVersion: () => '1.2.0' })).versionDrift).toBe(true);
    const unknown = readRuntimeIdentity(deps({ installedVersion: () => null }));
    expect(unknown.installedVersion).toBe('unknown');
    expect(unknown.versionDrift).toBe(false);
    expect(unknown.reasons.join('\n')).toContain('installedVersion');
  });

  it('only ever runs tailscale status --json', () => {
    const exec = vi.fn(() => '{}');
    readRuntimeIdentity(deps({ exec }));
    expect(exec).toHaveBeenCalledTimes(1);
    expect(exec).toHaveBeenCalledWith('tailscale', ['status', '--json']);
  });

  it('redacts the home path and IP addresses everywhere', () => {
    const id = readRuntimeIdentity(deps({
      hostname: () => `${HOME}-box`,
      exec: () => JSON.stringify({ Self: { HostName: 'node-10.1.2.3' } }),
    }));
    const text = JSON.stringify(id);
    expect(text).not.toContain(HOME);
    expect(text).not.toContain('10.1.2.3');
    expect(text).not.toMatch(/\w=\S/);
  });
});

describe('cmdFleetRuntimeIdentity', () => {
  function capture() {
    const out: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...a) => { out.push(a.join(' ')); });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    return out;
  }

  it('prints --json that parses and leaks no home path or env-style secret', async () => {
    const out = capture();
    expect(await cmdFleetRuntimeIdentity(['--json'], deps())).toBe(0);
    const text = out.join('\n');
    expect(JSON.parse(text).host).toBe('fake-host');
    expect(text).not.toContain(HOME);
    expect(text).not.toMatch(/\w=\S/);
  });

  it('prints one line per field in human mode', async () => {
    const out = capture();
    expect(await cmdFleetRuntimeIdentity([], deps({ exec: () => { throw new Error('x'); } }))).toBe(0);
    const text = out.join('\n');
    expect(text).toContain('host: fake-host');
    expect(text).toContain('fleetState.stale: false');
    expect(text).toContain('tailnetName: unknown');
    expect(text).toContain('reason: tailnetName');
    expect(text).not.toContain(HOME);
    expect(text).not.toMatch(/\w=\S/);
  });

  it('rejects unknown flags with exit 2', async () => {
    capture();
    expect(await cmdFleetRuntimeIdentity(['--set'], deps())).toBe(2);
  });

  it('is registered for dispatch without editing fleet.ts', async () => {
    const mod = await FLEET_SUBCOMMAND_LOADERS['runtime-identity']!();
    expect(mod.cmdFleetRuntimeIdentity).toBe(cmdFleetRuntimeIdentity);
  });
});
