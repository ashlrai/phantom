/** RQ-PHX-RECHECKBRIDGEAGE328S — the bridge section verifies only channel
 * observations captured inside its own reader bound (SECTION_TIMEOUT_MS) of
 * the verdict clock. report.asOf and each required channel's asOf are checked
 * against the captured now: a fresh wrapper cannot launder an old channel
 * observation, and invalid, future or stale timestamps report UNKNOWN with an
 * exact reason while the observed channel state is preserved as evidence.
 * Known missing channels remain BLOCKED. Every reader is faked here: nothing
 * touches the real home, ledger, bus or network. Fixtures are plainly fake;
 * no message bodies, leases or env values appear. */
import { describe, expect, it, vi } from 'vitest';
import { readFleetRecheck, type FleetRecheckDeps } from '../src/core/fleet/fleet-recheck.js';
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
const INSIDE = iso(NOW_MS - 4_000); // inside the 5s observation bound

const healthyRuntime: RuntimeIdentity = {
  host: 'fake-host', platform: 'fakeos', asOf: ISO, installedVersion: '1.2.3', sourceVersion: '1.2.3',
  versionDrift: false, tailnetName: 'fake-tailnet-node', reasons: [],
  fleetState: { path: '~/.ashlr-runs/guardian/state.json', mtime: '2026-11-13T13:12:00.000Z', ageSeconds: 60, stale: false },
};

const healthyBoard: FleetBoard = {
  schema: 'fleet.coordination.v1', state: 'known', messages: [], proposals: [], expiredClaims: 0,
  claims: [{ id: 'fake-claim-1', repo: 'ashlrai/phantom', task: 'fake ledger task',
    agent: 'agent-alpha', claimedAt: NOW_MS - 1_000, expiresAt: NOW_MS + 3_600_000 }],
};

function fakeChannel(channel: 'slack' | 'imessage', over: Partial<ChannelHealth> = {}): ChannelHealth {
  return {
    channel, configured: true, processAlive: true, runtimeHost: 'fake-host',
    lastInboundAt: null, lastReplyAt: null, unansweredCount: 0, state: 'LIVE', missing: [], asOf: ISO,
    proof: { requestCoverage: 'idle', futureDatedCount: 0 }, ...over,
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
    readRuntimeIdentity: () => healthyRuntime, readFleetBoard: () => healthyBoard,
    readChannelHealth: () => healthyChannels, ...over,
  };
}

function channelsReport(reportAsOf: string, slackAsOf = reportAsOf, imessageAsOf = reportAsOf): ChannelHealthReport {
  return {
    schemaVersion: 1, asOf: reportAsOf,
    channels: [fakeChannel('slack', { asOf: slackAsOf }), fakeChannel('imessage', { asOf: imessageAsOf })],
  };
}

