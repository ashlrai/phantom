/** Nov 12–13 Dot/Slack coordination: live peer-budget evidence in-thread. */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as ledger from '../src/core/agentnet/peer-ledger.js';
import { ownerStatusReply } from '../src/core/agents/owner-status-reply.js';
import { isPeersAsk } from '../src/core/fleet/peers-ask.js';
import { formatPeerLedgerReply } from '../src/core/fleet/peer-ledger-reply.js';

const NOW = new Date('2026-11-15T06:00:00.000Z');
const FOOTER = 'Read-only ledger metadata; grants no send or dispatch authority.';
const report = (over: Partial<ledger.PeerLedgerReport> = {}): ledger.PeerLedgerReport => ({
  v: 1, authority: 'none', status: 'ok', asOf: NOW.toISOString(), liveRows: 2,
  capacity: 1024, windowMs: 60_000, pairLimit: 6, maxHops: 8,
  pairs: [{ fromAgent: 'agent0', target: 'agent1', inWindow: 2, remaining: 4, lastAt: NOW.toISOString() }],
  origins: [], truncated: { pairs: false, origins: false }, ...over,
});

afterEach(() => vi.restoreAllMocks());

describe('isPeersAsk', () => {
  it.each(['peers', 'peers?', 'Peers.', 'peer ledger', 'peer budget', '  PEER BUDGET!  ', 'peers?!.'])(
    'accepts %s', text => expect(isPeersAsk(text)).toBe(true));
  it.each(['peers please send x', 'peer ledger please', 'peer', 'owners', 'status', '', 'peers\nplease', `peers${'?'.repeat(36)}`])(
    'rejects %s', text => expect(isPeersAsk(text)).toBe(false));
});

describe('formatPeerLedgerReply', () => {
  it('formats known budgets with the report clock and optional reason', () => {
    expect(formatPeerLedgerReply(report({ reason: 'observed' })).split('\n')).toEqual([
      `Peers (as of ${NOW.toISOString()}): ok — observed`,
      'Live rows 2/1024 · pair limit 6 per 60s · hop cap 8',
      'agent0 → agent1: 2/6 in window, 4 left', FOOTER,
    ]);
  });
  it('reports empty explicitly', () => {
    const out = formatPeerLedgerReply(report({ status: 'empty', liveRows: 0, pairs: [] }));
    expect(out).toContain('No peer messages in the last 24h.');
    expect(out).toContain('Live rows 0/1024');
    expect(out.endsWith(FOOTER)).toBe(true);
  });
  it('never prints placeholder counts when unavailable', () => {
    const out = formatPeerLedgerReply(report({ status: 'unavailable', liveRows: 0, reason: 'peer-ledger-unreadable' }));
    expect(out).toBe(`Peers unknown: peer-ledger-unreadable\n${FOOTER}`);
    expect(out).not.toMatch(/Live rows|pair limit|hop cap|agent0/);
    expect(formatPeerLedgerReply(report({ status: 'unavailable' }))).toContain('Peers unknown: peer ledger unavailable');
  });
  it('shows the five lowest remaining pairs without mutating the report', () => {
    const r = report({ pairs: Array.from({ length: 7 }, (_, i) => ({
      fromAgent: `agent${i}`, target: 'agent9', inWindow: i, remaining: 6 - i, lastAt: NOW.toISOString(),
    })) });
    const before = structuredClone(r);
    const out = formatPeerLedgerReply(r);
    expect(out).toContain('agent6 → agent9: 6/6 in window, 0 left RATE-LIMITED');
    expect(out.indexOf('agent6 →')).toBeLessThan(out.indexOf('agent5 →'));
    expect(out.match(/→/g)).toHaveLength(5);
    expect(out).not.toContain('agent1 →');
    expect(out).toContain('(list truncated)');
    expect(r).toEqual(before);
  });
  it('names every near-cap origin and excludes other origins', () => {
    const out = formatPeerLedgerReply(report({ origins: [
      { origin: 'origin0', maxHop: 7, nearCap: true },
      { origin: 'origin1', maxHop: 8, nearCap: true },
      { origin: 'origin2', maxHop: 1, nearCap: false },
    ] }));
    expect(out).toContain('Near hop cap: origin0 at hop 7/8');
    expect(out).toContain('Near hop cap: origin1 at hop 8/8');
    expect(out).not.toContain('origin2');
  });
  it.each([{ pairs: true, origins: false }, { pairs: false, origins: true }])(
    'retains upstream truncation %j', truncated => {
      expect(formatPeerLedgerReply(report({ truncated }))).toContain(`(list truncated)\n${FOOTER}`);
    });
  it('caps the entire reply at 1500 characters while retaining truncation and authority', () => {
    for (const r of [report({ origins: Array.from({ length: 32 }, (_, i) => ({
      origin: `origin${i}${'x'.repeat(100)}`, maxHop: 7, nearCap: true,
    })) }), report({ status: 'unavailable', reason: 'x'.repeat(2000) })]) {
      const out = formatPeerLedgerReply(r);
      expect(out.length).toBeLessThanOrEqual(1500);
      expect(out).toContain('(list truncated)');
      expect(out.endsWith(FOOTER)).toBe(true);
    }
  });
  it('strips control characters and private home paths from interpolated metadata', () => {
    const out = formatPeerLedgerReply(report({ reason: '\u001b[31m/Users/fake/private\nextra' }));
    expect(out).not.toContain('\u001b');
    expect(out).not.toContain('[31m');
    expect(out).not.toContain('/Users/fake');
  });
});

describe('ownerStatusReply peers compose path', () => {
  it('reads a temporary bus ledger and answers RATE-LIMITED without thread or digest data', async () => {
    const root = mkdtempSync(join(tmpdir(), 'slack-peers-396-'));
    const read = ledger.readPeerLedger;
    try {
      mkdirSync(join(root, 'agentnet'));
      writeFileSync(join(root, 'agentnet', 'coordination.json'), JSON.stringify(Array.from({ length: 6 }, (_, i) => ({
        id: `peer-123e4567-e89b-12d3-a456-42661417400${i}`, fromAgent: 'agent0', target: 'agent1',
        origin: 'peer-123e4567-e89b-12d3-a456-426614174000', digest: 'a'.repeat(64),
        hopCount: 7, threadId: 'fake-private-thread', at: NOW.getTime() - 1000,
      }))), { mode: 0o600 });
      const reader = vi.spyOn(ledger, 'readPeerLedger').mockImplementation(() => read({ busRoot: root, now: () => NOW.getTime() }));
      const reply = ownerStatusReply();
      expect(reply.ask('Peers?')).toBe(true);
      expect(reply.ask('peers please send x')).toBe(false);
      const out = await reply.compose('/fake-runs', NOW, 'Peers?');
      expect(reader).toHaveBeenCalledExactlyOnceWith();
      expect(out).toContain('agent0 → agent1: 6/6 in window, 0 left RATE-LIMITED');
      expect(out).toContain('at hop 7/8');
      expect(out).not.toMatch(/threadId|digest|fake-private-thread/);
      expect(out).not.toContain('a'.repeat(64));
      expect(out.endsWith(FOOTER)).toBe(true);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it('returns the fixed unknown reply when the reader throws', async () => {
    vi.spyOn(ledger, 'readPeerLedger').mockImplementation(() => { throw new Error('fake private failure'); });
    expect(await ownerStatusReply().compose('/fake-runs', NOW, 'peer ledger')).toBe('Peers unknown: peer ledger reader failed');
  });
});
