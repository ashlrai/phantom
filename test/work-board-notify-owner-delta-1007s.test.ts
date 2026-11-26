import { describe, expect, it } from 'vitest';
import {
  boardNotifyDeltaDigest, boardNotifyLedgerKey, diffBoard, planNotifications,
  type BoardSnapshotItem,
} from '../src/core/fleet/work-board-notify.js';

const AT = '2026-11-13T22:30:00.000Z';
const snapshot = (state: 'BLOCKED' | 'VERIFIED', over: Partial<BoardSnapshotItem> = {}): BoardSnapshotItem => ({
  id: 'fake-owner-delta', state, asOf: AT, source: 'fake-evidence',
  owner: 'fake owner', claimReceipt: 'fake claim', channel: 'slack', channelRef: 'fake-thread',
  blocker: state === 'BLOCKED' ? { dependency: 'fake dependency', source: 'fake-evidence', at: AT } : null,
  verified: state === 'VERIFIED' ? { artifact: 'fake artifact', source: 'fake-evidence', at: AT } : null,
  ...over,
});

describe.each(['BLOCKED', 'VERIFIED'] as const)('%s receipt-backed ownership delta', state => {
  it('plans one notice for a new owner and suppresses replay using its ledger identity', () => {
    const before = snapshot(state), after = snapshot(state, { owner: 'other owner', claimReceipt: 'other claim' });
    const transitions = diffBoard([before], [after]);
    expect(transitions).toHaveLength(1);
    const notices = planNotifications([...transitions, ...transitions], new Set()).notices;
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ state, sourceChannel: 'slack', sourceThread: 'fake-thread' });
    const ledger = new Set([boardNotifyLedgerKey(after.id, state, notices[0]!.delta)]);
    expect(planNotifications(transitions, ledger).notices).toEqual([]);
    expect(diffBoard([after], [after])).toEqual([]);
  });

  it('counts a replacement claim and an owner-only change with a complete receipt', () => {
    const before = snapshot(state);
    for (const over of [{ claimReceipt: 'replacement claim' }, { owner: 'other owner' }]) {
      const notices = planNotifications(diffBoard([before], [snapshot(state, over)]), new Set()).notices;
      expect(notices).toHaveLength(1);
    }
    const unattributed = snapshot(state, { owner: null, claimReceipt: null });
    expect(planNotifications(diffBoard([unattributed], [before]), new Set()).notices).toHaveLength(1);
  });

  it('ignores timestamps, evidence sources and normalized ownership whitespace', () => {
    const before = snapshot(state), after = snapshot(state, {
      owner: '  fake\n owner  ', claimReceipt: '\tfake   claim\n',
      asOf: '2026-11-14T22:30:00.000Z', source: 'other source',
      blocker: before.blocker && { ...before.blocker, at: 'later', source: 'other blocker' },
      verified: before.verified && { ...before.verified, at: 'later', source: 'other proof' },
    });
    expect(diffBoard([before], [after])).toEqual([]);
    const initial = planNotifications(diffBoard([], [before]), new Set()).notices[0]!;
    const ledger = new Set([boardNotifyLedgerKey(before.id, state, initial.delta)]);
    expect(planNotifications(diffBoard([], [after]), ledger).notices).toEqual([]);
  });

  it('preserves prior unattributed digests for absent or incomplete ownership without churn', () => {
    const before = snapshot(state, { owner: null, claimReceipt: null });
    const core = state === 'BLOCKED' ? { dependency: 'fake dependency' }
      : { pr: null, head: null, tests: null, artifact: 'fake artifact' };
    const legacyDelta = boardNotifyDeltaDigest(JSON.stringify({ channel: 'slack', thread: 'fake-thread', ...core }));
    const ledger = new Set([boardNotifyLedgerKey(before.id, state, legacyDelta)]);
    for (const over of [
      { owner: null, claimReceipt: null }, { owner: 'other owner', claimReceipt: null },
      { owner: null, claimReceipt: 'other claim' }, { owner: '  ', claimReceipt: 'other claim' },
      { owner: 'other owner', claimReceipt: '\t ' },
    ]) {
      const after = snapshot(state, over), transitions = diffBoard([], [after]);
      expect(planNotifications(transitions, new Set()).notices[0]!.delta).toBe(legacyDelta);
      expect(planNotifications(transitions, ledger).notices).toEqual([]);
      expect(diffBoard([before], [after])).toEqual([]);
    }
  });

  it('keeps ownership identities isolated by channel and source thread', () => {
    const before = snapshot(state);
    const notice = planNotifications(diffBoard([], [before]), new Set()).notices[0]!;
    const ledger = new Set([boardNotifyLedgerKey(before.id, state, notice.delta)]);
    for (const over of [{ channel: 'bus' }, { channelRef: 'other-thread' }]) {
      const after = snapshot(state, over);
      const notices = planNotifications(diffBoard([before], [after]), ledger).notices;
      expect(notices).toHaveLength(1);
      expect(notices[0]!.delta).not.toBe(notice.delta);
      expect(notices[0]).toMatchObject({ sourceChannel: after.channel, sourceThread: after.channelRef });
    }
  });
});
