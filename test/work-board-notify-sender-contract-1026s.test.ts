import { chmodSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  boardNotifyLedgerPath, diffBoard, planNotifications, readBoardNotifySent,
  sendNotifications, snapshotAfterSend, type BoardSendReceipt, type BoardSnapshotItem,
} from '../src/core/fleet/work-board-notify.js';

const at = '2026-11-13T22:00:00.000Z';
const item = (id: string, blocked: boolean): BoardSnapshotItem => ({
  id, state: blocked ? 'BLOCKED' : 'RECEIVED', asOf: at, source: 'fake-source',
  owner: null, claimReceipt: null, channel: 'fake', channelRef: 'fake-thread',
  blocker: blocked ? { dependency: 'fake-dependency', source: 'fake-source', at } : null,
  verified: null,
});

describe('board sender runtime contract', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'board-contract-')); chmodSync(dir, 0o700); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it.each([undefined, null, 'invalid', [], { status: 'unknown' }])('keeps malformed receipt %j pending and continues', async invalid => {
    const ledgerPath = boardNotifyLedgerPath(dir);
    const previous = [item('a', false), item('b', false)];
    const current = [item('a', true), item('b', true)];
    const notices = planNotifications(diffBoard(previous, current), new Set()).notices;
    const sender = vi.fn().mockResolvedValueOnce(invalid as BoardSendReceipt)
      .mockResolvedValueOnce({ status: 'sent', receipt: 'receipt-b' });
    const results = await sendNotifications(notices, { senders: { fake: sender }, ledgerPath });
    expect(results.map(({ status, reason }) => ({ status, reason }))).toEqual([
      { status: 'unavailable', reason: 'invalid-sender-receipt' }, { status: 'sent', reason: undefined },
    ]);
    expect(sender.mock.calls.map(([notice]) => notice.itemId)).toEqual(['a', 'b']);
    expect(readFileSync(ledgerPath, 'utf8').trim().split('\n').map(line => JSON.parse(line).itemId)).toEqual(['b']);
    const snapshot = snapshotAfterSend(previous, current, new Set(['a']));
    expect(snapshot).toEqual([previous[0], current[1]]);
    const retry = planNotifications(diffBoard(snapshot, current), readBoardNotifySent(ledgerPath)!).notices;
    expect(retry.map(notice => notice.itemId)).toEqual(['a']);
    const recovered = await sendNotifications(retry, {
      senders: { fake: () => ({ status: 'duplicate', receipt: 'receipt-a' }) }, ledgerPath,
    });
    expect(recovered[0]!.status).toBe('duplicate');
    expect(snapshotAfterSend(snapshot, current, new Set())).toEqual(current);
    expect(readFileSync(ledgerPath, 'utf8').trim().split('\n').map(line => JSON.parse(line).itemId)).toEqual(['b', 'a']);
  });

  it.each([
    [{ status: 'sent', receipt: 'receipt' }, 'sent', undefined, 1],
    [{ status: 'duplicate', receipt: 'receipt' }, 'duplicate', undefined, 1],
    [{ status: 'refused', reason: 'refused-reason' }, 'refused', 'refused-reason', 0],
    [{ status: 'unavailable', reason: 'unavailable-reason' }, 'unavailable', 'unavailable-reason', 0],
    [{ status: 'sent', receipt: '  ' }, 'unavailable', 'missing-sender-receipt', 0],
    [{ status: 'duplicate' }, 'unavailable', 'missing-sender-receipt', 0],
  ] as const)('preserves valid receipt behavior for %j', async (receipt, status, reason, count) => {
    const notices = planNotifications(diffBoard([], [item('a', true)]), new Set()).notices;
    const rows: unknown[] = [];
    const results = await sendNotifications(notices, { senders: { fake: () => receipt }, appendLedger: row => { rows.push(row); } });
    expect(results[0]).toMatchObject({ status, ...(reason ? { reason } : {}) });
    expect(rows).toHaveLength(count);
  });
});
