import { hostname } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetBridgeCheck } from '../src/cli/fleet-bridge-check.js';
import type { FleetBridgeCheckDeps } from '../src/mcp/fleet-bridge-check.js';

const now = Date.parse('2026-11-15T12:00:00.000Z');
const claimedAt = '2026-11-15T11:59:00.000Z';
const liveClaim = {
  id: 'fake-claim', repo: 'fake/repo', task: 'fake-task', agent: 'fake-agent', claimedAt,
  expiresAt: '2026-11-15T12:05:00.000Z', expiresInSeconds: 300,
};

function readers(claim: unknown): FleetBridgeCheckDeps {
  return {
    now: () => now,
    runtime: async () => ({ host: 'fake-runtime-420s', stateRoot: '~/fake-runs',
      lastFleetStateRead: { ageSeconds: 5 } }),
    claims: () => ({ state: 'known', claims: [claim] }),
    peers: () => ({ status: 'ok' }),
  };
}

afterEach(() => vi.restoreAllMocks());

describe('fleet bridge CLI claim producer contract (420s)', () => {
  for (const json of [false, true]) {
    it(`reports a complete live claim as READY in ${json ? 'JSON' : 'human'} output`, async () => {
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});
      expect(await cmdFleetBridgeCheck(json ? ['--json'] : [], readers(liveClaim))).toBe(0);
      expect(log).toHaveBeenCalledTimes(1);
      expect(error).not.toHaveBeenCalled();
      const output = String(log.mock.calls[0]?.[0]);
      expect(output).not.toContain(hostname());
      expect(output).not.toContain('fake-claim');
      if (json) {
        expect(JSON.parse(output)).toMatchObject({ verdict: 'READY', missing: [],
          runtime: { host: 'fake-runtime-420s', stateRoot: '~/fake-runs' },
          claims: { status: 'ok', state: 'known', live: 1, newestAgeSec: 60 } });
      } else {
        expect(output).toContain('Bridge: READY');
        expect(output).toContain('host fake-runtime-420s · stateRoot ~/fake-runs');
        expect(output).toContain('claims: 1 live, newest 60s');
      }
    });

    it(`blocks the historical incomplete claim in ${json ? 'JSON' : 'human'} output`, async () => {
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});
      expect(await cmdFleetBridgeCheck(json ? ['--json'] : [], readers({ claimedAt }))).toBe(3);
      expect(log).toHaveBeenCalledTimes(1);
      expect(error).not.toHaveBeenCalled();
      const output = String(log.mock.calls[0]?.[0]);
      expect(output).not.toContain(hostname());
      if (json) {
        expect(JSON.parse(output)).toMatchObject({ verdict: 'BLOCKED', missing: ['claims'],
          runtime: { host: 'fake-runtime-420s', stateRoot: '~/fake-runs' },
          claims: { status: 'unavailable', state: 'unknown', live: null, newestAgeSec: null,
            reason: 'claims-list-unreadable' } });
      } else {
        expect(output).toContain('Bridge: BLOCKED (missing: claims)');
        expect(output).toContain('host fake-runtime-420s · stateRoot ~/fake-runs');
        expect(output).toContain('claims: unknown live, newest unknowns');
      }
    });
  }
});
