import { afterEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetRuntimeIdentity } from '../src/cli/fleet-runtime-identity.js';
import type { RuntimeIdentityDeps } from '../src/core/fleet/runtime-identity.js';

const HOME = '/synthetic/home/example';
const IP = '192.0.2.17';
const FAILURE = `synthetic reader failure at ${HOME} ${IP}`;

function fixture(installed: string | null) {
  const calls: string[] = [];
  const record = <T>(name: string, value: T): T => { calls.push(name); return value; };
  const fail = (name: string): never => { calls.push(name); throw new Error(FAILURE); };
  const exec = vi.fn((cmd: string, args: readonly string[]) => {
    calls.push('exec');
    expect([cmd, args]).toEqual(['tailscale', ['status', '--json']]);
    throw new Error(FAILURE);
  });
  const deps: RuntimeIdentityDeps = {
    hostname: () => record('hostname', `synthetic-${IP}`),
    platform: () => record('platform', 'synthetic-os'),
    now: () => record('now', new Date('2026-11-13T18:13:00Z')),
    homeDir: () => record('homeDir', HOME),
    statePath: () => record('statePath', `${HOME}/state-${IP}.json`),
    statMtimeMs: () => fail('statMtimeMs'),
    readSourcePackageJson: () => record('readSourcePackageJson', JSON.stringify({ version: '2.0.0' })),
    installedVersion: () => record('installedVersion', installed),
    exec,
  };
  return { deps, calls, exec };
}

afterEach(() => vi.restoreAllMocks());

describe('runtime identity CLI output qualification', () => {
  it.each([['text', []], ['json', ['--json']]] as const)('renders drift and failed reads safely in %s', async (mode, args) => {
    const { deps, exec } = fixture('1.0.0');
    const out = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await cmdFleetRuntimeIdentity([...args], deps)).toBe(0);
    const output = String(out.mock.calls[0]?.[0]);
    expect(output).not.toContain(HOME);
    expect(output).not.toContain(IP);
    expect(output).not.toContain('synthetic reader failure');
    expect(output).toContain('synthetic-[ip]');
    expect(output).toContain('~/state-[ip].json');
    expect(output).toContain('fleetState: state file missing or unreadable');
    expect(output).toContain('tailnetName: tailscale unavailable or status unreadable');
    if (mode === 'json') {
      expect(JSON.parse(output)).toMatchObject({ installedVersion: '1.0.0', sourceVersion: '2.0.0', versionDrift: true, tailnetName: 'unknown', fleetState: { mtime: 'unknown', stale: 'unknown' } });
    } else {
      expect(output).toContain('installedVersion: 1.0.0');
      expect(output).toContain('sourceVersion: 2.0.0');
      expect(output).toContain('versionDrift: true');
      expect(output).toContain('tailnetName: unknown');
      expect(output).toContain('fleetState.mtime: unknown');
    }
    expect(exec).toHaveBeenCalledOnce();
    expect(exec).toHaveBeenCalledWith('tailscale', ['status', '--json']);
  });

  it.each([['text', []], ['json', ['--json']]] as const)('does not invent drift for an unavailable installed version in %s', async (mode, args) => {
    const { deps } = fixture(null);
    const out = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await cmdFleetRuntimeIdentity([...args], deps)).toBe(0);
    const output = String(out.mock.calls[0]?.[0]);
    expect(output).toContain('installedVersion: no installed app bundle version readable');
    if (mode === 'json') expect(JSON.parse(output)).toMatchObject({ installedVersion: 'unknown', sourceVersion: '2.0.0', versionDrift: false });
    else {
      expect(output).toContain('installedVersion: unknown');
      expect(output).toContain('sourceVersion: 2.0.0');
      expect(output).toContain('versionDrift: false');
    }
  });

  it.each([['--help', 0], ['-h', 0], ['--invalid', 2]] as const)('%s does not read dependencies', async (flag, code) => {
    const { deps, calls } = fixture('1.0.0');
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await cmdFleetRuntimeIdentity([flag], deps)).toBe(code);
    expect(calls).toEqual([]);
  });
});
