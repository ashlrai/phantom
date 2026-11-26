import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  appendBoardNotifyLedger, boardNotifyLedgerPath, diffBoard, planNotifications,
  readBoardNotifySent, sendNotifications, snapshotAfterSend,
  type BoardSnapshotItem,
} from '../src/core/fleet/work-board-notify.js';

const at = '2026-11-12T22:30:00.000Z';
const blocked = (owner: string | null, claimReceipt: string | null, dependency = 'dependency-a'): BoardSnapshotItem => ({
  id: 'fake-work', state: 'BLOCKED', asOf: at, source: 'fake-source', owner, claimReceipt,
  channel: 'slack', channelRef: 'fake-original-thread',
  blocker: { dependency, source: 'fake-blocker', at }, verified: null,
});

describe('BLOCKED owner notifications', () => {
  it('delivers a receipted reassignment once to the source thread and dedupes after a ledger reread', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'blocked-owner-921-'));
    try {
      const ledgerPath = boardNotifyLedgerPath(dir);
      const sender = vi.fn().mockResolvedValue({ status: 'sent', receipt: 'fake-delivery' });
      const alpha = blocked('alpha', 'receipt-a');
      const beta = blocked('beta', 'receipt-b');
      const initial = planNotifications(diffBoard([], [alpha]), readBoardNotifySent(ledgerPath)!);
      expect(initial.notices).toHaveLength(1);
      expect((await sendNotifications(initial.notices, { senders: { slack: sender }, ledgerPath }))[0]?.status).toBe('sent');
      const transition = diffBoard([alpha], [beta]);
      const plan = planNotifications(transition, readBoardNotifySent(ledgerPath)!);
      expect(plan.notices).toHaveLength(1);
      expect(plan.notices[0]).toMatchObject({ state: 'BLOCKED', sourceChannel: 'slack', sourceThread: 'fake-original-thread' });
      expect(plan.notices[0]!.text).toContain('beta');
      expect(plan.notices[0]!.text).toContain('receipt-b');
      expect((await sendNotifications(plan.notices, { senders: { slack: sender }, ledgerPath }))[0]?.status).toBe('sent');
      expect(sender).toHaveBeenCalledTimes(2);
      expect(planNotifications(transition, readBoardNotifySent(ledgerPath)!).notices).toEqual([]);
      expect(diffBoard([beta], [{ ...beta, asOf: 'later' }])).toEqual([]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('ignores unreceipted identities and retains dependency-only notices and legacy fences', () => {
    const a = blocked('alpha', null);
    expect(diffBoard([a], [blocked('beta', '  ')])).toEqual([]);
    expect(diffBoard([blocked(null, null)], [blocked('beta', null)])).toEqual([]);
    const changed = diffBoard([a], [blocked('beta', null, 'dependency-b')]);
    const notice = planNotifications(changed, new Set()).notices[0]!;
    expect(notice.detail).toBe('dependency-b');
    expect(notice.text).not.toContain('beta');
    const dir = mkdtempSync(join(tmpdir(), 'blocked-legacy-921-'));
    try {
      const ledgerPath = boardNotifyLedgerPath(dir);
      appendBoardNotifyLedger(ledgerPath, { v: 1, at, itemId: 'fake-work', state: 'BLOCKED', channel: 'slack', thread: 'fake-original-thread', receipt: 'fake-receipt' });
      const sent = readBoardNotifySent(ledgerPath)!;
      expect(planNotifications(diffBoard([], [blocked('beta', 'receipt-b')]), sent).notices).toEqual([]);
      expect(planNotifications(diffBoard([blocked('alpha', 'receipt-a')], [blocked('beta', 'receipt-b')]), sent).notices).toHaveLength(1);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('retains the previous snapshot and retries after a sender failure', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'blocked-retry-921-'));
    try {
      const ledgerPath = boardNotifyLedgerPath(dir);
      const alpha = blocked('alpha', 'receipt-a'), beta = blocked('beta', 'receipt-b');
      const sender = vi.fn().mockResolvedValueOnce({ status: 'unavailable' }).mockResolvedValueOnce({ status: 'sent', receipt: 'fake-delivery' });
      const plan = () => planNotifications(diffBoard([alpha], [beta]), readBoardNotifySent(ledgerPath)!);
      const first = plan();
      expect((await sendNotifications(first.notices, { senders: { slack: sender }, ledgerPath }))[0]?.status).toBe('unavailable');
      expect(snapshotAfterSend([alpha], [beta], new Set(['fake-work']))).toEqual([alpha]);
      expect(readBoardNotifySent(ledgerPath)!.size).toBe(0);
      const retry = plan();
      expect(retry.notices[0]!.delta).toBe(first.notices[0]!.delta);
      expect((await sendNotifications(retry.notices, { senders: { slack: sender }, ledgerPath }))[0]?.status).toBe('sent');
      expect(plan().notices).toEqual([]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
