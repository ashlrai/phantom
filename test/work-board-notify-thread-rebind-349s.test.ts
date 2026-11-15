/** RQ-PHX-NOTIFYTHREADREBIND349S — proactive board notices follow the
 * currently bound source thread after a correction. A BLOCKED item already
 * receipted on fake Slack thread A keeps its state and dependency when a
 * later snapshot binds the same item to thread B: the production diff /
 * planner treats the reroute as one new meaningful delta, the injected
 * sender receives exactly the B binding, and the durable ledger suppresses
 * replay after the state is reloaded. An asOf-only change stays silent, and
 * a refused B delivery leaves the prior A snapshot pending without letting
 * A receive B's update or consuming the retry. All hosts, threads and
 * receipts are fake; no real transport leaves. */
import { chmodSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  boardNotifyLedgerKey, boardNotifyLedgerPath, diffBoard, planNotifications,
  readBoardNotifySent, readBoardNotifySnapshot, sendNotifications, snapshotAfterSend,
  writeBoardNotifySnapshot,
  type BoardNotice, type BoardNotifyLedgerRow, type BoardNotifySenders,
  type BoardSnapshotItem, type BoardTransition,
} from '../src/core/fleet/work-board-notify.js';

const ID = 'RQ-PHX-FAKE-349-REBIND';
const TS_A = 'T0FAKEWT/C0FAKEWT/1700000000.000349';
const TS_B = 'T0FAKEWT/C0FAKEWT/1700000000.000350';
const DEP = 'fake-dep-349-thread-rebind';
const SOURCE = 'bus-reply:fake-349-blocked';
const AT_RECEIVED = '2026-11-14T08:00:00.000Z';
const AT_BLOCKED_A = '2026-11-14T08:05:00.000Z';
const AT_BLOCKED_B = '2026-11-14T08:10:00.000Z';
const AT_ASOF_ONLY = '2026-11-14T08:15:00.000Z';

const item = (over: Partial<BoardSnapshotItem>): BoardSnapshotItem => ({
  id: ID, state: 'RECEIVED', asOf: AT_RECEIVED, source: 'receivedAt',
  owner: null, claimReceipt: null, channel: 'slack', channelRef: TS_A,
  blocker: null, verified: null, ...over,
});
const receivedA = () => item({});
const blockedA = () => item({
  state: 'BLOCKED', asOf: AT_BLOCKED_A, source: SOURCE,
  blocker: { dependency: DEP, source: SOURCE, at: AT_BLOCKED_A },
});
const blockedB = (asOf = AT_BLOCKED_B, blockerAt = asOf) => item({
  state: 'BLOCKED', asOf, source: SOURCE, channelRef: TS_B,
  blocker: { dependency: DEP, source: SOURCE, at: blockerAt },
});

