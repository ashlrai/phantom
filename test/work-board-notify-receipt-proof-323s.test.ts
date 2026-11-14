/** Receipt-proof gate for the board notifier: `sendNotifications` may
 * return 'sent'/'duplicate' to the caller only when the sender supplied a
 * nonblank receipt AND the durable ledger append succeeded. A missing
 * ledger sink, an absent/blank receipt or a throwing append yields
 * 'unavailable' with a bounded reason, no ledger row, and — through
 * `snapshotAfterSend` — an item that stays pending and retries; the
 * deterministic sender id then lands exactly one durable delivery.
 * All fixtures are fake; the only real store is a private tmp ledger. */
import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  boardNotifyLedgerKey, boardNotifyLedgerPath, diffBoard, planNotifications,
  readBoardNotifySent, sendNotifications, snapshotAfterSend,
  type BoardNotice, type BoardNotifyLedgerRow, type BoardSnapshotItem,
} from '../src/core/fleet/work-board-notify.js';

const TS_A = 'T0FAKEWS/C0FAKECH/1700000000.000323';
const AT = '2026-11-13T22:30:00.000Z';

const notice = (over: Partial<BoardNotice> = {}): BoardNotice => ({
  itemId: 'req-proof-1', state: 'BLOCKED', asOf: AT, detail: 'fake-dep', source: 'bus-reply:rb-proof',
  text: `BLOCKED req-proof-1 as of ${AT} — fake-dep (source: bus-reply:rb-proof)`,
  sourceChannel: 'slack', sourceThread: TS_A, ...over,
});

const snap = (over: Partial<BoardSnapshotItem>): BoardSnapshotItem => ({
  id: 'req-proof-1', state: 'RECEIVED', asOf: AT, source: 'receivedAt',
  owner: null, claimReceipt: null, channel: 'slack', channelRef: TS_A,
  blocker: null, verified: null, ...over,
});

