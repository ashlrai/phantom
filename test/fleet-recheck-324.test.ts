/** RQ-PHX-FLEETRECHECK324 — `fleet recheck` joins four readers into one
 * sanitized read-only verdict. Every reader is faked here: nothing touches the
 * real home, ledger, bus or network. Fixtures are plainly fake; no message
 * bodies, leases or env values appear. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetRecheck } from '../src/cli/fleet-recheck.js';
import { FLEET_SUBCOMMAND_LOADERS } from '../src/cli/fleet-subcommand-registry.js';
import { readFleetRecheck, type FleetRecheckDeps } from '../src/core/fleet/fleet-recheck.js';
import type { ChannelHealth, ChannelHealthReport } from '../src/core/fleet/channel-health.js';
import type { FleetBoard } from '../src/core/fleet/coordination.js';
import type { RuntimeIdentity } from '../src/core/fleet/runtime-identity.js';
import type { WorkBoardItem, WorkBoardResult } from '../src/core/comms/work-board.js';
import type { CoordinationView } from '../src/core/agents/claim-store.js';
import type { LiveWorkersSnapshot } from '../src/core/fleet/runs-live-workers.js';

const NOW = new Date('2026-11-13T12:00:00.000Z');
const NOW_MS = NOW.getTime();
const ISO = NOW.toISOString();
const HOME = '/home/fakeuser';

const healthyRuntime: RuntimeIdentity = {
  host: 'fake-host', platform: 'fakeos', asOf: ISO,
  installedVersion: '1.2.3', sourceVersion: '1.2.3', versionDrift: false,
  fleetState: { path: '~/.ashlr-runs/guardian/state.json', mtime: '2026-11-13T11:59:00.000Z', ageSeconds: 60, stale: false },
  tailnetName: 'fake-tailnet-node', reasons: [],
};

const healthyBoard: FleetBoard = {
  schema: 'fleet.coordination.v1', state: 'known',
  claims: [{
    id: 'fake-claim-1', repo: 'ashlrai/phantom', task: 'fake recheck task',
    agent: 'fake-lane-agent', claimedAt: NOW_MS - 1_000, expiresAt: NOW_MS + 3_600_000,
  }, {
    // Live claim for the work-board owner; the task↔ledger join requires one.
    id: 'fake-claim-2', repo: 'ashlrai/phantom', task: 'fake owner task',
    agent: 'fake-owner-agent', claimedAt: NOW_MS - 2_000, expiresAt: NOW_MS + 3_600_000,
  }],
  messages: [], proposals: [], expiredClaims: 2,
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
    receivedAt: '2026-11-13T11:58:00.000Z', state: 'RUNNING', asOf: ISO,
    source: 'bus-work-claims lease-until 2026-11-13T12:10:00.000Z', missing: [],
    owner: 'fake-owner-agent', claimReceipt: 'bus-claim:fake-request-1:1:1700000000000', ...over,
  };
}

const healthyWork: WorkBoardResult = { items: [fakeItem()], inbox: 'ok', truncated: false };

// The claim-store row bus-work-claims writes when the pick's bus claim is
// acquired: message origin, queue:<id> key, receipt coordinates as sourceId,
// same owner, lease live at the verdict clock.
const coordRow: CoordinationView = {
  origin: 'message', key: 'queue:fake-request-1', owner: 'fake-owner-agent',
  leaseUntil: NOW_MS + 3_600_000, sourceId: 'fake-request-1:1:1700000000000',
  live: true, repo: null, branch: null, path: null, started: null,
};

const emptyWorkers: LiveWorkersSnapshot = {
  v: 1, generatedAt: ISO, sourceState: 'healthy', workers: [], leaders: [], orchestratorAgents: 0,
};

function deps(over: Partial<FleetRecheckDeps> = {}): FleetRecheckDeps {
  return {
    now: () => NOW,
    homeDir: () => HOME,
    readRuntimeIdentity: () => healthyRuntime,
    readFleetBoard: () => healthyBoard,
    readChannelHealth: () => healthyChannels,
    listWorkBoard: () => healthyWork,
    listCoordination: () => ({ source: 'available', claims: [coordRow] }),
    listLiveWorkers: () => emptyWorkers,
    ...over,
  };
}

afterEach(() => vi.restoreAllMocks());

describe('readFleetRecheck', () => {
  it('returns the same verdict for synchronous and asynchronous readers', async () => {
    const synchronous = await readFleetRecheck(deps());
    const asynchronous = await readFleetRecheck(deps({
      readRuntimeIdentity: async () => healthyRuntime,
      readFleetBoard: async () => healthyBoard,
      readChannelHealth: async () => healthyChannels,
      listWorkBoard: async () => healthyWork,
      listCoordination: async () => ({ source: 'available', claims: [coordRow] }),
      listLiveWorkers: async () => emptyWorkers,
    }));
    expect(asynchronous).toEqual(synchronous);
  });

  it('verifies all four sections when every reader is healthy', async () => {
    const recheck = await readFleetRecheck(deps());
    expect(recheck.schema).toBe('fleet.recheck.v1');
    expect(recheck.asOf).toBe(ISO);
    expect(recheck.sections.runtime).toMatchObject({
      state: 'VERIFIED', host: 'fake-host', tailnetName: 'fake-tailnet-node',
      installedVersion: '1.2.3', sourceVersion: '1.2.3',
      fleetState: { ageSeconds: 60, stale: false }, missing: [],
    });
    expect(recheck.sections.claims).toMatchObject({
      state: 'VERIFIED', active: 2, expiredClaims: 2, missing: [],
    });
    expect(recheck.sections.claims.top).toEqual([{
      agent: 'fake-lane-agent', repo: 'ashlrai/phantom', task: 'fake recheck task',
      expiresAt: new Date(NOW_MS + 3_600_000).toISOString(),
    }, {
      agent: 'fake-owner-agent', repo: 'ashlrai/phantom', task: 'fake owner task',
      expiresAt: new Date(NOW_MS + 3_600_000).toISOString(),
    }]);
    expect(recheck.sections.bridge).toMatchObject({ state: 'VERIFIED', missingBridge: null, missing: [] });
    expect(recheck.sections.bridge.channels).toEqual([
      { channel: 'slack', state: 'LIVE', runtimeHost: 'fake-host', processAlive: true, missingBridge: null },
      { channel: 'imessage', state: 'LIVE', runtimeHost: 'fake-host', processAlive: true, missingBridge: null },
    ]);
    expect(recheck.sections.task).toMatchObject({
      state: 'VERIFIED', unowned: 0, unclaimed: 0, missing: [],
      task: { id: 'fake-request-1', state: 'RUNNING', owner: 'fake-owner-agent' },
    });
    expect(recheck.overall).toEqual({ state: 'VERIFIED', missing: [] });
  });

  it('marks runtime UNKNOWN on a stale fleet-state read', async () => {
    const stale: RuntimeIdentity = {
      ...healthyRuntime,
      fleetState: { ...healthyRuntime.fleetState, ageSeconds: 1200, stale: true },
    };
    const recheck = await readFleetRecheck(deps({ readRuntimeIdentity: () => stale }));
    expect(recheck.sections.runtime.state).toBe('UNKNOWN');
    expect(recheck.sections.runtime.missing.join('\n')).toContain('fleetState');
    expect(recheck.overall.state).not.toBe('VERIFIED');
  });

  it('marks runtime UNKNOWN when the host is unknown', async () => {
    const recheck = await readFleetRecheck(deps({
      readRuntimeIdentity: () => ({ ...healthyRuntime, host: 'unknown', reasons: ['host: hostname unavailable'] }),
    }));
    expect(recheck.sections.runtime.state).toBe('UNKNOWN');
    expect(recheck.sections.runtime.missing).toContain('host: hostname unavailable');
  });

  it('marks claims UNKNOWN on an unreadable ledger instead of claiming zero claims', async () => {
    const unreadable: FleetBoard = { ...healthyBoard, state: 'unknown', claims: [], expiredClaims: null };
    const recheck = await readFleetRecheck(deps({ readFleetBoard: () => unreadable }));
    expect(recheck.sections.claims.state).toBe('UNKNOWN');
    expect(recheck.sections.claims.active).toBeNull();
    expect(recheck.sections.claims.expiredClaims).toBeNull();
    expect(recheck.overall.state).toBe('UNKNOWN');
  });

  it('an empty but readable ledger still verifies claims', async () => {
    const empty: FleetBoard = { ...healthyBoard, claims: [], expiredClaims: 0 };
    const recheck = await readFleetRecheck(deps({ readFleetBoard: () => empty }));
    expect(recheck.sections.claims).toMatchObject({ state: 'VERIFIED', active: 0, expiredClaims: 0, top: [] });
  });

  it('marks the bridge BLOCKED with the exact missing string when slack is not LIVE', async () => {
    const channels: ChannelHealthReport = {
      ...healthyChannels,
      channels: [fakeChannel('slack', {
        state: 'BLOCKED', processAlive: false, runtimeHost: null,
        missing: ['slack bridge process not running'],
      }), fakeChannel('imessage')],
    };
    const recheck = await readFleetRecheck(deps({ readChannelHealth: () => channels }));
    expect(recheck.sections.bridge.state).toBe('BLOCKED');
    expect(recheck.sections.bridge.missingBridge).toBe('slack bridge process not running');
    expect(recheck.sections.bridge.channels[0]).toMatchObject({
      channel: 'slack', state: 'BLOCKED', runtimeHost: null, processAlive: false,
      missingBridge: 'slack bridge process not running',
    });
    expect(recheck.sections.bridge.channels[1]).toMatchObject({ channel: 'imessage', missingBridge: null });
    expect(JSON.stringify(recheck.sections.bridge)).not.toContain('routed');
    expect(recheck.overall.state).toBe('BLOCKED');
  });

  it('marks the bridge BLOCKED when slack is LIVE but reports no runtime host', async () => {
    const channels: ChannelHealthReport = {
      ...healthyChannels,
      channels: [fakeChannel('slack', { runtimeHost: null }), fakeChannel('imessage')],
    };
    const recheck = await readFleetRecheck(deps({ readChannelHealth: () => channels }));
    expect(recheck.sections.bridge.state).toBe('BLOCKED');
    expect(recheck.sections.bridge.missingBridge).toContain('slack');
  });

  it('never picks an ASSIGNED item that lacks a claim receipt', async () => {
    const work: WorkBoardResult = {
      inbox: 'ok', truncated: false,
      items: [fakeItem({ state: 'ASSIGNED', claimReceipt: null, missing: ['durable claim receipt'] })],
    };
    const recheck = await readFleetRecheck(deps({ listWorkBoard: () => work }));
    expect(recheck.sections.task.state).toBe('BLOCKED');
    expect(recheck.sections.task.task).toBeNull();
    expect(recheck.sections.task.unclaimed).toBe(1);
    expect(recheck.sections.task.missing.join('\n')).toContain('claim receipt');
    expect(recheck.overall.state).toBe('BLOCKED');
  });

  it('never picks a RUNNING item that lacks a named owner', async () => {
    const work: WorkBoardResult = {
      inbox: 'ok', truncated: false,
      items: [fakeItem({ owner: null, missing: ['named owner'] })],
    };
    const recheck = await readFleetRecheck(deps({ listWorkBoard: () => work }));
    expect(recheck.sections.task.state).toBe('BLOCKED');
    expect(recheck.sections.task.task).toBeNull();
    expect(recheck.sections.task.unowned).toBe(1);
  });

  it('prefers the newest RUNNING item and accepts ASSIGNED when nothing runs', async () => {
    const work: WorkBoardResult = {
      inbox: 'ok', truncated: false,
      items: [
        fakeItem({ id: 'new-assigned', state: 'ASSIGNED', receivedAt: '2026-11-13T11:59:00.000Z' }),
        fakeItem({ id: 'old-running', state: 'RUNNING', receivedAt: '2026-11-13T11:50:00.000Z' }),
      ],
    };
    const recheck = await readFleetRecheck(deps({ listWorkBoard: () => work }));
    expect(recheck.sections.task.task).toMatchObject({ id: 'old-running', state: 'RUNNING' });
  });

  it('marks task BLOCKED when the board inbox is unavailable', async () => {
    const recheck = await readFleetRecheck(deps({
      listWorkBoard: () => ({ items: [], inbox: 'unavailable', truncated: false }),
    }));
    expect(recheck.sections.task.state).toBe('BLOCKED');
    expect(recheck.sections.task.missing.join('\n')).toContain('inbox unavailable');
  });

  it('a throwing ledger reader marks claims UNKNOWN and the owner claim unverified', async () => {
    const recheck = await readFleetRecheck(deps({
      readFleetBoard: () => { throw new Error('ledger exploded'); },
      // With no claim-store binding the owner claim cannot be proven either.
      listCoordination: () => ({ source: 'unavailable', claims: [] }),
    }));
    expect(recheck.sections.claims).toMatchObject({
      state: 'UNKNOWN', active: null, expiredClaims: null, top: [], missing: ['claims: reader failed'],
    });
    expect(recheck.sections.runtime.state).toBe('VERIFIED');
    expect(recheck.sections.bridge.state).toBe('VERIFIED');
    // The task pick survives but its owner claim can no longer be proven.
    expect(recheck.sections.task.state).toBe('UNKNOWN');
    expect(recheck.overall.state).toBe('UNKNOWN');
    expect(recheck.overall.missing).toContain('claims: reader failed');
  });

  it('a throwing channel reader marks only the bridge section UNKNOWN', async () => {
    const recheck = await readFleetRecheck(deps({
      readChannelHealth: () => { throw new Error('pgrep exploded'); },
    }));
    expect(recheck.sections.bridge).toMatchObject({
      state: 'UNKNOWN', channels: [], missingBridge: null, missing: ['bridge: reader failed'],
    });
    expect(recheck.overall.state).toBe('UNKNOWN');
  });

  it('sanitizes home paths and IP addresses out of the whole verdict', async () => {
    const dirty: RuntimeIdentity = {
      ...healthyRuntime,
      host: `${HOME}-box`,
      tailnetName: 'node-10.1.2.3',
    };
    const work: WorkBoardResult = {
      inbox: 'ok', truncated: false,
      items: [fakeItem({ source: `read ${HOME}/.ashlr/fleet from 192.168.0.1` })],
    };
    const recheck = await readFleetRecheck(deps({
      readRuntimeIdentity: () => dirty,
      listWorkBoard: () => work,
    }));
    const text = JSON.stringify(recheck);
    expect(text).not.toContain(HOME);
    expect(text).not.toContain('10.1.2.3');
    expect(text).not.toContain('192.168.0.1');
    expect(text).toContain('[ip]');
  });
});

describe('cmdFleetRecheck', () => {
  function capture() {
    const out: string[] = [];
    const err: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...a) => { out.push(a.join(' ')); });
    vi.spyOn(console, 'error').mockImplementation((...a) => { err.push(a.join(' ')); });
    return { out, err };
  }

  it('prints the verdict object with --json and exits 0 when verified', async () => {
    const { out } = capture();
    expect(await cmdFleetRecheck(['--json'], deps())).toBe(0);
    const parsed = JSON.parse(out.join('\n'));
    expect(parsed.schema).toBe('fleet.recheck.v1');
    expect(parsed.overall.state).toBe('VERIFIED');
    expect(Object.keys(parsed.sections)).toEqual(['runtime', 'claims', 'bridge', 'task']);
  });

  it('prints exactly five RUNTIME|CLAIMS|BRIDGE|TASK|OVERALL lines in text mode', async () => {
    const { out } = capture();
    expect(await cmdFleetRecheck([], deps())).toBe(0);
    expect(out).toHaveLength(5);
    for (const [i, label] of ['RUNTIME', 'CLAIMS', 'BRIDGE', 'TASK', 'OVERALL'].entries()) {
      expect(out[i]).toMatch(new RegExp(`^${label} VERIFIED as-of=`));
      expect(out[i]).toContain('source=');
    }
  });

  it('exits 1 when any section is not verified', async () => {
    const { out } = capture();
    expect(await cmdFleetRecheck([], deps({
      readFleetBoard: () => { throw new Error('x'); },
    }))).toBe(1);
    expect(out.at(-1)).toMatch(/^OVERALL UNKNOWN /);
  });

  it('exits 2 on bad arguments and prints nothing to stdout', async () => {
    const { out, err } = capture();
    for (const args of [['--bogus'], ['--json', '--json'], ['extra'], ['--json', 'tail']]) {
      expect(await cmdFleetRecheck(args, deps())).toBe(2);
    }
    expect(out).toEqual([]);
    expect(err.length).toBeGreaterThan(0);
  });

  it('--help prints usage and exits 0 without touching readers', async () => {
    const { out } = capture();
    const readFleetBoard = vi.fn(() => { throw new Error('must not be called'); });
    expect(await cmdFleetRecheck(['--help'], deps({ readFleetBoard }))).toBe(0);
    expect(out.join('\n')).toContain('Usage: ashlr fleet recheck');
    expect(readFleetBoard).not.toHaveBeenCalled();
  });

  it('is registered for dispatch under the convention name', async () => {
    const mod = await FLEET_SUBCOMMAND_LOADERS['recheck']!();
    expect(mod.cmdFleetRecheck).toBe(cmdFleetRecheck);
  });
});