describe('fleet recheck bridge observation freshness', () => {
  it('verifies a fresh report with fresh channel observations', async () => {
    const recheck = await readFleetRecheck(deps());
    expect(recheck.sections.bridge).toMatchObject({ state: 'VERIFIED', missingBridge: null, missing: [], asOf: ISO });
    expect(recheck.sections.bridge.channels).toEqual([
      { channel: 'slack', state: 'LIVE', runtimeHost: 'fake-host', processAlive: true, missingBridge: null },
      { channel: 'imessage', state: 'LIVE', runtimeHost: 'fake-host', processAlive: true, missingBridge: null },
    ]);
  });

  it('verifies observations inside the bound that are not stamped exactly at now', async () => {
    const recheck = await readFleetRecheck(deps({ readChannelHealth: () => channelsReport(INSIDE) }));
    expect(recheck.sections.bridge.state).toBe('VERIFIED');
  });

  it('a fresh report.asOf cannot launder an old slack observation', async () => {
    const recheck = await readFleetRecheck(deps({ readChannelHealth: () => channelsReport(ISO, STALE, ISO) }));
    const bridge = recheck.sections.bridge;
    expect(bridge.state).toBe('UNKNOWN');
    expect(bridge.missingBridge).toBe('bridge: slack channel asOf stale (30s old)');
    // The observed state stays as evidence; only verification is refused.
    expect(bridge.channels[0]).toMatchObject({ channel: 'slack', state: 'LIVE', runtimeHost: 'fake-host' });
    // The healthy channel's evidence is untouched.
    expect(bridge.channels[1]).toMatchObject({ channel: 'imessage', state: 'LIVE', missingBridge: null });
    expect(recheck.overall.state).toBe('UNKNOWN');
  });

  it('a stale report.asOf does not verify even when channel asOf is fresh', async () => {
    const recheck = await readFleetRecheck(deps({ readChannelHealth: () => channelsReport(STALE, ISO, ISO) }));
    expect(recheck.sections.bridge.state).toBe('UNKNOWN');
    expect(recheck.sections.bridge.missingBridge).toBe('bridge: channel-health report asOf stale (30s old)');
  });

  it('future-dated report and channel timestamps do not verify', async () => {
    const futureReport = await readFleetRecheck(deps({ readChannelHealth: () => channelsReport(FUTURE) }));
    expect(futureReport.sections.bridge.state).toBe('UNKNOWN');
    expect(futureReport.sections.bridge.missingBridge).toBe('bridge: channel-health report asOf in the future');
    const futureChannel = await readFleetRecheck(deps({ readChannelHealth: () => channelsReport(ISO, ISO, FUTURE) }));
    expect(futureChannel.sections.bridge.state).toBe('UNKNOWN');
    expect(futureChannel.sections.bridge.missing).toContain('bridge: imessage channel asOf in the future');
  });

  it('malformed report and channel timestamps do not verify', async () => {
    const badReport = await readFleetRecheck(deps({ readChannelHealth: () => channelsReport('not-a-timestamp') }));
    expect(badReport.sections.bridge.state).toBe('UNKNOWN');
    expect(badReport.sections.bridge.missingBridge).toBe('bridge: channel-health report asOf malformed');
    const badChannel = await readFleetRecheck(deps({ readChannelHealth: () => channelsReport(ISO, '', ISO) }));
    expect(badChannel.sections.bridge.state).toBe('UNKNOWN');
    expect(badChannel.sections.bridge.missing).toContain('bridge: slack channel asOf malformed');
    expect(badChannel.sections.bridge.channels[1]).toMatchObject({ channel: 'imessage', missingBridge: null });
  });

  it('one stale channel does not erase the other channel evidence', async () => {
    const bridge = (await readFleetRecheck(deps({ readChannelHealth: () => channelsReport(ISO, STALE, ISO) })))
      .sections.bridge;
    expect(bridge.state).toBe('UNKNOWN');
    expect(bridge.channels).toEqual([
      { channel: 'slack', state: 'LIVE', runtimeHost: 'fake-host', processAlive: true,
        missingBridge: 'bridge: slack channel asOf stale (30s old)' },
      { channel: 'imessage', state: 'LIVE', runtimeHost: 'fake-host', processAlive: true, missingBridge: null },
    ]);
    expect(bridge.missing).toEqual(['bridge: slack channel asOf stale (30s old)']);
  });

  it('known missing channels remain BLOCKED even when freshness also fails', async () => {
    // Slack absent from a stale-dated report: the identified gap stays BLOCKED.
    const report: ChannelHealthReport = { schemaVersion: 1, asOf: STALE, channels: [fakeChannel('imessage')] };
    const bridge = (await readFleetRecheck(deps({ readChannelHealth: () => report }))).sections.bridge;
    expect(bridge.state).toBe('BLOCKED');
    expect(bridge.missing).toEqual(['slack bridge evidence absent', 'bridge: channel-health report asOf stale (30s old)']);
    // A content-level gap also stays BLOCKED under a malformed report clock.
    const blocked: ChannelHealthReport = {
      schemaVersion: 1, asOf: 'garbage',
      channels: [
        fakeChannel('slack', { state: 'BLOCKED', processAlive: false, runtimeHost: null,
          missing: ['slack bridge process not running'] }),
        fakeChannel('imessage'),
      ],
    };
    const second = (await readFleetRecheck(deps({ readChannelHealth: () => blocked }))).sections.bridge;
    expect(second.state).toBe('BLOCKED');
    expect(second.missingBridge).toBe('slack bridge process not running');
  });

  it('an unreadable verdict clock makes freshness unverifiable, never VERIFIED', async () => {
    const recheck = await readFleetRecheck(deps({ now: () => new Date(Number.NaN) }));
    expect(recheck.sections.bridge.state).toBe('UNKNOWN');
    expect(recheck.sections.bridge.missing)
      .toContain('bridge: verdict clock unknown, observation freshness unverifiable');
    expect(recheck.sections.bridge.channels).toHaveLength(2);
    expect(recheck.overall.state).not.toBe('VERIFIED');
  });

  it('reads the channel-health report exactly once and preserves the task refusal', async () => {
    const readChannelHealth = vi.fn(() => channelsReport(ISO, STALE, ISO));
    const recheck = await readFleetRecheck(deps({ readChannelHealth }));
    expect(readChannelHealth).toHaveBeenCalledTimes(1);
    expect(recheck.sections.bridge.state).toBe('UNKNOWN');
    expect(recheck.sections.task.state).toBe('UNKNOWN');
    expect(recheck.sections.task.task?.ledgerClaim).toBeNull();
  });
});
