import { describe, expect, it } from 'vitest';
import { MACHINES_UNAVAILABLE_REASON, readFleetMachines } from '../src/core/web/fleet-machines-route.js';
import type { RuntimeIdentity } from '../src/core/fleet/runtime-identity.js';
import type { TailnetPeers } from '../src/core/fleet/tailnet-peers.js';

const now = () => new Date('2026-01-01T00:00:00.000Z');
const identity: RuntimeIdentity = {
  host: 'mac-a.example', platform: 'darwin', asOf: now().toISOString(),
  installedVersion: '3.30.40', sourceVersion: '3.30.41', versionDrift: true,
  fleetState: { path: '~/.ashlr/state.json', mtime: now().toISOString(), ageSeconds: 42, stale: false },
  tailnetName: 'tail.example', reasons: [],
};
const peers: TailnetPeers = {
  asOf: now().toISOString(), self: 'mac-a.example', reasons: ['one'],
  peers: [
    { name: 'mac-b.example', os: 'macOS', online: true, lastSeen: 'x', ageSeconds: 5 },
    { name: 'mac-c.example', os: 'linux', online: 'unknown', lastSeen: 'unknown', ageSeconds: 'unknown' },
  ],
};

describe('readFleetMachines', () => {
  it('returns the exact shape from the readers', () => {
    expect(readFleetMachines({ now, identity: () => identity, peers: () => peers })).toEqual({
      asOf: '2026-01-01T00:00:00.000Z',
      answering: { host: 'mac-a.example', installedVersion: '3.30.40', sourceVersion: '3.30.41', versionDrift: true, fleetStateAgeSeconds: 42, fleetStateStale: false },
      peers: [
        { name: 'mac-b.example', os: 'macOS', online: true, ageSeconds: 5 },
        { name: 'mac-c.example', os: 'linux', online: 'unknown', ageSeconds: 'unknown' },
      ],
      reasons: ['one'],
    });
  });

  it('gives the unavailable shape with a fixed reason when readers throw', () => {
    const boom = () => { throw new Error('/Users/someone/secret failed'); };
    const out = readFleetMachines({ now, identity: boom, peers: boom });
    expect(out.answering.host).toBe('unknown');
    expect(out.answering.versionDrift).toBe('unknown');
    expect(out.peers).toEqual([]);
    expect(out.reasons).toEqual([MACHINES_UNAVAILABLE_REASON]);
    expect(JSON.stringify(out)).not.toMatch(/\/Users\/|\/home\/|secret/);
  });

  it('keeps peers when only the identity reader throws', () => {
    const out = readFleetMachines({ now, identity: () => { throw new Error('x'); }, peers: () => peers });
    expect(out.peers).toHaveLength(2);
    expect(out.reasons).toContain(MACHINES_UNAVAILABLE_REASON);
  });
});
