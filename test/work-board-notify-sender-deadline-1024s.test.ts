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

describe('board sender deadline', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'board-deadline-')); chmodSync(dir, 0o700); });
  afterEach(() => { vi.useRealTimers(); rmSync(dir, { recursive: true, force: true }); });

  it.each(['resolve', 'reject'] as const)('continues after timeout, ignores late %s, and recovers by duplicate receipt', async late => {
    vi.useFakeTimers();
    const ledgerPath = boardNotifyLedgerPath(dir);
    const previous = [item('a', false), item('b', false)];
    const current = [item('a', true), item('b', true)];
    const notices = planNotifications(diffBoard(previous, current), new Set()).notices;
    let resolveLate!: (receipt: BoardSendReceipt) => void;
    let rejectLate!: (error: Error) => void;
    const pending = new Promise<BoardSendReceipt>((resolve, reject) => { resolveLate = resolve; rejectLate = reject; });
    const sender = vi.fn().mockReturnValueOnce(pending).mockResolvedValueOnce({ status: 'sent', receipt: 'receipt-b' });
    const pass = sendNotifications(notices, { senders: { fake: sender }, ledgerPath, senderTimeoutMs: 10 });
    await vi.advanceTimersByTimeAsync(10);
    const results = await pass;
    expect(results.map(({ status, reason }) => ({ status, reason }))).toEqual([
      { status: 'unavailable', reason: 'sender-timeout' }, { status: 'sent', reason: undefined },
    ]);
    expect(sender.mock.calls.map(([notice]) => notice.itemId)).toEqual(['a', 'b']);
    const snapshot = snapshotAfterSend(previous, current, new Set(results.filter(r => r.status === 'unavailable').map(r => r.notice.itemId)));
    expect(snapshot).toEqual([previous[0], current[1]]);
    const ledgerBefore = readFileSync(ledgerPath, 'utf8');
    expect(ledgerBefore.trim().split('\n')).toHaveLength(1);
    if (late === 'resolve') resolveLate({ status: 'sent', receipt: 'late-receipt' });
    else rejectLate(new Error('late failure'));
    await vi.runAllTimersAsync();
    expect(readFileSync(ledgerPath, 'utf8')).toBe(ledgerBefore);
    expect(results[0]).toMatchObject({ status: 'unavailable', reason: 'sender-timeout' });
    const retry = planNotifications(diffBoard(snapshot, current), readBoardNotifySent(ledgerPath)!).notices;
    expect(retry).toHaveLength(1);
    expect(retry[0]!.delta).toBe(notices[0]!.delta);
    const recovered = await sendNotifications(retry, {
      senders: { fake: () => ({ status: 'duplicate', receipt: 'original-receipt' }) }, ledgerPath, senderTimeoutMs: 10,
    });
    expect(recovered[0]!.status).toBe('duplicate');
    expect(readFileSync(ledgerPath, 'utf8').trim().split('\n')).toHaveLength(2);
  });

  it('preserves immediate success, rejection and absent sender behavior', async () => {
    const notices = planNotifications(diffBoard([], [item('a', true)]), new Set()).notices;
    const rows: unknown[] = [];
    const appendLedger = (row: unknown) => { rows.push(row); };
    expect((await sendNotifications(notices, { senders: { fake: () => ({ status: 'sent', receipt: 'receipt' }) }, appendLedger }))[0]!.status).toBe('sent');
    expect((await sendNotifications(notices, { senders: { fake: () => Promise.reject(new Error('fake')) }, appendLedger }))[0]).toMatchObject({ status: 'unavailable', reason: 'sender threw' });
    expect((await sendNotifications(notices, { senders: {}, appendLedger }))[0]!.status).toBe('no-sender');
    expect(rows).toHaveLength(1);
  });
});
