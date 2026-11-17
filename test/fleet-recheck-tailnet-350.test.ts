/** RQ-PHX-RECHECKTAILNET350 — tailnet peer evidence on the fleet recheck
 * verdict. Evidence only: it never changes a state, overall or missing[].
 * Every reader is faked; nothing touches real tailscale, home or network. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFleetRecheck, type FleetRecheckDeps } from '../src/core/fleet/fleet-recheck.js';
import type { TailnetPeers } from '../src/core/fleet/tailnet-peers.js';
import type { RuntimeIdentity } from '../src/core/fleet/runtime-identity.js';

const NOW = new Date('2026-11-13T13:13:00.000Z');
const ISO = NOW.toISOString();

const runtime: RuntimeIdentity = {
  host: 'fake-host', platform: 'fakeos', asOf: ISO,
  installedVersion: '1.2.3', sourceVersion: '1.2.3', versionDrift: false,
  fleetState: { path: '~/.ashlr-runs/guardian/state.json', mtime: ISO, ageSeconds: 60, stale: false },
  tailnetName: 'fake-tailnet-node', reasons: [],
};

function peer(name: string, online: boolean | 'unknown', ageSeconds: number | 'unknown' = 5) {
  return { name, os: 'fakeos', online, lastSeen: ISO, ageSeconds };
}
function tailnet(peers: TailnetPeers['peers'], reasons: string[] = []): TailnetPeers {
  return { asOf: ISO, self: 'fake-self', peers, reasons };
}

function deps(readTailnetPeers: FleetRecheckDeps['readTailnetPeers']): FleetRecheckDeps {
  return {
    now: () => NOW,
    homeDir: () => '/home/fakeuser',
    readRuntimeIdentity: () => runtime,
    readFleetBoard: () => ({ schema: 'fleet.coordination.v1', state: 'known', claims: [], messages: [], proposals: [], expiredClaims: 0 }),
    readChannelHealth: () => ({ schemaVersion: 1, asOf: ISO, channels: [] }),
    listWorkBoard: () => ({ items: [], inbox: 'ok', truncated: false }) as never,
    listCoordination: () => ({ source: 'unavailable', claims: [] }) as never,
    listLiveWorkers: () => ({ workers: [], state: 'unknown' }) as never,
    readTailnetPeers,
  };
}

function core(v: Awaited<ReturnType<typeof readFleetRecheck>>) {
  return {
    overall: v.overall,
    states: Object.values(v.sections).map(s => s.state),
    task: v.sections.task,
  };
}

afterEach(() => vi.useRealTimers());

describe('fleet recheck tailnet evidence', () => {
  it('counts peers and lists online first', async () => {
    const v = await readFleetRecheck(deps(() => tailnet([peer('b', false), peer('a', true), peer('c', true)])));
    expect(v.schema).toBe('fleet.recheck.v1');
    expect(v.tailnet).toMatchObject({ source: 'tailscale-status', self: 'fake-self', online: 2, offline: 1, unknown: 0, reasons: [] });
    expect(v.tailnet!.peers.map(p => p.name)).toEqual(['a', 'c', 'b']);
  });

  it('caps listed peers at 8 but counts all', async () => {
    const peers = Array.from({ length: 12 }, (_, i) => peer(`n${i}`, i % 2 === 0));
    const v = await readFleetRecheck(deps(() => tailnet(peers)));
    expect(v.tailnet!.peers).toHaveLength(8);
    expect(v.tailnet!.online + v.tailnet!.offline).toBe(12);
    expect(v.tailnet!.peers.slice(0, 6).every(p => p.online === true)).toBe(true);
    expect(v.tailnet!.peers.slice(6).every(p => p.online === false)).toBe(true);
  });

  it('sanitizes home paths and IPv4 in peer names', async () => {
    const v = await readFleetRecheck(deps(() => tailnet([peer('/home/fakeuser/box 100.64.1.2', true)])));
    const json = JSON.stringify(v.tailnet);
    expect(json).not.toContain('/home/fakeuser');
    expect(json).not.toContain('100.64.1.2');
  });

  it('a throwing or stalled reader changes nothing else', async () => {
    const healthy = await readFleetRecheck(deps(() => tailnet([peer('a', true)])));
    const thrown = await readFleetRecheck(deps(() => { throw new Error('/home/fakeuser boom'); }));
    vi.useFakeTimers();
    const pending = readFleetRecheck(deps(() => new Promise<TailnetPeers>(() => {})));
    await vi.advanceTimersByTimeAsync(5_001);
    const stalled = await pending;
    for (const v of [thrown, stalled]) {
      expect(v.tailnet).toMatchObject({ online: 0, offline: 0, unknown: 0, peers: [], reasons: ['tailnet: reader failed'] });
      expect(JSON.stringify(v.tailnet)).not.toContain('boom');
      expect(core(v)).toEqual(core(healthy));
    }
  });
});