describe('board-notify source-thread rebind', { timeout: 60_000 }, () => {
  let dir: string, ledgerPath: string, now: number;

  const ledgerRows = (): BoardNotifyLedgerRow[] => {
    try {
      return readFileSync(ledgerPath, 'utf8')
        .split('\n').filter(line => line.trim() !== '')
        .map(line => JSON.parse(line) as BoardNotifyLedgerRow);
    } catch { return []; }
  };
  const snapshotItem = () => readBoardNotifySnapshot(dir)?.find(i => i.id === ID);
  const runPass = async (
    next: readonly BoardSnapshotItem[],
    senders: BoardNotifySenders,
    opts: { persistSnapshot?: boolean } = {},
  ) => {
    const prev = readBoardNotifySnapshot(dir) ?? [];
    const sent = readBoardNotifySent(ledgerPath);
    if (sent === null) throw new Error('sent ledger unreadable');
    const transitions: BoardTransition[] = diffBoard(prev, next);
    const plan = planNotifications(transitions, sent);
    const results = await sendNotifications(plan.notices, { senders, ledgerPath, now: () => now });
    const pending = new Set(results
      .filter(r => r.status !== 'sent' && r.status !== 'duplicate')
      .map(r => r.notice.itemId));
    const kept = snapshotAfterSend(prev, next, pending);
    if (opts.persistSnapshot !== false) writeBoardNotifySnapshot(dir, kept);
    return { prev, next: [...next], transitions, plan, results, pending, kept };
  };
  const sentNotice = (sender: ReturnType<typeof vi.fn>, call = 0): BoardNotice =>
    sender.mock.calls[call]![0] as BoardNotice;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'board-notify-rebind-349-'));
    chmodSync(dir, 0o700);
    ledgerPath = boardNotifyLedgerPath(dir);
    now = Date.parse(AT_BLOCKED_B);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('delivers one B-bound delta for a same-state thread correction and dedupes it after reload', async () => {
    writeBoardNotifySnapshot(dir, [receivedA()]);

    // The item first becomes BLOCKED on thread A and earns a durable receipt.
    const senderA = vi.fn(async () => ({ status: 'sent' as const, receipt: 'fake-receipt-349-a' }));
    const passA = await runPass([blockedA()], { slack: senderA });
    expect(passA.results.map(r => r.status)).toEqual(['sent']);
    expect(sentNotice(senderA)).toMatchObject({
      itemId: ID, state: 'BLOCKED', sourceChannel: 'slack', sourceThread: TS_A,
    });
    const deltaA = passA.plan.notices[0]!.delta;
    expect(ledgerRows()).toEqual([expect.objectContaining({
      v: 1, itemId: ID, state: 'BLOCKED', channel: 'slack', thread: TS_A,
      receipt: 'fake-receipt-349-a', delta: deltaA,
    })]);
    expect(snapshotItem()).toMatchObject({ state: 'BLOCKED', channelRef: TS_A });

    // The correction keeps BLOCKED and the dependency but rebinds the item
    // to thread B. The state entry key already exists; because this is a
    // same-state transition the planner keys only the new B delta.
    const sentBeforeB = readBoardNotifySent(ledgerPath)!;
    expect(sentBeforeB.has(boardNotifyLedgerKey(ID, 'BLOCKED'))).toBe(true);
    expect(sentBeforeB.has(boardNotifyLedgerKey(ID, 'BLOCKED', deltaA))).toBe(true);
    const senderB = vi.fn(async () => ({ status: 'sent' as const, receipt: 'fake-receipt-349-b' }));
    const passB = await runPass([blockedB()], { slack: senderB }, { persistSnapshot: false });
    expect(passB.transitions).toHaveLength(1);
    expect(passB.transitions[0]).toMatchObject({
      itemId: ID, from: 'BLOCKED', to: 'BLOCKED',
      sourceChannel: 'slack', sourceThread: TS_B,
    });
    expect(passB.plan.dropped).toEqual([]);
    expect(passB.plan.notices).toHaveLength(1);
    expect(passB.results.map(r => r.status)).toEqual(['sent']);
    expect(senderB).toHaveBeenCalledTimes(1);
    const noticeB = sentNotice(senderB);
    expect(noticeB).toMatchObject({
      itemId: ID, state: 'BLOCKED', asOf: AT_BLOCKED_B, detail: DEP,
      source: SOURCE, sourceChannel: 'slack', sourceThread: TS_B,
    });
    expect(noticeB.delta).toMatch(/^[0-9a-f]{24}$/);
    expect(noticeB.delta).not.toBe(deltaA);
    expect(noticeB.text).toBe(`BLOCKED ${ID} as of ${AT_BLOCKED_B} — ${DEP} (source: ${SOURCE})`);

    const deltaB = noticeB.delta;
    const rowsAfterB = ledgerRows();
    expect(rowsAfterB).toHaveLength(2);
    expect(rowsAfterB[1]).toMatchObject({
      v: 1, itemId: ID, state: 'BLOCKED', channel: 'slack', thread: TS_B,
      receipt: 'fake-receipt-349-b', delta: deltaB,
    });
    const sentAfterB = readBoardNotifySent(ledgerPath)!;
    expect(sentAfterB).toEqual(new Set([
      boardNotifyLedgerKey(ID, 'BLOCKED'),
      boardNotifyLedgerKey(ID, 'BLOCKED', deltaA),
      boardNotifyLedgerKey(ID, 'BLOCKED', deltaB),
    ]));

    // Restart-equivalent reload before snapshot bookkeeping completes: the
    // ledger's B delta fences the replay even though the snapshot still
    // says A, so no sender is invoked and no second B row is appended.
    expect(snapshotItem()).toMatchObject({ state: 'BLOCKED', channelRef: TS_A });
    const replayPlan = planNotifications(
      diffBoard(readBoardNotifySnapshot(dir)!, [blockedB()]),
      readBoardNotifySent(ledgerPath)!,
    );
    expect(replayPlan.notices).toEqual([]);
    expect(replayPlan.dropped).toEqual([expect.objectContaining({
      itemId: ID, state: 'BLOCKED', reason: 'BLOCKED dropped: already notified',
    })]);
    const replaySender = vi.fn();
    await sendNotifications(replayPlan.notices, { senders: { slack: replaySender }, ledgerPath, now: () => now });
    expect(replaySender).not.toHaveBeenCalled();
    expect(ledgerRows()).toHaveLength(2);

    // Complete the bookkeeping write, then prove an asOf-only later
    // snapshot is silent: same binding, same dependency, newer timestamp.
    writeBoardNotifySnapshot(dir, passB.kept);
    expect(snapshotItem()).toMatchObject({
      state: 'BLOCKED', channelRef: TS_B, asOf: AT_BLOCKED_B,
      blocker: { dependency: DEP },
    });
    const silentSender = vi.fn();
    const passAsOf = await runPass([blockedB(AT_ASOF_ONLY, AT_BLOCKED_B)], { slack: silentSender });
    expect(passAsOf.transitions).toEqual([]);
    expect(passAsOf.plan.notices).toEqual([]);
    expect(passAsOf.plan.dropped).toEqual([]);
    expect(passAsOf.results).toEqual([]);
    expect(silentSender).not.toHaveBeenCalled();
    expect(ledgerRows()).toHaveLength(2);
    expect(snapshotItem()).toMatchObject({ state: 'BLOCKED', channelRef: TS_B, asOf: AT_ASOF_ONLY });
  });

  it('keeps a refused B delivery pending on A without consuming the retry', async () => {
    writeBoardNotifySnapshot(dir, [receivedA()]);
    const senderA = vi.fn(async () => ({ status: 'sent' as const, receipt: 'fake-receipt-349-a2' }));
    await runPass([blockedA()], { slack: senderA });
    const rowsAfterA = ledgerRows();
    expect(rowsAfterA).toHaveLength(1);
    expect(rowsAfterA[0]).toMatchObject({ thread: TS_A, receipt: 'fake-receipt-349-a2' });

    // Thread B refuses the first attempt. The result is not a receipt, so
    // the ledger stays at the A row and snapshotAfterSend keeps A pending.
    const refusedSender = vi.fn(async () => ({
      status: 'refused' as const, reason: 'fake-thread-refused',
    }));
    const refusedPass = await runPass([blockedB()], { slack: refusedSender });
    expect(refusedPass.transitions).toHaveLength(1);
    expect(refusedPass.plan.notices).toHaveLength(1);
    expect(refusedPass.results).toEqual([expect.objectContaining({
      status: 'refused', reason: 'fake-thread-refused',
    })]);
    expect(refusedSender).toHaveBeenCalledTimes(1);
    expect(sentNotice(refusedSender)).toMatchObject({
      itemId: ID, state: 'BLOCKED', sourceChannel: 'slack', sourceThread: TS_B,
    });
    expect(ledgerRows()).toEqual(rowsAfterA);
    expect(snapshotItem()).toEqual(blockedA());

    // Restart with fresh caller dependencies: the same B transition is
    // still pending, the retry is addressed to B only, and its receipt is
    // what finally advances the snapshot and ledger.
    const retrySender = vi.fn(async () => ({ status: 'sent' as const, receipt: 'fake-receipt-349-b-retry' }));
    const retryPass = await runPass([blockedB()], { slack: retrySender });
    expect(retryPass.transitions).toHaveLength(1);
    expect(retryPass.plan.notices).toHaveLength(1);
    expect(retryPass.results.map(r => r.status)).toEqual(['sent']);
    expect(retrySender).toHaveBeenCalledTimes(1);
    expect(sentNotice(retrySender)).toMatchObject({
      itemId: ID, state: 'BLOCKED', sourceChannel: 'slack', sourceThread: TS_B,
    });
    const rowsAfterRetry = ledgerRows();
    expect(rowsAfterRetry).toHaveLength(2);
    expect(rowsAfterRetry[0]).toEqual(rowsAfterA[0]);
    expect(rowsAfterRetry[1]).toMatchObject({
      v: 1, itemId: ID, state: 'BLOCKED', channel: 'slack', thread: TS_B,
      receipt: 'fake-receipt-349-b-retry',
    });
    expect(rowsAfterRetry[1]!.delta).toBeTruthy();
    expect(rowsAfterRetry[1]!.delta).not.toBe(rowsAfterA[0]!.delta);
    expect(snapshotItem()).toMatchObject({ state: 'BLOCKED', channelRef: TS_B });

    // Neither the refused attempt nor the retry ever produced an A-bound
    // notice for B's update: every post-rebind sender call carried TS_B,
    // and the only A ledger row is the original A receipt.
    for (const sender of [refusedSender, retrySender]) {
      for (const call of sender.mock.calls) {
        expect((call[0] as BoardNotice).sourceThread).toBe(TS_B);
      }
    }
    expect(ledgerRows().filter(row => row.thread === TS_A)).toHaveLength(1);
    expect(ledgerRows().filter(row => row.thread === TS_B)).toHaveLength(1);
  });
});
