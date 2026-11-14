/** RQ-PHX-RECHECKCLAIMTIME326S — the fleet recheck counts and selects only
 * coordination claims live at the captured verdict timestamp: a claim must
 * have finite, ordered timestamps with claimedAt <= now < expiresAt. Future,
 * expired and malformed rows never verify ownership, never count toward
 * `active` and never appear in `top`; the claims section and the task↔ledger
 * join share one captured now and one settled ledger read. Every reader is
 * faked here: nothing touches the real home, ledger, bus or network. Fixtures
 * are plainly fake; no message bodies, leases or env values appear. */
import { describe, expect, it, vi } from 'vitest';
import { readFleetRecheck, type FleetRecheckDeps } from '../src/core/fleet/fleet-recheck.js';
import type { ChannelHealth, ChannelHealthReport } from '../src/core/fleet/channel-health.js';
import type { FleetBoard, FleetClaim } from '../src/core/fleet/coordination.js';
import type { RuntimeIdentity } from '../src/core/fleet/runtime-identity.js';
import type { WorkBoardItem, WorkBoardResult } from '../src/core/comms/work-board.js';

const NOW = new Date('2026-11-13T13:13:00.000Z');
const NOW_MS = NOW.getTime();
const ISO = NOW.toISOString();
const HOME = '/home/fakeuser';

const healthyRuntime: RuntimeIdentity = {
  host: 'fake-host', platform: 'fakeos', asOf: ISO,
  installedVersion: '1.2.3', sourceVersion: '1.2.3', versionDrift: false,
  fleetState: { path: '~/.ashlr-runs/guardian/state.json', mtime: '2026-11-13T13:12:00.000Z', ageSeconds: 60, stale: false },
  tailnetName: 'fake-tailnet-node', reasons: [],
};

function fakeClaim(over: Partial<FleetClaim> = {}): FleetClaim {
  return {
    id: 'fake-claim-1', repo: 'ashlrai/phantom', task: 'fake ledger task',
    agent: 'agent-alpha', claimedAt: NOW_MS - 1_000, expiresAt: NOW_MS + 3_600_000, ...over,
  };
}

const healthyBoard: FleetBoard = {
  schema: 'fleet.coordination.v1', state: 'known',
  claims: [fakeClaim()],
  messages: [], proposals: [], expiredClaims: 0,
};

function fakeChannel(channel: 'slack' | 'imessage', over: Partial<ChannelHealth> = {}): ChannelHealth {
  return {
    channel, configured: true, processAlive: true, runtimeHost: 'fake-host',
    lastInboundAt: null, lastReplyAt: null, unansweredCount: 0,
    proof: { requestCoverage: 'idle', futureDatedCount: 0 },
    state: 'LIVE', missing: [], asOf: ISO, ...over,
  };
}

const healthyChannels: ChannelHealthReport = {
  schemaVersion: 1, asOf: ISO,
  channels: [fakeChannel('slack'), fakeChannel('imessage')],
};

function fakeItem(over: Partial<WorkBoardItem> = {}): WorkBoardItem {
  return {
    id: 'fake-request-1', channel: 'slack', channelRef: 'T0FAKEWS/C0FAKECH/1',
    receivedAt: '2026-11-13T13:11:00.000Z', state: 'RUNNING', asOf: ISO,
    source: 'bus-work-claims lease-until 2026-11-13T13:30:00.000Z', missing: [],
    owner: 'agent-alpha', claimReceipt: 'bus-claim:fake-request-1:1:1700000000000', ...over,
  };
}

const healthyWork: WorkBoardResult = { items: [fakeItem()], inbox: 'ok', truncated: false };

function deps(over: Partial<FleetRecheckDeps> = {}): FleetRecheckDeps {
  return {
    now: () => NOW,
    homeDir: () => HOME,
    readRuntimeIdentity: () => healthyRuntime,
    readFleetBoard: () => healthyBoard,
    readChannelHealth: () => healthyChannels,
    listWorkBoard: () => healthyWork,
    listCoordination: () => ({ source: 'unavailable', claims: [] }),
    listLiveWorkers: () => { throw new Error('absent'); },
    ...over,
  };
}

