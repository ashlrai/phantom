import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  boardNotifyDeltaMaterial, boardNotifyLedgerPath, diffBoard, planNotifications,
  readBoardNotifySent, sendNotifications, type BoardNotice, type BoardSnapshotItem,
} from '../src/core/fleet/work-board-notify.js';

const base = (state: 'BLOCKED' | 'VERIFIED', overrides: Partial<BoardSnapshotItem> = {}): BoardSnapshotItem => ({
  id: 'fake-task', state, asOf: '2026-11-12T22:29:00Z', source: 'fake-source',
  owner: 'fake-alice', claimReceipt: 'fake-claim-1', channel: 'slack', channelRef: 'fake-thread-1',
  blocker: state === 'BLOCKED' ? { dependency: 'fake-dependency' } : null,
  verified: state === 'VERIFIED' ? { pr: 42, head: 'fake-head', tests: 'fake-tests', artifact: 'fake-artifact' } : null,
  ...overrides,
});

describe.each(['BLOCKED', 'VERIFIED'] as const)('%s outcome attribution', state => {
  it('delivers evidence, updates once for ownership changes, and ignores time churn', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'board-owner-'));
    try {
      const ledgerPath = boardNotifyLedgerPath(dir);
      const sender = vi.fn((_notice: BoardNotice) => ({ status: 'sent' as const, receipt: 'fake-delivery' }));
      const first = base(state);
      const plan = planNotifications(diffBoard([], [first]), readBoardNotifySent(ledgerPath)!);
      expect(plan.notices).toHaveLength(1);
      expect(plan.notices[0]!.text).toContain('fake-alice (claim fake-claim-1)');
      for (const part of state === 'BLOCKED' ? ['fake-dependency'] : ['PR #42', 'head fake-head', 'tests fake-tests', 'artifact fake-artifact']) {
        expect(plan.notices[0]!.text).toContain(part);
      }
      expect((await sendNotifications(plan.notices, { senders: { slack: sender }, ledgerPath }))[0]!.status).toBe('sent');
      const changed = base(state, { owner: 'fake-bob', claimReceipt: 'fake-claim-2' });
      const transitions = diffBoard([first], [changed]);
      const update = planNotifications(transitions, readBoardNotifySent(ledgerPath)!);
      expect(update.notices).toHaveLength(1);
      expect(update.notices[0]!.text).toContain('fake-bob (claim fake-claim-2)');
      await sendNotifications(update.notices, { senders: { slack: sender }, ledgerPath });
      expect(planNotifications(transitions, readBoardNotifySent(ledgerPath)!).notices).toHaveLength(0);
      expect(diffBoard([changed], [{ ...changed, asOf: 'later', source: 'another-source' }])).toHaveLength(0);
      expect(sender).toHaveBeenCalledTimes(2);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('delivers ownerless and incomplete attribution without inventing an assignment', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'board-owner-'));
    try {
      const ledgerPath = boardNotifyLedgerPath(dir);
      const sender = vi.fn((_notice: BoardNotice) => ({ status: 'sent' as const, receipt: 'fake-delivery' }));
      for (const [i, pair] of [
        { owner: null, claimReceipt: null }, { owner: 'fake-alice', claimReceipt: null },
        { owner: null, claimReceipt: 'fake-claim' }, { owner: '  ', claimReceipt: 'fake-claim' },
        { owner: 'fake-alice', claimReceipt: '  ' },
      ].entries()) {
        const item = base(state, { ...pair, id: `fake-task-${i}` });
        const plan = planNotifications(diffBoard([], [item]), readBoardNotifySent(ledgerPath)!);
        expect(plan.notices).toHaveLength(1);
        expect(plan.notices[0]!.text).not.toContain('claim');
        expect((await sendNotifications(plan.notices, { senders: { slack: sender }, ledgerPath }))[0]!.status).toBe('sent');
      }
      expect(sender).toHaveBeenCalledTimes(5);
      const material = boardNotifyDeltaMaterial({ state, channel: 'slack', thread: 'fake-thread-1',
        dependency: 'fake-dependency', pr: 42, owner: 'fake-alice' });
      expect(material).not.toContain('owner');
      expect(material).not.toContain('claim');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('treats a different source thread as a distinct delivery', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'board-owner-'));
    try {
      const ledgerPath = boardNotifyLedgerPath(dir);
      const sender = vi.fn((_notice: BoardNotice) => ({ status: 'sent' as const, receipt: 'fake-delivery' }));
      const first = base(state);
      const second = base(state, { channelRef: 'fake-thread-2' });
      const initial = planNotifications(diffBoard([], [first]), readBoardNotifySent(ledgerPath)!);
      await sendNotifications(initial.notices, { senders: { slack: sender }, ledgerPath });
      const reroute = planNotifications(diffBoard([first], [second]), readBoardNotifySent(ledgerPath)!);
      expect(reroute.notices).toHaveLength(1);
      await sendNotifications(reroute.notices, { senders: { slack: sender }, ledgerPath });
      expect(sender.mock.calls.map(([notice]) => notice.sourceThread)).toEqual(['fake-thread-1', 'fake-thread-2']);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
