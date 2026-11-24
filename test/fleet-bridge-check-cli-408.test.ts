import { afterEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetBridgeCheck } from '../src/cli/fleet-bridge-check.js';
import { FLEET_SUBCOMMAND_LOADERS } from '../src/cli/fleet-subcommand-registry.js';
import { resolveFleetSubcommand } from '../src/cli/fleet-subcommand-resolve.js';
import type { FleetBridgeCheckDeps } from '../src/mcp/fleet-bridge-check.js';

const NOW = Date.parse('2026-11-15T00:00:00.000Z');
const AS_OF = '2026-11-15T00:00:00.000Z';

function fixture(overrides: FleetBridgeCheckDeps = {}): FleetBridgeCheckDeps {
  return {
    runtime: async () => ({ lastFleetStateRead: { ageSeconds: 30 } }),
    claims: () => ({ state: 'known', claims: [{
      id: 'claim-fake-1', repo: 'ashlrai/phantom', task: 'fake task', agent: 'fake-agent',
      claimedAt: '2026-11-14T23:59:00.000Z', expiresAt: '2026-11-15T00:01:00.000Z', expiresInSeconds: 120,
    }] }),
    peers: () => ({ status: 'ok' }),
    now: () => NOW,
    ...overrides,
  };
}

function capture() {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  return { log, error, text: () => log.mock.calls.flat().join('\n') };
}

afterEach(() => vi.restoreAllMocks());

describe('fleet bridge-check CLI', () => {
  it('prints six READY lines and exits 0', async () => {
    const output = capture();
    expect(await cmdFleetBridgeCheck([], fixture())).toBe(0);
    expect(output.text().split('\n')).toEqual([
      'Bridge: READY',
      `as of ${AS_OF}`,
      'runtime: ok',
      'claims: 1 live, newest 60s',
      'peers: ok',
      'Reachability only; grants no claim, dispatch or merge authority.',
    ]);
    expect(output.error).not.toHaveBeenCalled();
  });

  it('names stale fleet state and exits 3', async () => {
    const output = capture();
    expect(await cmdFleetBridgeCheck([], fixture({
      runtime: async () => ({ lastFleetStateRead: { ageSeconds: 2000 } }),
    }))).toBe(3);
    expect(output.text()).toContain('Bridge: BLOCKED (missing: runtime.fleet-state-stale)');
    expect(output.text()).toContain('runtime: ok (fleet-state-stale)');
  });

  it('reports unknown claims without exposing reader exceptions', async () => {
    const output = capture();
    expect(await cmdFleetBridgeCheck([], fixture({
      claims: () => { throw new Error('private-reader-detail'); },
    }))).toBe(3);
    expect(output.text()).toContain('Bridge: BLOCKED (missing: claims)');
    expect(output.text()).toContain('claims: unknown live, newest unknowns');
    expect(output.text()).not.toContain('private-reader-detail');
  });

  it.each([false, true])('prints one JSON line for blocked=%s', async (blocked) => {
    const output = capture();
    expect(await cmdFleetBridgeCheck(['--json'], fixture({
      peers: () => ({ status: blocked ? 'unavailable' : 'ok' }),
    }))).toBe(blocked ? 3 : 0);
    expect(output.log).toHaveBeenCalledTimes(1);
    expect(output.text().split('\n')).toHaveLength(1);
    expect(JSON.parse(output.text())).toMatchObject({ verdict: blocked ? 'BLOCKED' : 'READY', asOf: AS_OF });
  });

  it.each([['--bogus'], ['--json', '--json'], ['--help', '--bogus']])('rejects bad arguments %j before reading', async (...args) => {
    const output = capture();
    const runtime = vi.fn();
    expect(await cmdFleetBridgeCheck(args, fixture({ runtime }))).toBe(2);
    expect(output.error).toHaveBeenCalledWith(expect.stringContaining('Usage: ashlr fleet bridge-check'));
    expect(runtime).not.toHaveBeenCalled();
  });

  it.each(['--help', '-h'])('prints help for %s without reading', async (arg) => {
    const output = capture();
    const runtime = vi.fn();
    expect(await cmdFleetBridgeCheck([arg], fixture({ runtime }))).toBe(0);
    expect(output.text()).toContain('Exit codes: 0 READY/help, 3 BLOCKED, 2 bad arguments.');
    expect(runtime).not.toHaveBeenCalled();
  });

  it('fails closed when the aggregate reader throws, without exposing the exception', async () => {
    const output = capture();
    expect(await cmdFleetBridgeCheck([], fixture({ now: () => Number.NaN }))).toBe(3);
    expect(output.error).toHaveBeenCalledExactlyOnceWith('Bridge: BLOCKED (missing: bridge-check)');
    expect(output.log).not.toHaveBeenCalled();
  });

  it('loads and resolves the conventional handler through the fleet registry', async () => {
    expect((await FLEET_SUBCOMMAND_LOADERS['bridge-check']!()).cmdFleetBridgeCheck).toBe(cmdFleetBridgeCheck);
    expect(resolveFleetSubcommand('bridge-check')).toEqual({
      module: './fleet-bridge-check.js', exportName: 'cmdFleetBridgeCheck',
    });
  });
});
