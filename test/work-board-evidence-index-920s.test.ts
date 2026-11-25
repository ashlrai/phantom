import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { indexWorkBoardEvidence } from '../src/core/comms/work-board-evidence-index.js';
import { listWorkBoard } from '../src/core/comms/work-board.js';
import { deriveBusWorkItemEvidence } from '../src/core/comms/work-item-bus-evidence.js';
import { classifyWorkItem } from '../src/core/comms/work-item-state.js';
import { appendBusInbox, type BusInboxReceipt } from '../src/core/fleet/bus-inbox.js';
import type { BusWorkClaimView } from '../src/core/fleet/bus-work-claims.js';

const now = 1_700_000_000_000;
function row(id: string, cursor: number, body: unknown): BusInboxReceipt {
  return { cursor, receivedAt: now + cursor, envelope: { id, from: 'fake-a', to: 'fake-b', priority: 'P1', ttl: 100000, body } };
}

describe('per-board evidence index', () => {
  it('matches unindexed derivation for out-of-order, duplicate and conflicting receipts and claims', () => {
    const receipts = [row('fake-a', 4, {}), row('fake-r1', 8, { inReplyTo: 'fake-a', verified: { tests: 'pass' } }),
      row('fake-b', 2, {}), row('fake-r2', 7, { inReplyTo: 'fake-a', in_reply_to: 'fake-b', blocked: { dependency: 'fake-dep' } }),
      row('fake-a', 1, {}), row('fake-r3', 9, { in_reply_to: 'fake-b', blocked: { dependency: 'fake-review' } }),
      row('fake-r4', 10, { inReplyTo: 'fake-b', in_reply_to: null, verified: { tests: 'bad' } }),
      row('fake-r5', 11, { inReplyTo: 'fake-unknown' })];
    const claims: BusWorkClaimView[] = [
      { id: 'fake-a', cursor: 1, receivedAt: now + 1, owner: 'fake-stale', leaseUntil: now + 100, completedAt: null },
      { id: 'fake-a', cursor: 4, receivedAt: now + 4, owner: 'fake-owner', leaseUntil: now + 100, completedAt: null },
      { id: 'fake-a', cursor: 4, receivedAt: now + 4, owner: 'fake-other', leaseUntil: now + 100, completedAt: null },
    ];
    const index = indexWorkBoardEvidence(receipts, claims);
    for (const id of ['fake-a', 'fake-b', 'fake-r1', 'fake-unknown', 'missing']) {
      const original = deriveBusWorkItemEvidence(id, receipts, claims, now);
      const indexed = deriveBusWorkItemEvidence(id, index.receiptsFor(id), index.claimsFor(id), now);
      expect(indexed).toEqual(original);
      expect(classifyWorkItem(indexed.evidence, new Date(now).toISOString())).toEqual(classifyWorkItem(original.evidence, new Date(now).toISOString()));
    }
  });

  it('examines only each request and its reply instead of every receipt per request', () => {
    const count = 1000;
    const receipts = Array.from({ length: count }, (_, i) => [row(`fake-${i}`, i * 2 + 1, {}), row(`reply-${i}`, i * 2 + 2, { inReplyTo: `fake-${i}` })]).flat();
    const index = indexWorkBoardEvidence(receipts, []);
    const candidates = Array.from({ length: count }, (_, i) => index.receiptsFor(`fake-${i}`).length).reduce((a, b) => a + b, 0);
    expect(candidates).toBe(2000);
    expect(count * receipts.length).toBe(2_000_000);
  });

  it('preserves board filters, pagination and unavailable sources', () => {
    const root = mkdtempSync(join(tmpdir(), 'board-index-'));
    try {
      for (const [i, body] of [{}, {}, { inReplyTo: 'fake-0', verified: { tests: 'pass' } }, { in_reply_to: 'fake-1', blocked: { dependency: 'fake-review' } }].entries()) {
        expect(appendBusInbox({ id: `fake-${i}`, from: 'fake-a', to: 'fake-b', priority: 'P1', ttl: 100000, body }, { root, now: () => now + i }).status).toBe('posted');
      }
      const board = listWorkBoard({ root, now: now + 10 });
      expect(board.items.map(item => item.state)).toEqual(['BLOCKED', 'VERIFIED']);
      expect(listWorkBoard({ root, now: now + 10, state: 'VERIFIED', limit: 1 })).toEqual({ ...board, items: [board.items[1]], state: 'VERIFIED', matched: 1 });
      expect(listWorkBoard({ root, now: now + 10, limit: 1 }).truncated).toBe(true);
      mkdirSync(join(root, 'bus-inbox'), { recursive: true });
      writeFileSync(join(root, 'bus-inbox', 'messages.json'), 'invalid');
      expect(listWorkBoard({ root, now }).inbox).toBe('unavailable');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
