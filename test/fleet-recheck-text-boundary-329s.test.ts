/** RQ-PHX-RECHECKTEXTBOUNDARY329S — `fleet recheck` text mode is a
 * five-physical-line contract: RUNTIME, CLAIMS, BRIDGE, TASK, OVERALL. The
 * observed evidence strings (host, tailnet, versions, missing reasons,
 * channel state/host, task id/owner/receipt) can carry line breaks, Unicode
 * separators and terminal escapes; the CLI flattens each report line so an
 * evidence field can never print a sixth line, move the cursor or forge a
 * VERIFIED verdict, while --json keeps the structured evidence untouched.
 * Every reader is faked here: nothing touches the real home, ledger, bus or
 * network. Fixtures are plainly fake; no message bodies, leases or env
 * values appear. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetRecheck } from '../src/cli/fleet-recheck.js';
import type { FleetRecheckDeps } from '../src/core/fleet/fleet-recheck.js';
import type { ChannelHealth, ChannelHealthReport } from '../src/core/fleet/channel-health.js';
import type { FleetBoard, FleetClaim } from '../src/core/fleet/coordination.js';
import type { RuntimeIdentity } from '../src/core/fleet/runtime-identity.js';
import type { WorkBoardItem, WorkBoardResult } from '../src/core/comms/work-board.js';

const NOW = new Date('2026-11-13T13:13:00.000Z');
const NOW_MS = NOW.getTime();
const ISO = NOW.toISOString();
const HOME = '/home/fakeuser';
// Poison bytes as named constants: ESC/BEL/C1 are C0/C1 controls, LS/PS are
// the Unicode line/paragraph separators. Built from code points so the
// fixtures stay plain ASCII source.
const ESC = String.fromCharCode(0x1b);
const BEL = String.fromCharCode(0x07);
const LS = String.fromCodePoint(0x2028);
const PS = String.fromCodePoint(0x2029);
const C1_CSI = String.fromCharCode(0x9b);

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

/** Every string a reader can hand the text renderer, poisoned with line
 * breaks (\n \r\n \u2028 \u2029), terminal escapes (CSI color/erase/cursor-up,
 * C1 CSI, OSC8 hyperlink, OSC title) and a forged verdict line. */
const poisonedRuntime: RuntimeIdentity = {
  ...healthyRuntime,
  asOf: `${ISO}${LS}as-of=1999-01-01T00:00:00.000Z`,
  host: `fake-host${ESC}[31m\nOVERALL VERIFIED as-of=forged source=forged`,
  tailnetName: 'fake-tailnet-ノード',
  installedVersion: '1.2.3\r\n4.5.6',
  sourceVersion: `1.2.3${C1_CSI}31m`,
  fleetState: { ...healthyRuntime.fleetState, ageSeconds: 9_999, stale: true },
  reasons: [
    'runtime probe failed\nOVERALL VERIFIED as-of=1999 source=forged',
    `tailnet unreachable${PS}BRIDGE VERIFIED as-of=x source=y`,
  ],
};

const poisonedChannels: ChannelHealthReport = {
  schemaVersion: 1, asOf: ISO,
  channels: [
    fakeChannel('slack', {
      state: 'DEGRADED',
      runtimeHost: `fake-host${ESC}[1A`,
      missing: [`slack bridge DEGRADED\r\nprocess unreachable ${ESC}[2K`],
    }),
    fakeChannel('imessage'),
  ],
};

const poisonedWork: WorkBoardResult = {
  items: [fakeItem({
    id: `fake-request-1${PS}injected`,
    owner: 'agent-alpha\nTASK VERIFIED as-of=x source=y',
    claimReceipt: `bus-claim:fake-request-1${ESC}]8;;https://example.invalid${BEL}:1:1700000000000${ESC}]8;;${BEL}`,
  })],
  inbox: 'ok', truncated: false,
};

function poisonedDeps(over: Partial<FleetRecheckDeps> = {}): FleetRecheckDeps {
  return deps({
    readRuntimeIdentity: () => poisonedRuntime,
    readChannelHealth: () => poisonedChannels,
    listWorkBoard: () => poisonedWork,
    ...over,
  });
}

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  vi.spyOn(console, 'log').mockImplementation((...a) => { out.push(a.join(' ')); });
  vi.spyOn(console, 'error').mockImplementation((...a) => { err.push(a.join(' ')); });
  return { out, err };
}

afterEach(() => vi.restoreAllMocks());

