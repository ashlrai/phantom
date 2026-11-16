/** RQ-PHX-RECHECKSURFACEOWNER387 — fake evidence only, no host or network reads. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFleetRecheck, SECTION_TIMEOUT_MS, type FleetRecheckDeps, type FleetRecheckOwners } from '../src/core/fleet/fleet-recheck.js';
import { formatRecheckReply } from '../src/core/fleet/fleet-recheck-reply.js';
import { formatOwnersLine } from '../src/core/fleet/recheck-owners-line.js';
import type { FleetBoard } from '../src/core/fleet/coordination.js';

const NOW = new Date('2026-11-14T18:00:00.000Z');
const ISO = NOW.toISOString();
const MS = NOW.getTime();
const SURFACES = ['slack-bridge', 'imessage-bridge', 'dot-handoff'] as const;
const CLOSING = 'Evidence only; this reply grants no dispatch.';
const SAMPLE_REPLY = `Phantom recheck VERIFIED · as of ${ISO} · source fleet-recheck
Runtime: fake-host · 1 · fleet state 1s (VERIFIED)
Computers: 0 online, 0 offline · self fake-self · seen: none · as of ${ISO} (tailnet evidence, not a claim)
Pool: not configured
Claims: 1 live, top: fake-agent/ashlrai/phantom (VERIFIED)
Bridge: slack LIVE, imessage LIVE (VERIFIED)
Owners: slack-bridge UNKNOWN (no live claim) · imessage-bridge UNKNOWN (no live claim) · dot-handoff fake-agent (claim)
Task: fake-task RUNNING · owner fake-worker · claim bus-claim:fake-task:1:${MS} (VERIFIED)
Orders 24h: none
Peers: none in 24h
${CLOSING}`;
const board = (agents: string[] = []): FleetBoard => ({
  schema: 'fleet.coordination.v1', state: 'known', messages: [], proposals: [], expiredClaims: 0,
  claims: agents.map((agent, i) => ({
    id: `fake-claim-${i}`, agent, repo: 'ashlrai/phantom', task: 'fake dot-handoff maintenance',
    claimedAt: MS - 1000, expiresAt: MS + 60_000,
  })),
});
const owners = (): FleetRecheckOwners => ({
  asOf: ISO,
  surfaces: SURFACES.map(surface => ({
    surface, owner: 'fake-agent', ownerSource: 'advisory-claim', liveClaims: 1,
    lastLandedJob: 'RQ-FAKE-HISTORY', reason: null,
  })),
});
function deps(over: FleetRecheckDeps = {}): FleetRecheckDeps {
  return {
    now: () => NOW, homeDir: () => '/home/fake',
    readRuntimeIdentity: () => ({
      host: 'fake-host', platform: 'fakeos', asOf: ISO, installedVersion: '1', sourceVersion: '1',
      versionDrift: false, fleetState: { path: '~', mtime: ISO, ageSeconds: 1, stale: false },
      tailnetName: 'fake-tailnet', reasons: [],
    }),
    readFleetBoard: () => board(),
    readChannelHealth: () => ({
      schemaVersion: 1, asOf: ISO,
      channels: (['slack', 'imessage'] as const).map(channel => ({
        channel, configured: true, processAlive: true, runtimeHost: 'fake-host',
        lastInboundAt: null, lastReplyAt: null, unansweredCount: 0,
        proof: { requestCoverage: 'idle', futureDatedCount: 0 }, state: 'LIVE', missing: [], asOf: ISO,
      })),
    }),
    listWorkBoard: () => ({
      inbox: 'ok', truncated: false, items: [{
        id: 'fake-task', channel: 'slack', channelRef: 'fake-ref', receivedAt: ISO,
        state: 'RUNNING', asOf: ISO, source: 'fake-source', missing: [],
        owner: 'fake-worker', claimReceipt: `bus-claim:fake-task:1:${MS}`,
      }],
    }),
    listCoordination: () => ({ source: 'available', claims: [{
      origin: 'message', key: 'queue:fake-task', owner: 'fake-worker', leaseUntil: MS + 60_000,
      sourceId: `fake-task:1:${MS}`, live: true, repo: null, branch: null, path: null, started: null,
    }] }),
    listLiveWorkers: () => ({ v: 1, generatedAt: ISO, sourceState: 'healthy', workers: [], leaders: [], orchestratorAgents: 0 }),
    readTailnetPeers: () => ({ asOf: ISO, self: 'fake-self', peers: [], reasons: [] }),
    readPool: () => ({ asOf: ISO, self: 'fake-self', role: 'unknown', hosts: [], reasons: ['node pool not configured'] }),
    readOrders: () => ({ v: 1, generatedAt: ISO, sources: { inbox: 'healthy', prompts: 'healthy', publishes: 'healthy' }, orders: [] }),
    readLaneTargets: () => ({ v: 1, generatedAt: ISO, sourceState: 'healthy', lanes: [] }),
    ...over,
  };
}
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('recheck advisory surface owners', () => {
  it.each([
    { agents: ['fake-agent'], expected: 'dot-handoff fake-agent (claim)', source: 'advisory-claim' },
    { agents: ['fake-agent', 'fake-other'], expected: 'dot-handoff UNKNOWN (2 live claims)', source: 'none' },
    { agents: [], expected: 'dot-handoff UNKNOWN (no live claim)', source: 'none' },
  ])('uses the injected board with $agents', async ({ agents, expected, source }) => {
    const readBoard = vi.fn(() => board(agents));
    const r = await readFleetRecheck(deps({ readFleetBoard: readBoard }));
    expect(readBoard).toHaveBeenCalledTimes(1);
    expect(r.owners).toMatchObject({ asOf: ISO, surfaces: [
      { surface: 'slack-bridge', owner: 'UNKNOWN', ownerSource: 'none', liveClaims: 0 },
      { surface: 'imessage-bridge', owner: 'UNKNOWN', ownerSource: 'none', liveClaims: 0 },
      { surface: 'dot-handoff', ownerSource: source, liveClaims: agents.length, lastLandedJob: null },
    ] });
    const text = formatRecheckReply(r);
    if (agents.length === 1) expect(text).toBe(SAMPLE_REPLY);
    const lines = text.split('\n');
    expect(lines[lines.findIndex(line => line.startsWith('Bridge:')) + 1]).toContain(expected);
    expect(text).not.toMatch(/\b(?:routed|dispatched)\b/i);
    expect(lines.at(-1)).toBe(CLOSING);
    const baseline = await readFleetRecheck(deps({ readFleetBoard: () => board(agents), readOwners: () => null }));
    expect(r.sections).toEqual(baseline.sections);
    expect(r.overall).toEqual(baseline.overall);
  });

  it('reads all three surfaces while ignoring unrelated and expired claims', async () => {
    const b = board(['fake-slack', 'fake-imessage', 'fake-dot', 'fake-expired', 'fake-unrelated']);
    b.claims.forEach((claim, i) => { claim.task = `fake maintenance ${SURFACES[i % 3]}`; });
    b.claims[3]!.expiresAt = MS - 1;
    b.claims[4]!.task = 'unrelated fake task';
    const r = await readFleetRecheck(deps({ readFleetBoard: () => b }));
    expect(r.owners?.surfaces.map(row => [row.surface, row.owner, row.liveClaims])).toEqual([
      ['slack-bridge', 'fake-slack', 1], ['imessage-bridge', 'fake-imessage', 1], ['dot-handoff', 'fake-dot', 1],
    ]);
  });

  it('distinguishes an unreadable board from no live claim', async () => {
    const r = await readFleetRecheck(deps({ readFleetBoard: () => ({ ...board(), state: 'unknown' }) }));
    expect(r.owners?.surfaces.every(row => row.reason === 'coordination ledger: missing or unreadable')).toBe(true);
    expect(formatOwnersLine(r.owners, s => s)).toContain('UNKNOWN (coordination ledger: missing or unreadable)');
  });

  it('keeps the verdict identical when the owners reader throws', async () => {
    const baseline = await readFleetRecheck(deps({ readOwners: () => null }));
    const r = await readFleetRecheck(deps({ readOwners: () => { throw new Error('fake read failure'); } }));
    expect(r.owners).toBeNull();
    expect(r).toEqual(baseline);
    expect(formatRecheckReply(r)).not.toContain('Owners:');
  });

  it('bounds a stalled owners reader without changing the rest of the verdict', async () => {
    vi.useFakeTimers();
    const baseline = await readFleetRecheck(deps({ readOwners: () => null }));
    const pending = readFleetRecheck(deps({ readOwners: () => new Promise(() => {}) }));
    let settled = false;
    void pending.then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(SECTION_TIMEOUT_MS - 1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const r = await pending;
    expect(r).toEqual(baseline);
    expect(r.overall.state).toBe('VERIFIED');
  });

  it.each(['/Users/fake/private', '/home/fake/private', 'agent-192.168.0.1', 'agent-fd00::1234', 'routed', 'dispatched'])(
    'scrubs an injected owner label %s, including hand-built verdicts', async agent => {
      const evidence = owners();
      evidence.surfaces[2]!.owner = agent;
      const r = await readFleetRecheck(deps({ readOwners: () => evidence }));
      for (const verdict of [r, { ...r, owners: evidence }]) {
        const text = formatRecheckReply(verdict);
        expect(text).toContain('Owners:');
        expect(text).not.toContain(agent);
        expect(text).not.toMatch(/\b(?:routed|dispatched)\b/i);
      }
    },
  );

  it('scrubs reasons and never promotes landed history to ownership', async () => {
    const evidence = owners();
    evidence.surfaces[2] = {
      surface: 'dot-handoff', owner: 'fake-history-agent', ownerSource: 'none', liveClaims: 0,
      lastLandedJob: 'RQ-FAKE-HISTORY', reason: 'routed via /Users/fake/private at 192.168.0.1',
    };
    const r = await readFleetRecheck(deps({ readOwners: () => evidence }));
    const text = formatRecheckReply(r);
    expect(text).toContain('dot-handoff UNKNOWN ([verb] via ~/private at [ip])');
    expect(text).not.toContain('fake-history-agent');
    expect(text).not.toContain('RQ-FAKE-HISTORY');
    expect(text).not.toMatch(/\b(?:routed|dispatched)\b/i);
    expect(formatOwnersLine(null, s => s)).toBeNull();
    expect(formatOwnersLine(undefined, s => s)).toBeNull();
  });

  it('drops coverage, then Owners, then Orders, preserving the verdict line', async () => {
    const r = await readFleetRecheck(deps({ readOwners: owners }));
    r.orders = { asOf: ISO, windowHours: 24, counts: { VERIFIED: 1 }, total: 1, reasons: [] };
    for (const channel of r.sections.bridge.channels) channel.requestCoverage = 'verified';
    const stages: string[] = [];
    for (let padding = 0; padding <= 600; padding++) {
      r.sections.runtime.host = `fake-host${'x'.repeat(padding)}`;
      const text = formatRecheckReply(r);
      expect(text.length).toBeLessThanOrEqual(900);
      expect(text.split('\n').at(-1)).toBe(CLOSING);
      const stage = text.includes('Slack:') ? 'coverage' : text.includes('Owners:') ? 'owners'
        : text.includes('Orders 24h:') ? 'orders' : 'core';
      if (stages.at(-1) !== stage) stages.push(stage);
    }
    expect(stages).toEqual(['coverage', 'owners', 'orders', 'core']);
  });
});
