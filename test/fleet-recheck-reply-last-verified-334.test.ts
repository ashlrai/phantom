/** RQ-PHX-RECHECKREPLYLASTDONE334 — the thread reply carries task.lastVerified
 * as one evidence-only line. Every reader is faked; nothing touches the real home. */
import { describe, expect, it } from 'vitest';
import { readFleetRecheck, type FleetRecheck, type FleetRecheckDeps } from '../src/core/fleet/fleet-recheck.js';
import { formatRecheckReply } from '../src/core/fleet/fleet-recheck-reply.js';
import { recheckReplyWithRecord } from '../src/core/agents/owner-status-reply.js';
import type { ChannelHealth, ChannelHealthReport } from '../src/core/fleet/channel-health.js';
import type { FleetBoard } from '../src/core/fleet/coordination.js';
import type { RuntimeIdentity } from '../src/core/fleet/runtime-identity.js';
import type { WorkBoardItem, WorkBoardResult } from '../src/core/comms/work-board.js';

const NOW = new Date('2026-11-13T13:13:00.000Z');
const ISO = NOW.toISOString();
const LINE = 'Last verified: fake-done-1 · owner agent-alpha · claim bus-claim:fake-done-1:1:1700000000000 · as of 2026-11-13T13:05:00.000Z (evidence only)';

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

const done: WorkBoardItem = {
  id: 'fake-done-1', channel: 'slack', channelRef: 'T0FAKEWS/C0FAKECH/1',
  receivedAt: '2026-11-13T13:00:00.000Z', state: 'VERIFIED', asOf: '2026-11-13T13:05:00.000Z',
  source: 'bus-reply:fake-reply-1', missing: [],
  owner: 'agent-alpha', claimReceipt: 'bus-claim:fake-done-1:1:1700000000000',
};

function deps(items: WorkBoardItem[]): FleetRecheckDeps {
  return {
    now: () => NOW, homeDir: () => '/home/fakeuser',
    readRuntimeIdentity: () => runtime, readFleetBoard: () => ledger, readChannelHealth: () => channels,
    listWorkBoard: (): WorkBoardResult => ({ items, inbox: 'ok', truncated: false }),
    listCoordination: () => ({ source: 'unavailable', claims: [] }),
  };
}

function withLast(v: FleetRecheck, owner: string): FleetRecheck {
  return { ...v, sections: { ...v.sections, task: { ...v.sections.task, lastVerified: {
    id: 'fake-done-1', owner, claimReceipt: 'bus-claim:fake-done-1:1:1', asOf: ISO, source: 'bus-reply:fake',
  } } } };
}

describe('formatRecheckReply last verified line', () => {
  it('adds the evidence line after the Task line and keeps the BLOCKED closer', async () => {
    const lines = formatRecheckReply(await readFleetRecheck(deps([done]))).split('\n');
    const i = lines.findIndex(l => l.startsWith('Task: none'));
    expect(i).toBeGreaterThan(-1);
    expect(lines[i + 1]).toBe(LINE);
    expect(lines[lines.length - 1]).toMatch(/^BLOCKED on:/);
  });

  it('adds nothing on an empty board and matches a verdict without the key', async () => {
    const v = await readFleetRecheck(deps([]));
    const reply = formatRecheckReply(v);
    expect(reply).not.toContain('Last verified');
    const old = structuredClone(v) as unknown as { sections: { task: Record<string, unknown> } };
    delete old.sections.task.lastVerified;
    expect(formatRecheckReply(old as unknown as FleetRecheck)).toBe(reply);
  });

  it('scrubs home paths and banned words in the line', async () => {
    const v = withLast(await readFleetRecheck(deps([])), '/Users/fakeuser/x routed');
    const reply = formatRecheckReply(v);
    expect(reply).toContain('Last verified');
    expect(reply).toContain('~');
    expect(reply).toContain('[verb]');
    expect(reply).not.toContain('/Users/fakeuser');
    expect(reply).not.toContain('routed');
  });

  it('drops the line, not the verdict, when over the cap', async () => {
    const base = await readFleetRecheck(deps([]));
    const blocked = (n: number): FleetRecheck => ({ ...base, overall: { ...base.overall, state: 'BLOCKED', missing: ['m'.repeat(n)] } });
    // Size the reason so the reply fits only without the evidence line.
    const room = 880 - formatRecheckReply(blocked(0)).length;
    const v = withLast(blocked(room), 'agent-alpha');
    expect(formatRecheckReply(blocked(room)).length).toBeLessThanOrEqual(900);
    const reply = formatRecheckReply(v);
    expect(reply).toBe(formatRecheckReply(blocked(room)));
    expect(reply).not.toContain('Last verified');
    expect(reply.split('\n')[0]).toMatch(/^Phantom recheck BLOCKED/);
    expect(reply).not.toContain('…');
    // A 700-char reason also stays within the cap with the line absent.
    const long = formatRecheckReply(withLast(blocked(700), 'agent-alpha'));
    expect(long.length).toBeLessThanOrEqual(900);
    expect(long).not.toContain('Last verified');
    expect(long.split('\n')[0]).toMatch(/^Phantom recheck BLOCKED/);
  });

  it('reaches the Slack reply path', async () => {
    const v = await readFleetRecheck(deps([done]));
    expect(await recheckReplyWithRecord(NOW, async () => v, () => {})).toContain(LINE);
  });
});