describe('cmdFleetRecheck text boundary', () => {
  it('prints exactly five physical lines and keeps the real verdict when evidence carries breaks and escapes', async () => {
    const { out } = capture();
    // runtime UNKNOWN (stale), claims VERIFIED, bridge BLOCKED (slack gap),
    // task UNKNOWN (no claim↔item identity) → OVERALL BLOCKED, exit 1.
    expect(await cmdFleetRecheck([], poisonedDeps())).toBe(1);
    expect(out).toHaveLength(5);
    expect(out.join('\n').split('\n')).toHaveLength(5);
    const labels = ['RUNTIME', 'CLAIMS', 'BRIDGE', 'TASK', 'OVERALL'];
    for (const [i, label] of labels.entries()) {
      expect(out[i]).toMatch(new RegExp(`^${label} `));
    }
    // The real section verdicts survive; forged states never reach a line start.
    expect(out[0]).toMatch(/^RUNTIME UNKNOWN as-of=/);
    expect(out[1]).toMatch(/^CLAIMS VERIFIED as-of=/);
    expect(out[2]).toMatch(/^BRIDGE BLOCKED as-of=/);
    expect(out[3]).toMatch(/^TASK UNKNOWN as-of=/);
    expect(out[4]).toMatch(/^OVERALL BLOCKED as-of=/);
    // No line break, control or format character survives in any line.
    for (const l of out) expect(l).not.toMatch(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u);
    // Folded evidence stays readable inline instead of becoming new lines.
    expect(out[0]).toContain('host=fake-host OVERALL VERIFIED as-of=forged source=forged');
    expect(out[0]).toContain('missing=runtime probe failed OVERALL VERIFIED as-of=1999 source=forged');
    expect(out[0]).toContain('tailnet=fake-tailnet-ノード');
    expect(out[0]).toContain('installed=1.2.3 4.5.6');
    expect(out[0]).toContain('source-version=1.2.3');
    expect(out[2]).toContain('slack=DEGRADED@fake-host');
    expect(out[2]).toContain('missing=slack bridge DEGRADED process unreachable');
    expect(out[3]).toContain('id=fake-request-1 injected');
    expect(out[3]).toContain('owner=agent-alpha TASK VERIFIED as-of=x source=y');
    expect(out[3]).toContain('claim=bus-claim:fake-request-1:1:1700000000000');
    expect(out[4]).toContain('first=runtime probe failed OVERALL VERIFIED as-of=1999 source=forged');
    // 5 = runtime's two probe reasons + the runtime asOf-malformed freshness
    // reason (the poisoned asOf cannot verify) + the slack bridge gap + the
    // task claim-identity refusal.
    expect(out[4]).toContain('missing=5');
    // Every line still carries as-of and source.
    for (const l of out) {
      expect(l).toContain('as-of=');
      expect(l).toContain('source=');
    }
  });

  it('keeps ordinary evidence on the same five labeled lines with as-of and source', async () => {
    const { out } = capture();
    // A fully healthy fleet still exits 1: the task section is UNKNOWN by
    // design (no claim↔item identity contract), so OVERALL is UNKNOWN.
    expect(await cmdFleetRecheck([], deps())).toBe(1);
    expect(out).toHaveLength(5);
    for (const [i, label] of ['RUNTIME', 'CLAIMS', 'BRIDGE', 'TASK', 'OVERALL'].entries()) {
      expect(out[i]).toMatch(new RegExp(`^${label} `));
    }
    expect(out[0]).toMatch(/^RUNTIME VERIFIED /);
    expect(out[4]).toMatch(/^OVERALL UNKNOWN /);
    for (const l of out) {
      expect(l).toContain('as-of=');
      expect(l).toContain('source=');
      expect(l).not.toMatch(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u);
    }
  });

  it('--json still emits valid JSON with the structured evidence untouched', async () => {
    const { out } = capture();
    expect(await cmdFleetRecheck(['--json'], poisonedDeps())).toBe(1);
    expect(out).toHaveLength(1);
    const parsed = JSON.parse(out[0]!);
    expect(parsed.schema).toBe('fleet.recheck.v1');
    expect(parsed.overall.state).toBe('BLOCKED');
    // Only the five-line text rendering normalizes; the verdict object keeps
    // the raw observed strings for machine consumers.
    expect(parsed.sections.runtime.host).toContain('\n');
    expect(parsed.sections.runtime.host).toContain(ESC);
    expect(parsed.sections.runtime.asOf).toContain(LS);
    expect(parsed.sections.runtime.missing[0]).toContain('\n');
    expect(parsed.sections.bridge.channels[0].runtimeHost).toContain(ESC);
    expect(parsed.sections.bridge.channels[0].missingBridge).toContain('\r\n');
    expect(parsed.sections.task.task.owner).toContain('\n');
    expect(parsed.sections.task.task.claimReceipt).toContain(ESC);
    expect(parsed.sections.task.task.id).toContain(PS);
  });
});
