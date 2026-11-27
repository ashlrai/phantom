import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  appendBoardNotifyLedger, boardNotifyDeltaDigest, boardNotifyLedgerKey,
  diffBoard, planNotifications, readBoardNotifySent, type BoardSnapshotItem,
} from '../src/core/fleet/work-board-notify.js';

const at = '2026-11-26T12:00:00Z';
const original = 'T0FAKETEAM/C0FAKECHAN/1700000000.001000';
const equivalent = 'slack:T0FAKETEAM:C0FAKECHAN:1700000000.001';
const row = (changes: Partial<BoardSnapshotItem> = {}): BoardSnapshotItem => ({
  id: 'synthetic', state: 'BLOCKED', asOf: at, source: 'synthetic', owner: null, claimReceipt: null,
  channel: 'slack', channelRef: original, blocker: { dependency: 'dep', source: 'synthetic', at }, verified: null, ...changes,
});
const plan = (before: BoardSnapshotItem[], after: BoardSnapshotItem[], sent = new Set<string>()) =>
  planNotifications(diffBoard(before, after), sent).notices;

describe('physical Slack thread notification identity', () => {
  it('dedupes grammar and decimal variants, including sender identity', () => {
    const a = row(), b = row({ channelRef: equivalent });
    expect(plan([a], [b])).toEqual([]);
    const first = plan([], [a])[0]!;
    const second = plan([], [b])[0]!;
    expect(second.delta).toBe(first.delta);
    expect(second.sourceThread).toBe(equivalent);
    expect(plan([], [b], new Set([boardNotifyLedgerKey(a.id, a.state, first.delta)]))).toEqual([]);
    const precise = row({ channelRef: 'T0FAKETEAM/C0FAKECHAN/9999999999999999.001000' });
    expect(plan([precise], [{ ...precise, channelRef: 'slack:T0FAKETEAM:C0FAKECHAN:9999999999999999.001' }])).toEqual([]);
  });

  it('honors a raw-delta receipt after upgrade without hiding changed evidence or routes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'board-identity-'));
    try {
      const path = join(dir, 'sent.jsonl');
      const delta = boardNotifyDeltaDigest(JSON.stringify({ channel: 'slack', thread: original, dependency: 'dep' }));
      appendBoardNotifyLedger(path, { v: 1, at, itemId: 'synthetic', state: 'BLOCKED', channel: 'slack', thread: original, receipt: 'synthetic', delta });
      const sent = readBoardNotifySent(path)!;
      expect(plan([], [row({ channelRef: equivalent })], sent)).toEqual([]);
      for (const channelRef of ['slack:T0OTHER:C0FAKECHAN:1700000000.001', 'slack:T0FAKETEAM:C0OTHER:1700000000.001', 'slack:T0FAKETEAM:C0FAKECHAN:1700000000.002']) {
        expect(plan([row()], [row({ channelRef })], sent)).toHaveLength(1);
      }
      expect(plan([], [row({ channelRef: equivalent, blocker: { dependency: 'other', source: 'synthetic', at } })], sent)).toHaveLength(1);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('keeps other channels and malformed references distinct', () => {
    for (const channel of ['bus', 'imessage', 'slack']) {
      const a = row({ channel, channelRef: channel === 'slack' ? 'bad/ref/1' : original });
      const b = row({ channel, channelRef: channel === 'slack' ? 'bad/ref/1.0' : equivalent });
      expect(plan([a], [b])).toHaveLength(1);
      expect(plan([], [a])[0]!.delta).not.toBe(plan([], [b])[0]!.delta);
    }
  });

  it('still reports owner, claim, blocker and verification changes', () => {
    const assigned = row({ state: 'ASSIGNED', owner: 'owner', claimReceipt: 'claim', blocker: null });
    for (const changes of [{ owner: 'other' }, { claimReceipt: 'other' }]) expect(plan([assigned], [{ ...assigned, ...changes }])).toHaveLength(1);
    expect(plan([row()], [row({ blocker: { dependency: 'other', source: 'synthetic', at } })])).toHaveLength(1);
    const verified = row({ state: 'VERIFIED', blocker: null, verified: { head: 'a', source: 'synthetic', at } });
    expect(plan([verified], [{ ...verified, verified: { head: 'b', source: 'synthetic', at } }])).toHaveLength(1);
  });
});