describe('sendNotifications receipt proof', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'board-notify-proof-'));
    chmodSync(dir, 0o700);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('returns unavailable and writes no row when the sender omits or blanks its receipt', async () => {
    const appended: BoardNotifyLedgerRow[] = [];
    const appendLedger = (row: BoardNotifyLedgerRow) => appended.push(row);
    const missing = vi.fn().mockResolvedValue({ status: 'sent' as const });
    const blank = vi.fn().mockResolvedValue({ status: 'sent' as const, receipt: '   ' });
    const whitespace = vi.fn().mockResolvedValue({ status: 'duplicate' as const, receipt: '\t\n' });
    const results = await sendNotifications(
      [notice(), notice({ itemId: 'req-proof-2' }), notice({ itemId: 'req-proof-3' })],
      { senders: { slack: missing }, appendLedger });
    expect(results.map(r => [r.status, r.reason])).toEqual([
      ['unavailable', 'missing-sender-receipt'],
      ['unavailable', 'missing-sender-receipt'],
      ['unavailable', 'missing-sender-receipt'],
    ]);
    expect(appended).toEqual([]);
    const second = await sendNotifications([notice()], {
      senders: { slack: blank }, appendLedger,
    });
    expect(second[0]).toMatchObject({ status: 'unavailable', reason: 'missing-sender-receipt' });
    const third = await sendNotifications([notice()], {
      senders: { slack: whitespace }, appendLedger,
    });
    expect(third[0]).toMatchObject({ status: 'unavailable', reason: 'missing-sender-receipt' });
    expect(appended).toEqual([]);
  });

  it('returns unavailable and writes no row when the ledger append throws', async () => {
    const appended: BoardNotifyLedgerRow[] = [];
    const appendLedger = (row: BoardNotifyLedgerRow) => {
      appended.push(row);
      throw new Error('fake-append-failure');
    };
    const log = vi.fn();
    const results = await sendNotifications([notice()], {
      senders: { slack: vi.fn().mockResolvedValue({ status: 'sent', receipt: 'fake-ts-1' }) },
      appendLedger, log,
    });
    expect(results[0]).toMatchObject({ status: 'unavailable', reason: 'ledger-append-failed' });
    expect(appended).toHaveLength(1); // the row was attempted, not silently dropped
    expect(log).toHaveBeenCalledWith(expect.stringContaining('ledger append failed'));
  });

  it('returns unavailable without invoking the sender when no ledger sink exists', async () => {
    const slack = vi.fn().mockResolvedValue({ status: 'sent', receipt: 'fake-ts-1' });
    const results = await sendNotifications([notice()], { senders: { slack } });
    expect(results[0]).toMatchObject({ status: 'unavailable', reason: 'no-ledger-sink' });
    expect(slack).not.toHaveBeenCalled();
    const emptyPath = await sendNotifications([notice()], { senders: { slack }, ledgerPath: '' });
    expect(emptyPath[0]).toMatchObject({ status: 'unavailable', reason: 'no-ledger-sink' });
    expect(slack).not.toHaveBeenCalled();
  });

  it('returns sent and duplicate only with a nonblank receipt and a durable append', async () => {
    const appended: BoardNotifyLedgerRow[] = [];
    const results = await sendNotifications(
      [notice(), notice({ itemId: 'req-proof-2' })],
      {
        senders: {
          slack: vi.fn()
            .mockResolvedValueOnce({ status: 'sent', receipt: 'fake-ts-9' })
            .mockResolvedValueOnce({ status: 'duplicate', receipt: 'fake-dup-9' }),
        },
        appendLedger: row => appended.push(row), now: () => Date.parse(AT),
      });
    expect(results.map(r => r.status)).toEqual(['sent', 'duplicate']);
    expect(appended.map(r => r.receipt)).toEqual(['fake-ts-9', 'fake-dup-9']);
    expect(appended[0]).toMatchObject({ v: 1, itemId: 'req-proof-1', state: 'BLOCKED', channel: 'slack', thread: TS_A });
  });

  it('a failed bookkeeping pass cannot advance the snapshot; replay lands exactly one delivery', async () => {
    const ledgerPath = boardNotifyLedgerPath(dir);
    const received = snap({});
    const blocked = snap({ state: 'BLOCKED', blocker: { dependency: 'fake-dep', source: 'bus-reply:rb-proof', at: AT } });
    const prev = [received];
    const next = [blocked];

    // Pass 1: sender claims sent but supplies no receipt — bookkeeping fails.
    const noReceipt = vi.fn().mockResolvedValue({ status: 'sent' as const });
    const plan1 = planNotifications(diffBoard(prev, next), readBoardNotifySent(ledgerPath)!);
    expect(plan1.notices).toHaveLength(1);
    const failed = await sendNotifications(plan1.notices, { senders: { slack: noReceipt }, ledgerPath });
    expect(failed[0]).toMatchObject({ status: 'unavailable', reason: 'missing-sender-receipt' });
    expect(readBoardNotifySent(ledgerPath)!.has(boardNotifyLedgerKey('req-proof-1', 'BLOCKED'))).toBe(false);

    // The pending item keeps its previous snapshot row, so the transition re-fires.
    const pending = new Set(failed.filter(r => r.status !== 'sent' && r.status !== 'duplicate').map(r => r.notice.itemId));
    const kept = snapshotAfterSend(prev, next, pending);
    expect(kept).toEqual(prev);
    expect(diffBoard(kept, next)).toHaveLength(1);

    // Pass 2 (the retry, same deterministic sender id): the sender now
    // reports the deduped durable post with its receipt — exactly one row.
    const duplicate = vi.fn().mockResolvedValue({ status: 'duplicate', receipt: 'bus-reply:board-notify-deadbeef' });
    const plan2 = planNotifications(diffBoard(kept, next), readBoardNotifySent(ledgerPath)!);
    expect(plan2.notices).toHaveLength(1);
    const retried = await sendNotifications(plan2.notices, { senders: { slack: duplicate }, ledgerPath });
    expect(retried[0]!.status).toBe('duplicate');
    const sentSet = readBoardNotifySent(ledgerPath)!;
    expect(sentSet).toEqual(new Set([boardNotifyLedgerKey('req-proof-1', 'BLOCKED')]));

    // Restart: a fresh read of the same private ledger still dedupes, so a
    // later pass plans nothing and the sender is never called again.
    const plan3 = planNotifications(diffBoard(kept, next), readBoardNotifySent(ledgerPath)!);
    expect(plan3.notices).toEqual([]);
    expect(plan3.dropped[0]!.reason).toContain('already notified');
    const replay = vi.fn();
    await sendNotifications(plan3.notices, { senders: { slack: replay }, ledgerPath });
    expect(replay).not.toHaveBeenCalled();
    expect(readBoardNotifySent(ledgerPath)!.size).toBe(1);
  });

  it('an append failure mid-batch leaves later notices pending and retryable', async () => {
    let calls = 0;
    const appendLedger = () => { calls += 1; if (calls === 1) throw new Error('fake-full-disk'); };
    const results = await sendNotifications([notice(), notice({ itemId: 'req-proof-2' })], {
      senders: { slack: vi.fn().mockResolvedValue({ status: 'sent', receipt: 'fake-ts-x' }) },
      appendLedger,
    });
    expect(results.map(r => r.status)).toEqual(['unavailable', 'sent']);
    const pending = new Set(results.filter(r => r.status !== 'sent' && r.status !== 'duplicate').map(r => r.notice.itemId));
    expect(pending).toEqual(new Set(['req-proof-1']));
    const kept = snapshotAfterSend([snap({})], [snap({ state: 'BLOCKED', blocker: { dependency: 'd', source: 's', at: AT } })], pending);
    expect(kept.map(i => i.id)).toEqual(['req-proof-1']);
  });
});
