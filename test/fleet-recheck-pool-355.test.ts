/** RQ-PHX-RECHECKPOOLLINE355 — pool reachability on the fleet recheck verdict
 * and reply. Evidence only. Every reader is faked; no tailscale, ssh or home. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFleetRecheck, type FleetRecheckDeps } from '../src/core/fleet/fleet-recheck.js';
import { formatRecheckReply } from '../src/core/fleet/fleet-recheck-reply.js';
import type { PoolReach } from '../src/core/fleet/pool-reach.js';
import type { RuntimeIdentity } from '../src/core/fleet/runtime-identity.js';

const NOW = new Date('2026-11-13T18:05:00.000Z');
const ISO = NOW.toISOString();
const runtime: RuntimeIdentity = {
  host: 'fake-host', platform: 'fakeos', asOf: ISO,
  installedVersion: '1.2.3', sourceVersion: '1.2.3', versionDrift: false,
  fleetState: { path: '~/.ashlr-runs/guardian/state.json', mtime: ISO, ageSeconds: 60, stale: false },
  tailnetName: 'fake-tailnet-node', reasons: [],
};
const evidence: PoolReach = {
  asOf: ISO, self: 'mac-a', role: 'primary', reasons: [],
  hosts: [
    { slot: 'primary', alias: 'mac-a', matched: 'mac-a', online: true, lastSeen: ISO, ageSeconds: 1, isSelf: true },
    { slot: 'backup', alias: 'mac-b 100.64.1.2', matched: 'mac-b', online: false, lastSeen: '2026-11-13T18:00:00Z', ageSeconds: 300, isSelf: false },
  ],
};

function deps(readPool: FleetRecheckDeps['readPool']): FleetRecheckDeps {
  return {
    now: () => NOW,
    homeDir: () => '/home/fakeuser',
    readRuntimeIdentity: () => runtime,
    readFleetBoard: () => ({ schema: 'fleet.coordination.v1', state: 'known', claims: [], messages: [], proposals: [], expiredClaims: 0 }),
    readChannelHealth: () => ({ schemaVersion: 1, asOf: ISO, channels: [] }),
    listWorkBoard: () => ({ items: [], inbox: 'ok', truncated: false }) as never,
    listCoordination: () => ({ source: 'unavailable', claims: [] }) as never,
    listLiveWorkers: () => ({ workers: [], state: 'unknown' }) as never,
    readTailnetPeers: () => ({ asOf: ISO, self: 'fake-self', peers: [], reasons: [] }),
    readPool,
  };
}
const core = (v: Awaited<ReturnType<typeof readFleetRecheck>>) => ({
  overall: v.overall, sections: v.sections,
});

afterEach(() => vi.useRealTimers());

describe('fleet recheck pool evidence', () => {
  it('carries evidence and the reply puts Pool right after Computers', async () => {
    const v = await readFleetRecheck(deps(() => evidence));
    expect(v.schema).toBe('fleet.recheck.v1');
    expect(v.pool?.hosts).toHaveLength(2);
    const lines = formatRecheckReply(v).split('\n');
    const i = lines.findIndex(l => l.startsWith('Computers:'));
    expect(i).toBeGreaterThan(-1);
    expect(lines[i + 1]).toMatch(/^Pool: primary mac-a online \(this computer\) · backup mac-b \[ip\]? ?offline|^Pool: primary mac-a online/);
    expect(lines[i + 1]).toContain('offline (last seen 2026-11-13T18:00:00Z)');
    expect(lines.join('\n')).not.toContain('100.64.1.2');
  });

  it('a throwing reader says reader failed and changes nothing else', async () => {
    const healthy = await readFleetRecheck(deps(() => evidence));
    const v = await readFleetRecheck(deps(() => { throw new Error('boom'); }));
    expect(v.pool).toEqual({ asOf: ISO, self: 'unknown', role: 'unknown', hosts: [], reasons: ['pool: reader failed'] });
    expect(core(v)).toEqual(core(healthy));
    expect(formatRecheckReply(v)).toContain('Pool: unknown · pool: reader failed');
  });

  it('a stalled reader times out within SECTION_TIMEOUT_MS plus slack', async () => {
    vi.useFakeTimers();
    const p = readFleetRecheck(deps(() => new Promise<PoolReach>(() => {})));
    await vi.advanceTimersByTimeAsync(5_001);
    const v = await p;
    expect(v.pool?.reasons).toEqual(['pool: reader failed']);
    expect(v.overall.state).toBe((await (async () => { vi.useRealTimers(); return readFleetRecheck(deps(() => evidence)); })()).overall.state);
  });

  it('drops Pool before any other line when the reply is over budget', async () => {
    const v = await readFleetRecheck(deps(() => evidence));
    let tipped = false;
    for (let m = 300; m < 900 && !tipped; m++) {
      v.overall.missing = ['y'.repeat(m)];
      const text = formatRecheckReply(v);
      if (!text.includes('Pool:')) {
        tipped = true;
        expect(text).toContain('Computers:');
        expect(text.length).toBeLessThanOrEqual(900);
      }
    }
    expect(tipped).toBe(true);
  });
});
