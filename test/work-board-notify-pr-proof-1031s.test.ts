import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { boardNotifySnapshotPath, diffBoard, planNotifications, readBoardNotifySnapshot, snapshotAfterSend, snapshotBoard, writeBoardNotifySnapshot } from '../src/core/fleet/work-board-notify.js';
import type { WorkBoardResult } from '../src/core/comms/work-board.js';

const at = '2026-11-13T22:00:00.000Z';
const item = { id: 'fake-item', channel: 'bus', channelRef: null, receivedAt: at, state: 'RECEIVED' as const,
  asOf: at, source: 'fake-source', missing: [], owner: null, claimReceipt: null };
const board = (state: 'RECEIVED' | 'VERIFIED'): WorkBoardResult => ({ items: [{ ...item, state }], inbox: 'ok', truncated: false });
const snap = (pr: number, proof: { tests?: string; artifact?: string } = {}) => snapshotBoard(board('VERIFIED'), () => ({
  id: item.id, verified: { pr, ...proof, source: 'fake-source', at },
}));

it('keeps invalid PR-only verification pending and retries when proof arrives', () => {
  const previous = snapshotBoard(board('RECEIVED'));
  for (const pr of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    const next = snap(pr);
    const transition = diffBoard(previous, next)[0]!;
    const plan = planNotifications([{ ...transition, evidence: { ...transition.evidence, pr } }], new Set());
    expect(plan.notices).toHaveLength(0);
    expect(plan.dropped[0]?.reason).toBe('VERIFIED dropped: no PR, head or test artifact');
    const pending = snapshotAfterSend(previous, next, new Set(plan.dropped.map(d => d.itemId)));
    expect(pending).toEqual(previous);
    expect(planNotifications(diffBoard(pending, snap(123)), new Set()).notices[0]?.detail).toBe('PR #123');
  }
});

it('retains real proof, omits invalid numbers and ignores invalid-number churn', () => {
  for (const proof of [{ tests: 'fake tests passed' }, { artifact: 'fake artifact' }]) {
    const first = snap(0, proof), next = snap(-1, proof);
    const notice = planNotifications(diffBoard([], first), new Set()).notices[0]!;
    expect(notice.detail).toBe(proof.tests ? 'tests fake tests passed' : 'fake artifact');
    expect(notice.text).not.toContain('PR #');
    expect(diffBoard(first, next)).toEqual([]);
    const transition = diffBoard([], first)[0]!;
    const direct = planNotifications([{ ...transition, evidence: { ...transition.evidence, pr: -1 } }], new Set()).notices[0]!;
    expect(direct.detail).toBe(notice.detail);
    expect(direct.delta).toBe(notice.delta);
  }
});

it('rejects invalid persisted evidence and accepts valid snapshots', () => {
  const dir = mkdtempSync(join(tmpdir(), 'notify-pr-proof-'));
  try {
    const valid = snap(123);
    expect(writeBoardNotifySnapshot(dir, valid)).toEqual({ ok: true });
    expect(readBoardNotifySnapshot(dir)).toEqual(valid);
    for (const pr of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      const invalid = [{ ...valid[0]!, verified: { ...valid[0]!.verified!, pr } }];
      expect(writeBoardNotifySnapshot(dir, invalid)).toEqual({ ok: false });
      writeFileSync(boardNotifySnapshotPath(dir), JSON.stringify({ v: 1, items: invalid }));
      expect(readBoardNotifySnapshot(dir)).toBeNull();
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
