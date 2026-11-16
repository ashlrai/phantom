import { describe, expect, it } from 'vitest';
import type { PeerLedgerReport } from '../src/core/agentnet/peer-ledger.js';
import { readFleetRecheck, type FleetRecheckDeps } from '../src/core/fleet/fleet-recheck.js';
import { formatRecheckReply } from '../src/core/fleet/fleet-recheck-reply.js';
import { formatPeersLine, summarizePeers } from '../src/core/fleet/recheck-peers-line.js';

const ISO = '2026-11-15T06:00:00.000Z';
const report: PeerLedgerReport = {
  v: 1, authority: 'none', asOf: ISO, status: 'ok', liveRows: 12, capacity: 1024,
  windowMs: 60_000, pairLimit: 6, maxHops: 8,
  pairs: [
    { fromAgent: 'agent0', target: 'agent1', remaining: 0, inWindow: 6, lastAt: ISO },
    { fromAgent: 'agent2', target: 'agent1', remaining: 4, inWindow: 2, lastAt: ISO },
  ],
  origins: [{ origin: 'fake-origin0', maxHop: 7, nearCap: true }, { origin: 'fake-origin1', maxHop: 1, nearCap: false }],
  truncated: { pairs: false, origins: false },
};
const identity = (s: string): string => s;
const fail = (): never => { throw new Error('fake reader failure'); };
function deps(readPeers: NonNullable<FleetRecheckDeps['readPeers']>): FleetRecheckDeps {
  return {
    now: () => new Date(ISO), homeDir: () => '/home/fake', readPeers,
    readRuntimeIdentity: fail, readFleetBoard: fail, readChannelHealth: fail,
    listWorkBoard: fail, listCoordination: fail, listLiveWorkers: fail,
    readTailnetPeers: fail, readPool: fail, readOrders: fail, readOwners: fail, readLaneTargets: fail,
  };
}

describe('peer recheck evidence', () => {
  it('summarizes only budget metadata, rate-limited pairs and near-cap origins', () => {
    expect(summarizePeers(report)).toEqual({
      asOf: ISO, status: 'ok', liveRows: 12, capacity: 1024, rateLimited: 1,
      tightest: { fromAgent: 'agent0', target: 'agent1', remaining: 0 }, nearCap: 1, reasons: [],
    });
    expect(formatPeersLine(summarizePeers(report), identity)).toBe(
      'Peers: 12/1024 rows · 1 rate-limited (agent0 → agent1, 0 left) · 1 near hop cap',
    );
  });

  it('formats empty, unavailable and omitted evidence', () => {
    const empty = summarizePeers({ ...report, status: 'empty', liveRows: 0, pairs: [], origins: [] });
    expect(empty).toMatchObject({ rateLimited: 0, tightest: null, nearCap: 0 });
    expect(formatPeersLine(empty, identity)).toBe('Peers: none in 24h');
    const unavailable = summarizePeers({ ...report, status: 'unavailable', reason: 'peer-ledger-unreadable' });
    expect(unavailable.reasons).toEqual(['peer-ledger-unreadable']);
    expect(formatPeersLine(unavailable, identity)).toBe('Peers: unknown (peer-ledger-unreadable)');
    expect(formatPeersLine(null, identity)).toBeNull();
    expect(formatPeersLine(undefined, identity)).toBeNull();
  });

  it('scrubs and bounds pair labels and unavailable reasons to one line', () => {
    const p = summarizePeers(report);
    p.tightest = { fromAgent: 'private\n'.repeat(100), target: 'private'.repeat(100), remaining: 0 };
    const scrub = (s: string): string => s.replaceAll('private', '[redacted]');
    const line = formatPeersLine(p, scrub)!;
    expect(line.length).toBeLessThanOrEqual(240);
    expect(line).not.toMatch(/private|\n/);
    expect(line).toContain('1 near hop cap');
    expect(formatPeersLine({ ...p, status: 'unavailable', reasons: ['private\n'.repeat(100)] }, scrub))
      .not.toMatch(/private|\n/);
  });

  it('joins a healthy or throwing reader without changing sections or the verdict', async () => {
    const healthy = await readFleetRecheck(deps(() => report));
    const failed = await readFleetRecheck(deps(fail));
    const empty = await readFleetRecheck(deps(() => ({ ...report, status: 'empty', pairs: [], origins: [] })));
    expect(healthy.peers).toEqual(summarizePeers(report));
    expect(failed.peers).toMatchObject({ status: 'unavailable', reasons: ['peers: reader failed'] });
    expect(failed.overall).toEqual(healthy.overall);
    expect(empty.overall).toEqual(healthy.overall);
    expect(failed.sections).toEqual(healthy.sections);
  });

  it('renders after Orders and drops Peers before coverage or other evidence', async () => {
    const verdict = await readFleetRecheck(deps(() => report));
    verdict.orders = { asOf: ISO, windowHours: 24, counts: {}, total: 0, reasons: [] };
    verdict.tailnet = null;
    verdict.pool = null;
    verdict.overall = { state: 'VERIFIED', missing: [] };
    verdict.sections.bridge.channels = [{ channel: 'slack', state: 'LIVE', runtimeHost: 'fake-host',
      processAlive: true, missingBridge: null, requestCoverage: 'verified' }];
    const text = formatRecheckReply(verdict);
    expect(text).toContain('Orders 24h: none\nPeers:');
    let dropped = false;
    for (let n = 0; n < 900; n++) {
      verdict.sections.runtime.host = 'x'.repeat(n);
      const reply = formatRecheckReply(verdict);
      if (!reply.includes('Peers:')) {
        expect(reply).toContain('Slack: recent requests answered in thread');
        expect(reply).toContain('Orders 24h: none');
        expect(reply).toContain('Pool:');
        expect(reply.length).toBeLessThanOrEqual(900);
        dropped = true;
        break;
      }
    }
    expect(dropped).toBe(true);
  });
});
