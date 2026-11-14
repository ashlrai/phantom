/** RQ-PHX-RECHECKREPLY325 — `fleet recheck --reply` formats the fleet.recheck.v1
 * verdict as one paste-ready thread reply: five evidence lines plus a verdict
 * line, capped at 900 characters, never writing 'routed' or 'dispatched'. Every
 * reader is faked here: nothing touches the real home, ledger, bus or network.
 * Fixtures are plainly fake; no message bodies, leases or env values appear. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetRecheck } from '../src/cli/fleet-recheck.js';
import { readFleetRecheck, type FleetRecheck, type FleetRecheckDeps } from '../src/core/fleet/fleet-recheck.js';
import { formatRecheckReply } from '../src/core/fleet/fleet-recheck-reply.js';
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
    listLiveWorkers: async () => emptyWorkers,
    ...over,
  };
}

/** A verdict assembled by hand — never passed through readFleetRecheck's own
 * sanitize pass — so the formatter's redaction is what is under test. */
function handBuilt(over: Partial<FleetRecheck> = {}): FleetRecheck {
  return {
    schema: 'fleet.recheck.v1', asOf: ISO,
    sections: {
      runtime: {
        state: 'VERIFIED', source: 'runtime-identity', asOf: ISO,
        host: 'fake-host', tailnetName: 'fake-tailnet-node',
        installedVersion: '1.2.3', sourceVersion: '1.2.3',
        fleetState: { ageSeconds: 60, stale: false }, missing: [],
      },
      claims: { state: 'VERIFIED', source: 'coordination', asOf: ISO, active: 0, expiredClaims: 0, top: [], missing: [] },
      bridge: {
        state: 'VERIFIED', source: 'channel-health', asOf: ISO,
        channels: [
          { channel: 'slack', state: 'LIVE', runtimeHost: 'fake-host', processAlive: true, missingBridge: null },
          { channel: 'imessage', state: 'LIVE', runtimeHost: 'fake-host', processAlive: true, missingBridge: null },
        ],
        missingBridge: null, missing: [],
      },
      task: {
        state: 'VERIFIED', source: 'work-board', asOf: ISO,
        task: { id: 'fake-request-1', state: 'RUNNING', owner: 'fake-owner-agent', claimReceipt: 'bus-claim:fake-request-1:1:1700000000000', asOf: ISO, source: 'fake-source' },
        unowned: 0, unclaimed: 0, missing: [],
      },
    },
    overall: { state: 'VERIFIED', missing: [] },
    ...over,
  };
}

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  vi.spyOn(console, 'log').mockImplementation((...a) => { out.push(a.join(' ')); });
  vi.spyOn(console, 'error').mockImplementation((...a) => { err.push(a.join(' ')); });
  return { out, err };
}

afterEach(() => vi.restoreAllMocks());

describe('formatRecheckReply', () => {
  it('names the owner and claim and ends with the evidence-only line when all sections verify', async () => {
    const reply = formatRecheckReply(await readFleetRecheck(deps()));
    const lines = reply.split('\n');
    expect(lines).toHaveLength(6);
    expect(lines[0]).toBe(`Phantom recheck VERIFIED · as of ${ISO} · source fleet-recheck`);
    expect(lines[1]).toBe('Runtime: fake-host · 1.2.3 · fleet state 60s (VERIFIED)');
    expect(lines[2]).toBe('Claims: 1 live, top: fake-lane-agent/ashlrai/phantom (VERIFIED)');
    expect(lines[3]).toBe('Bridge: slack LIVE, imessage LIVE (VERIFIED)');
    expect(lines[4]).toBe('Task: fake-request-1 RUNNING · owner fake-owner-agent · claim bus-claim:fake-request-1:1:1700000000000 (VERIFIED)');
    expect(lines[5]).toBe('Evidence only; this reply grants no dispatch.');
  });

  it('names the exact missing bridge and ends with BLOCKED on: when slack is down', async () => {
    const channels: ChannelHealthReport = {
      ...healthyChannels,
      channels: [fakeChannel('slack', {
        state: 'BLOCKED', processAlive: false, runtimeHost: null,
        missing: ['slack bridge process not running'],
      }), fakeChannel('imessage')],
    };
    const reply = formatRecheckReply(await readFleetRecheck(deps({ readChannelHealth: () => channels })));
    const lines = reply.split('\n');
    expect(lines[3]).toBe('Bridge: slack BLOCKED, imessage LIVE · missing: slack bridge process not running (BLOCKED)');
    expect(lines.at(-1)).toMatch(/^BLOCKED on: /);
    expect(lines.at(-1)).toContain('slack bridge process not running');
  });

  it('prints Claims: unknown when the ledger is unreadable', async () => {
    const unreadable: FleetBoard = { ...healthyBoard, state: 'unknown', claims: [], expiredClaims: null };
    const reply = formatRecheckReply(await readFleetRecheck(deps({ readFleetBoard: () => unreadable })));
    expect(reply.split('\n')[2]).toBe('Claims: unknown live, top: none (UNKNOWN)');
    expect(reply.split('\n').at(-1)).toMatch(/^UNKNOWN: /);
  });

  it('redacts home paths, IPv4 addresses and forbidden words even from a hand-built verdict', () => {
    const base = handBuilt();
    const dirty: FleetRecheck = {
      ...base,
      sections: {
        ...base.sections,
        runtime: { ...base.sections.runtime, host: 'fake-host at /Users/fake/x via 10.1.2.3' },
        task: {
          ...base.sections.task,
          task: {
            id: 'fake-9', state: 'RUNNING',
            owner: 'agent-192.168.0.1', claimReceipt: '/home/fakeuser/claims/r1',
            asOf: ISO, source: 'fake-source',
          },
        },
      },
      overall: { state: 'BLOCKED', missing: ['job routed elsewhere', 'worker dispatched already'] },
    };
    const reply = formatRecheckReply(dirty);
    expect(reply).not.toContain('/Users/');
    expect(reply).not.toContain('/home/');
    expect(reply).not.toMatch(/\b\d{1,3}(?:\.\d{1,3}){3}\b/);
    expect(reply).not.toMatch(/\b(?:routed|dispatched)\b/i);
    expect(reply).toContain('[ip]');
    expect(reply.split('\n').at(-1)).toBe('BLOCKED on: job [verb] elsewhere; worker [verb] already');
  });

  it('caps the reply at 900 characters with a trailing ellipsis', () => {
    const reply = formatRecheckReply(handBuilt({
      overall: { state: 'BLOCKED', missing: ['x'.repeat(2000)] },
    }));
    expect(reply).toHaveLength(900);
    expect(reply.endsWith('…')).toBe(true);
  });
});

describe('cmdFleetRecheck --reply', () => {
  it('prints the reply and exits 0', async () => {
    const { out } = capture();
    expect(await cmdFleetRecheck(['--reply'], deps())).toBe(0);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatch(/^Phantom recheck VERIFIED · as of 2026-11-13T12:00:00\.000Z · source fleet-recheck\n/);
  });

  it('exits 2 with usage when --reply and --json combine', async () => {
    const { out, err } = capture();
    expect(await cmdFleetRecheck(['--reply', '--json'], deps())).toBe(2);
    expect(await cmdFleetRecheck(['--json', '--reply'], deps())).toBe(2);
    expect(await cmdFleetRecheck(['--reply', '--reply'], deps())).toBe(2);
    expect(out).toEqual([]);
    expect(err.join('\n')).toContain('Usage: ashlr fleet recheck');
  });
});