const ASSOCIATION_MISSING = 'task: no coordination-claim field associates a claim with board item fake-request-1; owner match is not task identity';

describe('fleet recheck claim verdict-time filtering', () => {
  it('never verifies a task from a claim that starts after the verdict now', async () => {
    const board: FleetBoard = {
      ...healthyBoard,
      claims: [fakeClaim({ claimedAt: NOW_MS + 60_000, expiresAt: NOW_MS + 3_660_000 })],
    };
    const recheck = await readFleetRecheck(deps({ readFleetBoard: () => board }));
    // The future claim is live at ledger-read time but not yet at the verdict.
    expect(recheck.sections.claims.state).toBe('VERIFIED');
    expect(recheck.sections.claims.active).toBe(0);
    expect(recheck.sections.claims.top).toEqual([]);
    expect(recheck.sections.task.state).toBe('UNKNOWN');
    expect(recheck.sections.task.task?.ledgerClaim).toBeNull();
    expect(recheck.sections.task.missing).toEqual([ASSOCIATION_MISSING]);
    expect(recheck.overall.state).toBe('UNKNOWN');
  });

  it('treats claimedAt exactly at the verdict now as live', async () => {
    const board: FleetBoard = {
      ...healthyBoard,
      claims: [fakeClaim({ claimedAt: NOW_MS })],
    };
    const recheck = await readFleetRecheck(deps({ readFleetBoard: () => board }));
    expect(recheck.sections.claims).toMatchObject({ state: 'VERIFIED', active: 1 });
    expect(recheck.sections.task.state).toBe('UNKNOWN');
    expect(recheck.sections.task.task?.ledgerClaim).toBeNull();
    expect(recheck.overall.state).toBe('UNKNOWN');
  });

  it('treats expiresAt exactly at the verdict now as not live', async () => {
    const board: FleetBoard = {
      ...healthyBoard,
      claims: [fakeClaim({ expiresAt: NOW_MS })],
    };
    const recheck = await readFleetRecheck(deps({ readFleetBoard: () => board }));
    expect(recheck.sections.claims).toMatchObject({ state: 'VERIFIED', active: 0, top: [] });
    expect(recheck.sections.task.state).toBe('UNKNOWN');
    expect(recheck.sections.task.task?.ledgerClaim).toBeNull();
    expect(recheck.overall.state).toBe('UNKNOWN');
  });

  it('keeps expired rows out of the active count and the top listing', async () => {
    const board: FleetBoard = {
      ...healthyBoard,
      claims: [
        fakeClaim({ id: 'fake-claim-expired', claimedAt: NOW_MS - 7_200_000, expiresAt: NOW_MS - 3_600_000 }),
        fakeClaim({ id: 'fake-claim-live', claimedAt: NOW_MS - 1_000 }),
      ],
      expiredClaims: 1,
    };
    const recheck = await readFleetRecheck(deps({ readFleetBoard: () => board }));
    expect(recheck.sections.claims).toMatchObject({ state: 'VERIFIED', active: 1, expiredClaims: 1 });
    expect(recheck.sections.claims.top).toHaveLength(1);
    expect(recheck.sections.claims.top[0]).toMatchObject({ agent: 'agent-alpha' });
    expect(JSON.stringify(recheck.sections.claims.top)).not.toContain('fake-claim-expired');
  });

  it('selects the genuinely live owner claim among expired, future and live rows', async () => {
    const board: FleetBoard = {
      ...healthyBoard,
      claims: [
        fakeClaim({ id: 'fake-claim-expired', claimedAt: NOW_MS - 7_200_000, expiresAt: NOW_MS - 1 }),
        fakeClaim({ id: 'fake-claim-future', agent: 'agent-alpha', claimedAt: NOW_MS + 60_000, expiresAt: NOW_MS + 3_660_000 }),
        fakeClaim({ id: 'fake-claim-live', claimedAt: NOW_MS - 500 }),
        fakeClaim({ id: 'fake-claim-other', agent: 'agent-beta', claimedAt: NOW_MS - 100, expiresAt: NOW_MS + 3_600_000 }),
      ],
    };
    const recheck = await readFleetRecheck(deps({ readFleetBoard: () => board }));
    expect(recheck.sections.claims.active).toBe(2);
    expect(recheck.sections.task.state).toBe('UNKNOWN');
    expect(recheck.sections.task.task?.ledgerClaim).toBeNull();
    expect(recheck.overall.state).toBe('UNKNOWN');
  });

  it('claims malformed timing (expiresAt <= claimedAt, non-finite) cannot verify ownership', async () => {
    for (const claim of [
      fakeClaim({ expiresAt: NOW_MS - 2_000, claimedAt: NOW_MS - 1_000 }),
      fakeClaim({ claimedAt: Number.NaN, expiresAt: NOW_MS + 3_600_000 }),
      fakeClaim({ claimedAt: NOW_MS - 1_000, expiresAt: Number.NaN }),
      fakeClaim({ claimedAt: NOW_MS - 1_000, expiresAt: Number.POSITIVE_INFINITY }),
    ]) {
      const recheck = await readFleetRecheck(deps({
        readFleetBoard: () => ({ ...healthyBoard, claims: [claim] }),
      }));
      expect(recheck.sections.claims.active).toBe(0);
      expect(recheck.sections.claims.top).toEqual([]);
      expect(recheck.sections.task.state).toBe('UNKNOWN');
      expect(recheck.sections.task.task?.ledgerClaim).toBeNull();
      expect(recheck.overall.state).toBe('UNKNOWN');
    }
  });

  it('captures one now and settles one ledger read shared by claims and task', async () => {
    const now = vi.fn(() => NOW);
    const readFleetBoard = vi.fn(() => healthyBoard);
    const recheck = await readFleetRecheck(deps({ now, readFleetBoard }));
    expect(now).toHaveBeenCalledTimes(1);
    expect(readFleetBoard).toHaveBeenCalledTimes(1);
    expect(recheck.sections.claims.active).toBe(1);
    expect(recheck.sections.task.state).toBe('UNKNOWN');
    expect(recheck.sections.claims.asOf).toBe(ISO);
    expect(recheck.sections.task.asOf).toBe(recheck.sections.claims.asOf);
  });

  it('keeps an unreadable ledger UNKNOWN with null counts', async () => {
    const unreadable: FleetBoard = { ...healthyBoard, state: 'unknown', claims: [], expiredClaims: null };
    const recheck = await readFleetRecheck(deps({ readFleetBoard: () => unreadable }));
    expect(recheck.sections.claims).toMatchObject({
      state: 'UNKNOWN', active: null, expiredClaims: null, top: [],
      missing: ['claims: ledger state unknown (unreadable)'],
    });
    expect(recheck.sections.task.state).toBe('UNKNOWN');
    expect(recheck.overall.state).toBe('UNKNOWN');
  });

  it('an invalid verdict clock yields explicit unknown temporal evidence, never VERIFIED', async () => {
    const recheck = await readFleetRecheck(deps({ now: () => new Date(Number.NaN) }));
    expect(recheck.asOf).toBe('unknown');
    expect(recheck.sections.claims.state).toBe('UNKNOWN');
    expect(recheck.sections.claims.active).toBeNull();
    expect(recheck.sections.claims.top).toEqual([]);
    expect(recheck.sections.claims.missing).toContain('claims: verdict clock unknown, claim liveness unverifiable');
    expect(recheck.sections.task.state).toBe('UNKNOWN');
    expect(recheck.sections.task.task?.ledgerClaim).toBeNull();
    expect(recheck.sections.task.missing).toContain('task: verdict clock unknown, owner claim unverified');
    expect(recheck.overall.state).not.toBe('VERIFIED');
  });
});
