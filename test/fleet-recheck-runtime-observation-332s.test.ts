/** RQ-PHX-RUNTIMEOBSERVATION332S — the runtime section verifies only an
 * identity observation captured inside its own reader bound
 * (SECTION_TIMEOUT_MS) of the verdict clock. id.asOf must be finite and
 * within the bound in either direction: a cached historical
 * RuntimeIdentity whose fleetState.stale flag was false can never verify
 * merely because that flag says fresh. Old, malformed or future-dated
 * asOf values — and an unreadable verdict clock — report UNKNOWN with an
 * exact runtime-specific reason while host, version, source timestamp and
 * fleet-state fields are preserved as evidence. Every reader is faked
 * here: nothing touches the real home, ledger, bus, host or network.
 * Fixtures are plainly fake; no message bodies, leases or env values
 * appear. */
import { describe, expect, it, vi } from 'vitest';
import { readFleetRecheck, SECTION_TIMEOUT_MS, type FleetRecheckDeps } from '../src/core/fleet/fleet-recheck.js';
import type { ChannelHealth, ChannelHealthReport } from '../src/core/fleet/channel-health.js';
import type { FleetBoard } from '../src/core/fleet/coordination.js';
import type { RuntimeIdentity } from '../src/core/fleet/runtime-identity.js';
import type { WorkBoardItem, WorkBoardResult } from '../src/core/comms/work-board.js';

const NOW = new Date('2026-11-13T13:13:00.000Z');
const NOW_MS = NOW.getTime();
const ISO = NOW.toISOString();
const HOME = '/home/fakeuser';
const iso = (ms: number): string => new Date(ms).toISOString();
const STALE = iso(NOW_MS - 30_000);
const FUTURE = iso(NOW_MS + 30_000);
const EDGE_PAST = iso(NOW_MS - SECTION_TIMEOUT_MS); // exactly on the bound
const EDGE_FUTURE = iso(NOW_MS + SECTION_TIMEOUT_MS);
const JUST_STALE = iso(NOW_MS - SECTION_TIMEOUT_MS - 1);
const JUST_FUTURE = iso(NOW_MS + SECTION_TIMEOUT_MS + 1);

/** A fully healthy identity read; tests override asOf (and occasionally
 * fleetState) to exercise the observation-freshness contract. */
function fakeRuntime(over: Partial<RuntimeIdentity> = {}): RuntimeIdentity {
  return {
    host: 'fake-host', platform: 'fakeos', asOf: ISO, installedVersion: '1.2.3', sourceVersion: '1.2.3',
    versionDrift: false, tailnetName: 'fake-tailnet-node', reasons: [],
    fleetState: { path: '~/.ashlr-runs/guardian/state.json', mtime: '2026-11-13T13:12:00.000Z', ageSeconds: 60, stale: false },
    ...over,
  };
}

const healthyBoard: FleetBoard = {
  schema: 'fleet.coordination.v1', state: 'known', messages: [], proposals: [], expiredClaims: 0,
  claims: [{ id: 'fake-claim-1', repo: 'ashlrai/phantom', task: 'fake ledger task',
    agent: 'agent-alpha', claimedAt: NOW_MS - 1_000, expiresAt: NOW_MS + 3_600_000 }],
};

function fakeChannel(channel: 'slack' | 'imessage'): ChannelHealth {
  return {
    channel, configured: true, processAlive: true, runtimeHost: 'fake-host',
    lastInboundAt: null, lastReplyAt: null, unansweredCount: 0, state: 'LIVE', missing: [], asOf: ISO,
    proof: { requestCoverage: 'idle', futureDatedCount: 0 },
  };
}

const healthyChannels: ChannelHealthReport = {
  schemaVersion: 1, asOf: ISO, channels: [fakeChannel('slack'), fakeChannel('imessage')],
};

function fakeItem(over: Partial<WorkBoardItem> = {}): WorkBoardItem {
  return {
    id: 'fake-request-1', channel: 'slack', channelRef: 'T0FAKEWS/C0FAKECH/1', state: 'RUNNING', asOf: ISO,
    receivedAt: '2026-11-13T13:11:00.000Z', missing: [], owner: 'agent-alpha',
    source: 'bus-work-claims lease-until 2026-11-13T13:30:00.000Z',
    claimReceipt: 'bus-claim:fake-request-1:1:1700000000000', ...over,
  };
}

