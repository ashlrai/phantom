/** RQ-PHX-RECHECKCOORDBIND332 — readFleetRecheck verifies the task section only
 * through the claim-store binding: a message-origin `queue:<id>` row whose
 * sourceId equals the item's claimReceipt coordinates, held by the same owner
 * with a live lease. Every reader is faked, including listCoordination; nothing
 * touches the real home, ledger, bus or network. */
import { describe, expect, it } from 'vitest';
import { readFleetRecheck, type FleetRecheckDeps } from '../src/core/fleet/fleet-recheck.js';
import type { CoordinationView } from '../src/core/agents/claim-store.js';
import type { ChannelHealth, ChannelHealthReport } from '../src/core/fleet/channel-health.js';
import type { FleetBoard, FleetClaim } from '../src/core/fleet/coordination.js';
import type { RuntimeIdentity } from '../src/core/fleet/runtime-identity.js';
import type { WorkBoardItem, WorkBoardResult } from '../src/core/comms/work-board.js';

const NOW = new Date('2026-11-13T13:13:00.000Z');
const NOW_MS = NOW.getTime();
const ISO = NOW.toISOString();
const HOME = '/home/fakeuser';
const LEASE_MS = NOW_MS + 600_000;
const ASSOCIATION_MISSING =
  'task: no coordination-claim field associates a claim with board item fake-request-1; owner match is not task identity';

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
  schema: 'fleet.coordination.v1', state: 'known', claims: [fakeClaim()],
  messages: [], proposals: [], expiredClaims: 0,
};

function fakeChannel(channel: 'slack' | 'imessage'): ChannelHealth {
  return {
    channel, configured: true, processAlive: true, runtimeHost: 'fake-host',
    lastInboundAt: null, lastReplyAt: null, unansweredCount: 0,
    proof: { requestCoverage: 'idle', futureDatedCount: 0 },
    state: 'LIVE', missing: [], asOf: ISO,
  };
}

const healthyChannels: ChannelHealthReport = {
  schemaVersion: 1, asOf: ISO, channels: [fakeChannel('slack'), fakeChannel('imessage')],
};

function fakeItem(over: Partial<WorkBoardItem> = {}): WorkBoardItem {
  return {
    id: 'fake-request-1', channel: 'slack', channelRef: 'T0FAKEWS/C0FAKECH/1',
    receivedAt: '2026-11-13T13:11:00.000Z', state: 'RUNNING', asOf: ISO,
    source: 'bus-work-claims lease-until 2026-11-13T13:23:00.000Z', missing: [],
    owner: 'agent-alpha', claimReceipt: 'bus-claim:fake-request-1:3:1700000000000', ...over,
  };
}

function coordRow(over: Partial<CoordinationView> = {}): CoordinationView {
  return {
    origin: 'message', key: 'queue:fake-request-1', owner: 'agent-alpha', leaseUntil: LEASE_MS,
    sourceId: 'fake-request-1:3:1700000000000', live: true,
    repo: null, branch: null, path: null, started: null, ...over,
  };
}

function deps(over: Partial<FleetRecheckDeps> = {}): FleetRecheckDeps {
  return {
    now: () => NOW,
    homeDir: () => HOME,
    readRuntimeIdentity: () => healthyRuntime,
    readFleetBoard: () => healthyBoard,
    readChannelHealth: () => healthyChannels,
    listWorkBoard: (): WorkBoardResult => ({ items: [fakeItem()], inbox: 'ok', truncated: false }),
    listCoordination: () => ({ source: 'available', claims: [coordRow()] }),
    listLiveWorkers: () => { throw new Error('absent'); },
    ...over,
  };
}

