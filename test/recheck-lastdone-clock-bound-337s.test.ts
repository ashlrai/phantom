/** RQ-PHX-LASTDONECLOCKBOUND337S — test that the task section bounds the
 * lastVerified selection by finite asOf at or before the captured nowMs.
 * Future asOf values in work board items should not displace valid older
 * completions, and invalid asOf should produce null lastVerified. */
import { describe, expect, it } from 'vitest';
import { readFleetRecheck, type FleetRecheckDeps } from '../src/core/fleet/fleet-recheck.js';
import type { ChannelHealth, ChannelHealthReport } from '../src/core/fleet/channel-health.js';
import type { FleetBoard } from '../src/core/fleet/coordination.js';
import type { RuntimeIdentity } from '../src/core/fleet/runtime-identity.js';
import type { WorkBoardItem, WorkBoardResult } from '../src/core/comms/work-board.js';

const NOW = new Date('2026-11-13T13:13:00.000Z');
const ISO = NOW.toISOString();
const HOME = '/home/fakeuser';

const runtime: RuntimeIdentity = {
  host: 'fake-host', platform: 'fakeos', asOf: ISO,
  installedVersion: '1.2.3', sourceVersion: '1.2.3', versionDrift: false,
  fleetState: { path: '~/.ashlr-runs/guardian/state.json', mtime: '2026-11-13T13:12:00.000Z', ageSeconds: 60, stale: false },
  tailnetName: 'fake-tailnet-node', reasons: [],
};
const ledger: FleetBoard = {
  schema: 'fleet.coordination.v1', state: 'known', claims: [], messages: [], proposals: [], expiredClaims: 0,
};
const channel = (c: 'slack' | 'imessage'): ChannelHealth => ({
  channel: c, configured: true, processAlive: true, runtimeHost: 'fake-host',
  lastInboundAt: null, lastReplyAt: null, unansweredCount: 0,
  proof: { requestCoverage: 'idle', futureDatedCount: 0 }, state: 'LIVE', missing: [], asOf: ISO,
});
const channels: ChannelHealthReport = { schemaVersion: 1, asOf: ISO, channels: [channel('slack'), channel('imessage')] };

function item(over: Partial<WorkBoardItem> = {}): WorkBoardItem {
  return {
    id: 'fake-done-1', channel: 'slack', channelRef: 'T0FAKEWS/C0FAKECH/1',
    receivedAt: '2026-11-13T13:00:00.000Z', state: 'VERIFIED', asOf: '2026-11-13T13:05:00.000Z',
    source: 'bus-reply:fake-reply-1', missing: [],
    owner: 'agent-alpha', claimReceipt: 'bus-claim:fake-done-1:1:1700000000000', ...over,
  };
}

function deps(items: WorkBoardItem[], over: Partial<FleetRecheckDeps> = {}): FleetRecheckDeps {
  return {
    now: () => NOW, homeDir: () => HOME,
    readRuntimeIdentity: () => runtime, readFleetBoard: () => ledger, readChannelHealth: () => channels,
    listWorkBoard: (): WorkBoardResult => ({ items, inbox: 'ok', truncated: false }),
    listCoordination: () => ({ source: 'unavailable', claims: [] }),
    listLiveWorkers: () => { throw new Error('absent'); },
    ...over,
  };
}


describe('fleet recheck task.lastVerified clock bound', () => {
  it('accepts only finite asOf at or before nowMs', async () => {
    const laterAsOf = new Date('2026-11-13T13:15:00.000Z');
    const itemWithFutureAsOf = item({ asOf: laterAsOf.toISOString() });
    
    // Future asOf should not displace older legitimate completion
    const withFuture = await readFleetRecheck(deps([itemWithFutureAsOf, item({ id: 'older-done', asOf: '2026-11-13T13:02:00.000Z' })]));
    expect(withFuture.sections.task.lastVerified?.id).toBe('older-done');
    
    // Future-only rows should produce null lastVerified
    const onlyFuture = await readFleetRecheck(deps([itemWithFutureAsOf]));
    expect(onlyFuture.sections.task.lastVerified).toBeNull();
  });

  it('returns null when asOf is not finite', async () => {
    const malformedAsOf = item({ asOf: 'not-a-date' });
    
    const withMalformed = await readFleetRecheck(deps([malformedAsOf]));
    expect(withMalformed.sections.task.lastVerified).toBeNull();
  });

  it('returns null when nowMs is not finite', async () => {
    const asOf = item({ asOf: '2026-11-13T13:05:00.000Z' });
    
    const withInvalidNow = await readFleetRecheck(deps([asOf], {
      now: () => new Date('not-a-date'),
    }));
    expect(withInvalidNow.sections.task.lastVerified).toBeNull();
  });

  it('keeps historical valid completions eligible (no freshness TTL)', async () => {
    const asOf = item({ id: 'historic-done', asOf: '2026-11-13T12:00:00.000Z' });
    
    const historic = await readFleetRecheck(deps([asOf]));
    expect(historic.sections.task.lastVerified?.id).toBe('historic-done');
  });

  it('preserves existing task state/pick/missing semantics', async () => {
    const verifiedItem = item({ 
      id: 'verified-done', 
      asOf: '2026-11-13T13:05:00.000Z',
      state: 'VERIFIED',
      owner: 'agent-alpha',
      claimReceipt: 'bus-claim:fake-done-1:1:1700000000000',
    });
    
    const runningItem = item({ 
      id: 'running-item', 
      state: 'RUNNING',
      asOf: '2026-11-13T13:10:00.000Z',
      owner: 'agent-bravo',
      claimReceipt: 'bus-claim:running-item:1:1700000000000',
    });
    
    const result = await readFleetRecheck(deps([verifiedItem, runningItem], {
      listCoordination: () => ({
        source: 'available',
        claims: [{
          origin: 'message', key: 'queue:running-item', owner: 'agent-bravo',
          leaseUntil: NOW.getTime() + 3_600_000, sourceId: 'running-item:1:1700000000000',
          live: true, repo: null, branch: null, path: null, started: null,
        }],
      }),
    }));
    
    // Verify task state and pick is unaffected by clock bound violations
    expect(result.sections.task.state).toBe('VERIFIED');
    expect(result.sections.task.task?.id).toBe('running-item');
    expect(result.sections.task.missing).toEqual([]);
    expect(result.sections.task.lastVerified?.id).toBe('verified-done');
  });
});
