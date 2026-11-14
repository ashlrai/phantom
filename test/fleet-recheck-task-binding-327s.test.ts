/** RQ-PHX-RECHECKTASKBIND327S — the task section must not verify a work-board
 * pick from an owner's unrelated coordination claim. FleetClaim
 * {id, repo, task, agent, claimedAt, expiresAt} shares no explicit identity
 * field with WorkBoardItem {id, owner, claimReceipt}: the receipt is a
 * bus-work-claims coordinate, claim.task is free text and claim.id is a
 * ledger uuid, so owner equality alone is not task identity. Until a producer
 * contract names the association the section reports the observed pick as
 * UNKNOWN with ledgerClaim null and an exact missing-association reason.
 * Every reader is faked here: nothing touches the real home, ledger, bus or
 * network. Fixtures are plainly fake; no message bodies, leases or env values
 * appear. */
import { describe, expect, it } from 'vitest';
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

describe('fleet recheck task ↔ ledger binding', () => {
  it('reports UNKNOWN, never VERIFIED, when the owner holds a live claim for an unrelated task/repo/id', async () => {
    let ledgerReads = 0;
    const board: FleetBoard = {
      ...healthyBoard,
      claims: [fakeClaim({ id: 'unrelated-claim', repo: 'ashlrai/other', task: 'an unrelated job' })],
    };
    const recheck = await readFleetRecheck(deps({
      readFleetBoard: () => { ledgerReads += 1; return board; },
    }));
    expect(ledgerReads).toBe(1);
    const task = recheck.sections.task;
    expect(task.state).toBe('UNKNOWN');
    expect(task.missing).toEqual([ASSOCIATION_MISSING]);
    // The observed pick is retained verbatim; only the ledger join is refused.
    expect(task.task).toMatchObject({
      id: 'fake-request-1', state: 'RUNNING', owner: 'agent-alpha',
      claimReceipt: 'bus-claim:fake-request-1:1:1700000000000', ledgerClaim: null,
    });
    expect(recheck.overall.state).not.toBe('VERIFIED');
  });

  it('does not bind a claim whose free-text task equals the item id — no producer contract names that field', async () => {
    const board: FleetBoard = {
      ...healthyBoard,
      claims: [fakeClaim({ task: 'fake-request-1' })],
    };
    const recheck = await readFleetRecheck(deps({ readFleetBoard: () => board }));
    expect(recheck.sections.task.state).toBe('UNKNOWN');
    expect(recheck.sections.task.task?.ledgerClaim).toBeNull();
    expect(recheck.sections.task.missing).toEqual([ASSOCIATION_MISSING]);
  });

  it('never selects the newest of two live claims for one owner as task identity', async () => {
    const board: FleetBoard = {
      ...healthyBoard,
      claims: [
        fakeClaim({ id: 'fake-claim-old', claimedAt: NOW_MS - 5_000, task: 'older unrelated' }),
        fakeClaim({ id: 'fake-claim-new', claimedAt: NOW_MS - 1_000, task: 'newer unrelated' }),
      ],
    };
    const recheck = await readFleetRecheck(deps({ readFleetBoard: () => board }));
    expect(recheck.sections.task.state).toBe('UNKNOWN');
    expect(recheck.sections.task.task?.ledgerClaim).toBeNull();
    expect(recheck.sections.task.missing).toEqual([ASSOCIATION_MISSING]);
    // The claims section still reports both live claims; liveness is unchanged.
    expect(recheck.sections.claims.active).toBe(2);
  });

  it('stays UNKNOWN with the unreadable-ledger reason when the board reports state unknown', async () => {
    let ledgerReads = 0;
    const board: FleetBoard = { ...healthyBoard, state: 'unknown', claims: [] };
    const recheck = await readFleetRecheck(deps({
      readFleetBoard: () => { ledgerReads += 1; return board; },
    }));
    expect(ledgerReads).toBe(1);
    expect(recheck.sections.task.state).toBe('UNKNOWN');
    expect(recheck.sections.task.task?.ledgerClaim).toBeNull();
    expect(recheck.sections.task.missing)
      .toContain('task: claims ledger unreadable, owner claim unverified');
  });

  it('stays UNKNOWN when the ledger reader throws, and excludes expired and future claims', async () => {
    const thrown = await readFleetRecheck(deps({
      readFleetBoard: () => { throw new Error('ledger exploded'); },
    }));
    expect(thrown.sections.task.state).toBe('UNKNOWN');
    expect(thrown.sections.task.task?.ledgerClaim).toBeNull();
    expect(thrown.sections.task.missing)
      .toContain('task: claims ledger unreadable, owner claim unverified');

    const board: FleetBoard = {
      ...healthyBoard,
      claims: [
        fakeClaim({ id: 'expired', expiresAt: NOW_MS - 1 }),
        fakeClaim({ id: 'future', claimedAt: NOW_MS + 60_000, expiresAt: NOW_MS + 120_000 }),
      ],
      expiredClaims: 1,
    };
    const recheck = await readFleetRecheck(deps({ readFleetBoard: () => board }));
    expect(recheck.sections.claims.active).toBe(0);
    expect(recheck.sections.claims.expiredClaims).toBe(1);
    expect(recheck.sections.task.state).toBe('UNKNOWN');
    expect(recheck.sections.task.task?.ledgerClaim).toBeNull();
    expect(recheck.sections.task.missing).toEqual([ASSOCIATION_MISSING]);
  });

  it('preserves the observed ASSIGNED state without claiming execution from lease existence', async () => {
    const work: WorkBoardResult = { items: [fakeItem({ state: 'ASSIGNED' })], inbox: 'ok', truncated: false };
    const recheck = await readFleetRecheck(deps({ listWorkBoard: () => work }));
    expect(recheck.sections.task.state).toBe('UNKNOWN');
    expect(recheck.sections.task.task).toMatchObject({
      id: 'fake-request-1', state: 'ASSIGNED', owner: 'agent-alpha', ledgerClaim: null,
    });
    expect(recheck.sections.task.missing).toEqual([ASSOCIATION_MISSING]);
  });

  it('still reports BLOCKED when no RUNNING or ASSIGNED item is qualified', async () => {
    const work: WorkBoardResult = {
      items: [fakeItem({ state: 'RECEIVED' })], inbox: 'ok', truncated: false,
    };
    const recheck = await readFleetRecheck(deps({ listWorkBoard: () => work }));
    expect(recheck.sections.task.state).toBe('BLOCKED');
    expect(recheck.sections.task.task).toBeNull();
    expect(recheck.sections.task.missing).toContain('task: no RUNNING or ASSIGNED board item');
  });
});