describe('fleet recheck task ↔ claim-store binding', () => {
  it('verifies the task and the overall verdict on a matching live claim-store row', async () => {
    const recheck = await readFleetRecheck(deps());
    expect(recheck.sections.task.state).toBe('VERIFIED');
    expect(recheck.sections.task.missing).toEqual([]);
    expect(recheck.sections.task.task?.ledgerClaim).toBeNull();
    expect(recheck.sections.task.task?.coordinationClaim).toEqual({
      key: 'queue:fake-request-1', sourceId: 'fake-request-1:3:1700000000000',
      owner: 'agent-alpha', leaseUntil: new Date(LEASE_MS).toISOString(),
    });
    expect(recheck.overall).toEqual({ state: 'VERIFIED', missing: [] });
  });

  it('verifies even when the claims ledger is unreadable, since ledgerClaim is not the binding', async () => {
    const recheck = await readFleetRecheck(deps({ readFleetBoard: () => { throw new Error('fake ledger failure'); } }));
    expect(recheck.sections.task.state).toBe('VERIFIED');
    expect(recheck.sections.claims.state).toBe('UNKNOWN');
    expect(recheck.overall.state).toBe('UNKNOWN');
  });

  it('keeps today\'s exact UNKNOWN text when listCoordination throws', async () => {
    const recheck = await readFleetRecheck(deps({ listCoordination: () => { throw new Error('fake store failure'); } }));
    expect(recheck.sections.task.state).toBe('UNKNOWN');
    expect(recheck.sections.task.missing).toEqual([ASSOCIATION_MISSING]);
    expect(recheck.sections.task.task).not.toHaveProperty('coordinationClaim');
    expect(recheck.sections.task.task?.ledgerClaim).toBeNull();
  });

  it('keeps today\'s exact text when the store is missing', async () => {
    const recheck = await readFleetRecheck(deps({ listCoordination: () => ({ source: 'missing', claims: [] }) }));
    expect(recheck.sections.task.missing).toEqual([ASSOCIATION_MISSING]);
  });

  it('stays UNKNOWN when the owner holds only an unrelated message-origin row', async () => {
    const unrelated = coordRow({ key: 'queue:fake-request-9', sourceId: 'fake-request-9:1:1700000000000' });
    const recheck = await readFleetRecheck(deps({ listCoordination: () => ({ source: 'available', claims: [unrelated] }) }));
    expect(recheck.sections.task.state).toBe('UNKNOWN');
    expect(recheck.sections.task.missing).toEqual([
      ASSOCIATION_MISSING,
      'task: no message-origin coordination claim queue:fake-request-1 with source fake-request-1:3:1700000000000',
    ]);
    expect(recheck.sections.task.task).not.toHaveProperty('coordinationClaim');
    expect(recheck.overall.state).toBe('UNKNOWN');
  });

  it('appends the exact failed check after the ledger-unreadable text', async () => {
    const recheck = await readFleetRecheck(deps({
      readFleetBoard: () => { throw new Error('fake ledger failure'); },
      listCoordination: () => ({ source: 'available', claims: [coordRow({ owner: 'agent-beta' })] }),
    }));
    expect(recheck.sections.task.missing).toEqual([
      'task: claims ledger unreadable, owner claim unverified',
      'task: coordination claim queue:fake-request-1 owner differs from board owner agent-alpha',
    ]);
  });

  it('never verifies on an expired lease', async () => {
    const recheck = await readFleetRecheck(deps({
      listCoordination: () => ({ source: 'available', claims: [coordRow({ leaseUntil: NOW_MS - 1 })] }),
    }));
    expect(recheck.sections.task.state).toBe('UNKNOWN');
    expect(recheck.sections.task.missing).toEqual([
      ASSOCIATION_MISSING,
      'task: coordination claim queue:fake-request-1 lease not live at verdict clock',
    ]);
  });

  it('prefers a bound item over a newer unbound one, and a bound RUNNING item over a bound ASSIGNED one', async () => {
    const items = [
      fakeItem({ id: 'fake-request-2', receivedAt: '2026-11-13T13:12:30.000Z', claimReceipt: 'bus-claim:fake-request-2:4:1700000000001' }),
      fakeItem({ id: 'fake-request-3', state: 'ASSIGNED', receivedAt: '2026-11-13T13:12:00.000Z', claimReceipt: 'bus-claim:fake-request-3:5:1700000000002' }),
      fakeItem(),
    ];
    const claims = [
      coordRow(),
      coordRow({ key: 'queue:fake-request-3', sourceId: 'fake-request-3:5:1700000000002' }),
    ];
    const recheck = await readFleetRecheck(deps({
      listWorkBoard: () => ({ items, inbox: 'ok', truncated: false }),
      listCoordination: () => ({ source: 'available', claims }),
    }));
    expect(recheck.sections.task.state).toBe('VERIFIED');
    expect(recheck.sections.task.task?.id).toBe('fake-request-1');
  });

  it('keeps today\'s newest-first pick when nothing binds', async () => {
    const items = [
      fakeItem(),
      fakeItem({ id: 'fake-request-2', receivedAt: '2026-11-13T13:12:30.000Z', claimReceipt: 'bus-claim:fake-request-2:4:1700000000001' }),
    ];
    const recheck = await readFleetRecheck(deps({
      listWorkBoard: () => ({ items, inbox: 'ok', truncated: false }),
      listCoordination: () => ({ source: 'available', claims: [] }),
    }));
    expect(recheck.sections.task.task?.id).toBe('fake-request-2');
    expect(recheck.sections.task.state).toBe('UNKNOWN');
  });
});