const healthyWork: WorkBoardResult = { items: [fakeItem()], inbox: 'ok', truncated: false };

function deps(over: Partial<FleetRecheckDeps> = {}): FleetRecheckDeps {
  return {
    now: () => NOW, homeDir: () => HOME, listWorkBoard: () => healthyWork,
    readRuntimeIdentity: () => fakeRuntime(), readFleetBoard: () => healthyBoard,
    readChannelHealth: () => healthyChannels,
    listCoordination: () => ({ source: 'unavailable', claims: [] }),
    listLiveWorkers: () => { throw new Error('absent'); },
    ...over,
  };
}

describe('fleet recheck runtime observation freshness', () => {
  it('verifies a fresh identity observation', async () => {
    const recheck = await readFleetRecheck(deps());
    expect(recheck.sections.runtime).toMatchObject({
      state: 'VERIFIED', missing: [], asOf: ISO, host: 'fake-host',
      installedVersion: '1.2.3', sourceVersion: '1.2.3',
      fleetState: { ageSeconds: 60, stale: false },
    });
    // The task section never verifies by contract, so the overall verdict
    // stays UNKNOWN — but nothing runtime-related is missing.
    expect(recheck.overall.missing.some(m => m.startsWith('runtime:'))).toBe(false);
  });

  it('a cached stale:false snapshot with an old asOf does not verify', async () => {
    const recheck = await readFleetRecheck(deps({
      readRuntimeIdentity: () => fakeRuntime({ asOf: STALE }),
    }));
    const runtime = recheck.sections.runtime;
    expect(runtime.state).toBe('UNKNOWN');
    expect(runtime.missing).toEqual(['runtime: asOf stale (30s old)']);
    // The historical observation is preserved as evidence, not erased.
    expect(runtime).toMatchObject({
      asOf: STALE, host: 'fake-host', tailnetName: 'fake-tailnet-node',
      installedVersion: '1.2.3', sourceVersion: '1.2.3',
      fleetState: { ageSeconds: 60, stale: false },
    });
    expect(recheck.overall.state).toBe('UNKNOWN');
    expect(recheck.overall.missing).toContain('runtime: asOf stale (30s old)');
  });

  it('malformed asOf does not verify even with stale:false', async () => {
    const recheck = await readFleetRecheck(deps({
      readRuntimeIdentity: () => fakeRuntime({ asOf: 'not-a-timestamp' }),
    }));
    expect(recheck.sections.runtime.state).toBe('UNKNOWN');
    expect(recheck.sections.runtime.missing).toEqual(['runtime: asOf malformed']);
    expect(recheck.sections.runtime.host).toBe('fake-host');
    expect(recheck.sections.runtime.fleetState.stale).toBe(false);
  });

  it('future-dated asOf does not verify', async () => {
    const recheck = await readFleetRecheck(deps({
      readRuntimeIdentity: () => fakeRuntime({ asOf: FUTURE }),
    }));
    expect(recheck.sections.runtime.state).toBe('UNKNOWN');
    expect(recheck.sections.runtime.missing).toEqual(['runtime: asOf in the future']);
  });

  it('an unreadable verdict clock leaves freshness unverifiable, never VERIFIED', async () => {
    const recheck = await readFleetRecheck(deps({ now: () => new Date(Number.NaN) }));
    expect(recheck.asOf).toBe('unknown');
    expect(recheck.sections.runtime.state).toBe('UNKNOWN');
    expect(recheck.sections.runtime.missing)
      .toContain('runtime: verdict clock unknown, observation freshness unverifiable');
    expect(recheck.overall.state).not.toBe('VERIFIED');
  });

  it('boundary semantics: exactly SECTION_TIMEOUT_MS verifies, one ms beyond fails', async () => {
    const edgePast = await readFleetRecheck(deps({
      readRuntimeIdentity: () => fakeRuntime({ asOf: EDGE_PAST }),
    }));
    expect(edgePast.sections.runtime.state).toBe('VERIFIED');
    const edgeFuture = await readFleetRecheck(deps({
      readRuntimeIdentity: () => fakeRuntime({ asOf: EDGE_FUTURE }),
    }));
    expect(edgeFuture.sections.runtime.state).toBe('VERIFIED');
    const justStale = await readFleetRecheck(deps({
      readRuntimeIdentity: () => fakeRuntime({ asOf: JUST_STALE }),
    }));
    expect(justStale.sections.runtime.state).toBe('UNKNOWN');
    expect(justStale.sections.runtime.missing).toEqual(['runtime: asOf stale (5s old)']);
    const justFuture = await readFleetRecheck(deps({
      readRuntimeIdentity: () => fakeRuntime({ asOf: JUST_FUTURE }),
    }));
    expect(justFuture.sections.runtime.state).toBe('UNKNOWN');
    expect(justFuture.sections.runtime.missing).toEqual(['runtime: asOf in the future']);
  });

  it('existing unknown and stale-state behavior is preserved', async () => {
    // A fresh observation with a genuinely stale fleet state keeps its
    // fleetState reason and gains no freshness complaint.
    const staleFleet = await readFleetRecheck(deps({
      readRuntimeIdentity: () => fakeRuntime({
        fleetState: { path: '~/.ashlr-runs/guardian/state.json', mtime: '2026-11-13T12:00:00.000Z', ageSeconds: 4_380, stale: true },
      }),
    }));
    expect(staleFleet.sections.runtime.state).toBe('UNKNOWN');
    expect(staleFleet.sections.runtime.missing).toEqual(['fleetState: stale (4380s old)']);
    // An unreadable host keeps its own reasons alongside a fresh asOf.
    const noHost = await readFleetRecheck(deps({
      readRuntimeIdentity: () => fakeRuntime({ host: 'unknown', reasons: ['host: hostname unavailable'] }),
    }));
    expect(noHost.sections.runtime.state).toBe('UNKNOWN');
    expect(noHost.sections.runtime.missing).toEqual(['host: hostname unavailable']);
    // A stale fleet flag on an old observation: the freshness failure is the
    // missing reason; the stale flag itself stays visible in fleetState.
    const both = await readFleetRecheck(deps({
      readRuntimeIdentity: () => fakeRuntime({
        asOf: STALE,
        fleetState: { path: '~/.ashlr-runs/guardian/state.json', mtime: '2026-11-13T12:00:00.000Z', ageSeconds: 4_380, stale: true },
      }),
    }));
    expect(both.sections.runtime.missing).toEqual(['runtime: asOf stale (30s old)']);
    expect(both.sections.runtime.fleetState.stale).toBe(true);
  });

  it('a failed runtime read still reports reader failure', async () => {
    const recheck = await readFleetRecheck(deps({ readRuntimeIdentity: () => { throw new Error('fake boom'); } }));
    expect(recheck.sections.runtime).toMatchObject({ state: 'UNKNOWN', missing: ['runtime: reader failed'], host: 'unknown' });
  });

  it('each reader is invoked exactly once and other sections cannot obscure the runtime verdict', async () => {
    const readRuntimeIdentity = vi.fn(() => fakeRuntime({ asOf: STALE }));
    const readFleetBoard = vi.fn(() => healthyBoard);
    const readChannelHealth = vi.fn(() => healthyChannels);
    const listWorkBoard = vi.fn(() => healthyWork);
    const recheck = await readFleetRecheck(deps({ readRuntimeIdentity, readFleetBoard, readChannelHealth, listWorkBoard }));
    expect(readRuntimeIdentity).toHaveBeenCalledTimes(1);
    expect(readFleetBoard).toHaveBeenCalledTimes(1);
    expect(readChannelHealth).toHaveBeenCalledTimes(1);
    expect(listWorkBoard).toHaveBeenCalledTimes(1);
    // Claims and bridge verify; the task section refuses by contract. The
    // runtime failure must still surface on its own section and in the
    // overall missing list — no other section can launder it.
    expect(recheck.sections.claims.state).toBe('VERIFIED');
    expect(recheck.sections.bridge.state).toBe('VERIFIED');
    expect(recheck.sections.runtime.state).toBe('UNKNOWN');
    expect(recheck.sections.runtime.missing).toEqual(['runtime: asOf stale (30s old)']);
    expect(recheck.overall.missing).toContain('runtime: asOf stale (30s old)');
  });
});
