/** RQ-PHX-RECHECKLASTVERIFIED333 — the task section reports the newest
 * VERIFIED work-board item as lastVerified evidence without changing state,
 * pick or missing[]. Every reader is faked; nothing touches the real home. */
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
    ...over,
  };
}

describe('fleet recheck task.lastVerified', () => {
  it('names a lone VERIFIED item while the task stays BLOCKED with the same missing', async () => {
    const withDone = (await readFleetRecheck(deps([item()]))).sections.task;
    const empty = (await readFleetRecheck(deps([]))).sections.task;
    expect(withDone.state).toBe('BLOCKED');
    expect(withDone.task).toBeNull();
    expect(withDone.missing).toEqual(empty.missing);
    expect(withDone.missing).toEqual(['task: no RUNNING or ASSIGNED board item']);
    expect(withDone.lastVerified).toEqual({
      id: 'fake-done-1', owner: 'agent-alpha', claimReceipt: 'bus-claim:fake-done-1:1:1700000000000',
      asOf: '2026-11-13T13:05:00.000Z', source: 'bus-reply:fake-reply-1',
    });
    expect(empty.lastVerified).toBeNull();
  });

  it('prefers the newer asOf and ignores VERIFIED items lacking owner or receipt', async () => {
    const task = (await readFleetRecheck(deps([
      item({ id: 'fake-old', asOf: '2026-11-13T12:00:00.000Z' }),
      item({ id: 'fake-new', asOf: '2026-11-13T13:10:00.000Z', source: 'bus-reply:fake-reply-2' }),
      item({ id: 'fake-noowner', asOf: '2026-11-13T13:11:00.000Z', owner: undefined }),
      item({ id: 'fake-noreceipt', asOf: '2026-11-13T13:12:00.000Z', claimReceipt: undefined }),
      item({ id: 'fake-badtime', asOf: 'not-a-date' }),
    ]))).sections.task;
    expect(task.lastVerified?.id).toBe('fake-new');
    expect(task.lastVerified?.source).toBe('bus-reply:fake-reply-2');
  });

  it('leaves pick and state untouched when a RUNNING item sits beside a VERIFIED one', async () => {
    const running = item({
      id: 'fake-run-1', state: 'RUNNING', asOf: ISO, source: 'bus-work-claims lease-until fake',
      claimReceipt: 'bus-claim:fake-run-1:2:1700000000001',
    });
    const alone = (await readFleetRecheck(deps([running]))).sections.task;
    const both = (await readFleetRecheck(deps([item(), running]))).sections.task;
    expect(both.state).toBe(alone.state);
    expect(both.task).toEqual(alone.task);
    expect(both.task?.id).toBe('fake-run-1');
    expect(both.missing).toEqual(alone.missing);
    expect(both.lastVerified?.id).toBe('fake-done-1');
    expect(alone.lastVerified).toBeNull();
  });

  it('is null when the inbox is unavailable or the reader throws', async () => {
    const unavailable = await readFleetRecheck(deps([item()], {
      listWorkBoard: (): WorkBoardResult => ({ items: [item()], inbox: 'unavailable', truncated: false }),
    }));
    expect(unavailable.sections.task.lastVerified).toBeNull();
    const thrown = await readFleetRecheck(deps([], {
      listWorkBoard: () => { throw new Error('fake reader failure'); },
    }));
    expect(thrown.sections.task.state).toBe('UNKNOWN');
    expect(thrown.sections.task.lastVerified).toBeNull();
  });

  it('redacts the home dir inside lastVerified.source', async () => {
    const task = (await readFleetRecheck(deps([item({ source: `bus-reply:${HOME}/fake/reply` })]))).sections.task;
    expect(task.lastVerified?.source).toBe('bus-reply:~/fake/reply');
    expect(JSON.stringify(task)).not.toContain(HOME);
  });
});
