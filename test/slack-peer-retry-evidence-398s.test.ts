/** Slack peer-budget reply projects an actionable retry instant for blocked pairs. */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { readPeerLedger, type PeerLedgerReport } from '../src/core/agentnet/peer-ledger.js';
import { formatPeerLedgerReply } from '../src/core/fleet/peer-ledger-reply.js';

const NOW = Date.parse('2026-11-15T06:00:00.000Z');
const FOOTER = 'Read-only ledger metadata; grants no send or dispatch authority.';
const DIGEST = 'b'.repeat(64);
const THREAD = 'fake-private-thread-398s';

const pair = (over: Partial<PeerLedgerReport['pairs'][number]> = {}): PeerLedgerReport['pairs'][number] => ({
  fromAgent: 'agent0', target: 'agent1', inWindow: 6, remaining: 0,
  lastAt: new Date(NOW).toISOString(), retryAt: null, ...over,
});
const report = (over: Partial<PeerLedgerReport> = {}): PeerLedgerReport => ({
  v: 1, authority: 'none', status: 'ok', asOf: new Date(NOW).toISOString(), liveRows: 1,
  capacity: 1024, windowMs: 60_000, pairLimit: 6, maxHops: 8,
  pairs: [pair()], origins: [], truncated: { pairs: false, origins: false }, ...over,
});

function busRoot(rows: unknown[]): { root: string; file: string } {
  const root = mkdtempSync(join(tmpdir(), 'slack-peer-retry-398s-'));
  mkdirSync(join(root, 'agentnet'));
  const file = join(root, 'agentnet', 'coordination.json');
  writeFileSync(file, JSON.stringify(rows), { mode: 0o600 });
  return { root, file };
}
const row = (i: number, at: number) => ({
  id: `peer-123e4567-e89b-12d3-a456-4266141740${String(i).padStart(2, '0')}`,
  fromAgent: 'agent0', target: 'agent1',
  origin: 'peer-123e4567-e89b-12d3-a456-426614174000',
  digest: DIGEST, hopCount: 3, threadId: THREAD, at,
});

it('reports projected retry unknown for blocked pairs without a valid instant', () => {
  for (const retryAt of [null, 'not-a-date', 'x'.repeat(5000), undefined]) {
    const out = formatPeerLedgerReply(report({ pairs: [pair({ retryAt: retryAt as string | null })] }));
    expect(out).toContain('0 left RATE-LIMITED · projected retry unknown');
    expect(out).not.toMatch(/projected retry \d{4}-/);
    expect(out.length).toBeLessThanOrEqual(1500);
    expect(out.endsWith(FOOTER)).toBe(true);
  }
});

it('shows the finite retry instant for a blocked pair and nothing for unblocked pairs', () => {
  const retryAt = '2026-11-15T06:00:30.000Z';
  const out = formatPeerLedgerReply(report({ pairs: [
    pair({ retryAt }),
    pair({ target: 'agent2', inWindow: 2, remaining: 4, retryAt: '2026-11-15T06:00:45.000Z' }),
    pair({ target: 'agent3', inWindow: 5, remaining: 1, retryAt }),
  ] }));
  expect(out).toContain(`agent0 → agent1: 6/6 in window, 0 left RATE-LIMITED · projected retry ${retryAt}`);
  expect(out).toContain('agent0 → agent2: 2/6 in window, 4 left\n');
  expect(out).toContain('agent0 → agent3: 5/6 in window, 1 left\n');
  expect(out.match(/projected retry/g)).toHaveLength(1);
  expect(out).not.toContain('06:00:45');
});

it('keeps the 1500-character cap, truncation marker and footer under long metadata', () => {
  const out = formatPeerLedgerReply(report({
    pairs: [pair({ retryAt: '2026-11-15T06:00:30.000Z' })],
    origins: Array.from({ length: 32 }, (_, i) => ({ origin: `o${i}${'x'.repeat(100)}`, maxHop: 7, nearCap: true })),
  }));
  expect(out.length).toBeLessThanOrEqual(1500);
  expect(out).toContain('projected retry 2026-11-15T06:00:30.000Z');
  expect(out).toContain('(list truncated)');
  expect(out.endsWith(FOOTER)).toBe(true);
});

it('projects the oldest in-window expiry for six staggered sends, then unblocks at the boundary', () => {
  // The pair drops below the limit when the oldest row ages out at at + 60s.
  const offsets = [59_000, 49_000, 39_000, 29_000, 19_000, 9_000];
  const { root, file } = busRoot(offsets.map((off, i) => row(i, NOW - off)));
  try {
    const bytesBefore = readFileSync(file);
    const blocked = readPeerLedger({ busRoot: root, now: () => NOW });
    expect(blocked.status).toBe('ok');
    expect(blocked.pairs[0]).toMatchObject({ inWindow: 6, remaining: 0 });
    const expectedRetry = new Date(NOW - 59_000 + 60_000).toISOString();
    expect(blocked.pairs[0]!.retryAt).toBe(expectedRetry);
    const out = formatPeerLedgerReply(blocked);
    expect(out).toContain(`Peers (as of ${blocked.asOf}): ok`);
    expect(out).toContain(`agent0 → agent1: 6/6 in window, 0 left RATE-LIMITED · projected retry ${expectedRetry}`);
    expect(out).not.toMatch(/threadId|digest|fake-private-thread/);
    expect(out).not.toContain(DIGEST);
    expect(out.endsWith(FOOTER)).toBe(true);

    const boundary = readPeerLedger({ busRoot: root, now: () => NOW + 1_000 });
    const boundaryOut = formatPeerLedgerReply(boundary);
    expect(boundary.pairs[0]).toMatchObject({ inWindow: 5, remaining: 1, retryAt: null });
    expect(boundaryOut).toContain('agent0 → agent1: 5/6 in window, 1 left');
    expect(boundaryOut).not.toContain('RATE-LIMITED');
    expect(boundaryOut).not.toContain('projected retry');
    expect(readFileSync(file)).toEqual(bytesBefore);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it('reports unknown evidence, never a guessed instant, when the ledger is unreadable', () => {
  const { root } = busRoot([]);
  try {
    writeFileSync(join(root, 'agentnet', 'coordination.json'), 'not json', { mode: 0o600 });
    const out = formatPeerLedgerReply(readPeerLedger({ busRoot: root, now: () => NOW }));
    expect(out).toContain('Peers unknown: peer-ledger-unreadable');
    expect(out).not.toContain('projected retry');
    expect(out.endsWith(FOOTER)).toBe(true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
