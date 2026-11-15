/** RQ-PHX-RECHECKLEDGERJOIN325 — the task section joins its work-board pick
 * against the same settled claims-ledger read the claims section uses: a named
 * owner verifies only when that exact agent holds a live, unexpired claim.
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

describe('fleet recheck task ↔ ledger join', () => {
  it('verifies the task with ledgerClaim.id when the owner holds a live claim', async () => {
    const board: FleetBoard = {
      ...healthyBoard,
      claims: [
        fakeClaim({ id: 'fake-claim-old', claimedAt: NOW_MS - 5_000 }),
        fakeClaim({ id: 'fake-claim-new', claimedAt: NOW_MS - 1_000 }),
      ],
    };
    const recheck = await readFleetRecheck(deps({ readFleetBoard: () => board }));
    expect(recheck.sections.task.state).toBe('UNKNOWN');
    expect(recheck.sections.task.missing).toEqual([ASSOCIATION_MISSING]);
    expect(recheck.sections.task.task?.ledgerClaim).toBeNull();
    expect(recheck.overall.state).toBe('UNKNOWN');
  });

  it('blocks when the owner\'s only claim expired relative to the injected now', async () => {
    const board: FleetBoard = {
      ...healthyBoard,
      claims: [fakeClaim({ expiresAt: NOW_MS - 1 })],
    };
    const recheck = await readFleetRecheck(deps({ readFleetBoard: () => board }));
    expect(recheck.sections.task.state).toBe('UNKNOWN');
    expect(recheck.sections.task.task?.ledgerClaim).toBeNull();
    expect(recheck.sections.task.task).toMatchObject({ id: 'fake-request-1', owner: 'agent-alpha' });
    expect(recheck.sections.task.missing).toEqual([ASSOCIATION_MISSING]);
    expect(recheck.overall.state).toBe('UNKNOWN');
  });

  it('marks the task UNKNOWN when the ledger reader throws', async () => {
    const recheck = await readFleetRecheck(deps({
      readFleetBoard: () => { throw new Error('ledger exploded'); },
    }));
    expect(recheck.sections.claims.state).toBe('UNKNOWN');
    expect(recheck.sections.task.state).toBe('UNKNOWN');
    expect(recheck.sections.task.task?.ledgerClaim).toBeNull();
    expect(recheck.sections.task.task).toMatchObject({ id: 'fake-request-1', owner: 'agent-alpha' });
    expect(recheck.sections.task.missing).toContain('task: claims ledger unreadable, owner claim unverified');
    expect(recheck.overall.state).not.toBe('VERIFIED');
  });

  it('picks the older qualified item when only its owner holds a live claim', async () => {
    const work: WorkBoardResult = {
      inbox: 'ok', truncated: false,
      items: [
        fakeItem({ id: 'newer-request', owner: 'agent-beta', receivedAt: '2026-11-13T13:12:00.000Z' }),
        fakeItem({ id: 'older-request', owner: 'agent-alpha', receivedAt: '2026-11-13T13:05:00.000Z' }),
      ],
    };
    const recheck = await readFleetRecheck(deps({ listWorkBoard: () => work }));
    expect(recheck.sections.task.state).toBe('UNKNOWN');
    expect(recheck.sections.task.task).toMatchObject({ id: 'older-request', owner: 'agent-alpha' });
    expect(recheck.sections.task.task?.ledgerClaim).toBeNull();
  });

  it('treats a claim agent that differs only in case as no match', async () => {
    const board: FleetBoard = {
      ...healthyBoard,
      claims: [fakeClaim({ agent: 'Agent-Alpha' })],
    };
    const recheck = await readFleetRecheck(deps({ readFleetBoard: () => board }));
    expect(recheck.sections.task.state).toBe('UNKNOWN');
    expect(recheck.sections.task.task?.ledgerClaim).toBeNull();
    expect(recheck.sections.task.missing).toEqual([ASSOCIATION_MISSING]);
  });
});
