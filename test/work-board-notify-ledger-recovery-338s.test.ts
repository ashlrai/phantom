/** RQ-PHX-NOTIFYLEDGERRECOVERY338S
 * 
 * Serve Mason/Dot Nov12 22:29 receipt-backed proactive updates: qualify recovery 
 * when a notification sender has acknowledged delivery but the local sent-ledger
 * append fails. This is the persistence boundary between a conversational
 * acknowledgment and durable completion.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  boardNotifyLedgerPath,
  diffBoard,
  planNotifications,
  readBoardNotifySent,
  sendNotifications,
  type BoardNotice,
  type BoardSnapshotItem,
} from '../src/core/fleet/work-board-notify.js';

const TS_A = 'T0FAKEWS/C0FAKECH/1700000000.000338';
const AT = '2026-11-13T22:30:00.000Z';

const notice = (over: Partial<BoardNotice> = {}): BoardNotice => ({
  itemId: 'req-recovery-1', state: 'BLOCKED', asOf: AT, delta: 'fake-digest-1', detail: 'fake-dep', source: 'bus-reply:rb-recovery',
  text: `BLOCKED req-recovery-1 as of ${AT} — fake-dep (source: bus-reply:rb-recovery)`,
  sourceChannel: 'slack', sourceThread: TS_A, ...over,
});

const snap = (over: Partial<BoardSnapshotItem>): BoardSnapshotItem => ({
  id: 'req-recovery-1', state: 'RECEIVED', asOf: AT, source: 'receivedAt',
  owner: null, claimReceipt: null, channel: 'slack', channelRef: TS_A,
  blocker: null, verified: null, ...over,
});

describe('ledger recovery from sent.jsonl append failure', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'board-notify-recovery-'));
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('reproduces the specific disk failure/restart scenario', async () => {
    const ledgerPath = boardNotifyLedgerPath(dir);
    
    // Setup board state
    const received = snap({});
    const blocked = snap({ state: 'BLOCKED', blocker: { dependency: 'fake-dep', source: 'bus-reply:rb-recovery', at: AT } });
    const prev = [received];
    const next = [blocked];

    // Simulate sender returning successful receipt (acknowledgement)
    const successfulSender = vi.fn().mockResolvedValue({ status: 'sent', receipt: 'stable-receipt-123' });
    
    // Simulate ledger append failure (e.g., disk full, permission denied)
    const failingAppend = vi.fn().mockImplementation(() => {
      throw new Error('disk full - cannot write sent.jsonl');
    });

    // First pass: attempt notification with ledger write failure
    const plan1 = planNotifications(diffBoard(prev, next), readBoardNotifySent(ledgerPath)!);
    expect(plan1.notices).toHaveLength(1);
    
    // This should fail to append to ledger and return 'unavailable'
    const results1 = await sendNotifications(plan1.notices, { 
      senders: { slack: successfulSender }, 
      ledgerPath: dir, 
      appendLedger: failingAppend
    });
    
    // Should return unavailable due to ledger append failure - this is the key test part
    expect(results1[0]).toMatchObject({ status: 'unavailable', reason: 'ledger-append-failed' });
    
    // The key assertion: since the ledger append failed, no record was written 
    const sentSet = readBoardNotifySent(ledgerPath);
    expect(sentSet).toBe(null);
    
    // Recovery simulation: create a working directory
    const recoveryDir = join(dir, 'recovered');
    rmSync(recoveryDir, { recursive: true, force: true });
    
    // Second pass - same notice but with recovered ledger path
    const successAppend = vi.fn();
    const results2 = await sendNotifications(plan1.notices, { 
      senders: { slack: successfulSender }, 
      ledgerPath: recoveryDir, 
      appendLedger: successAppend
    });
    
    // This should succeed now that the path works
    expect(successAppend).toHaveBeenCalledTimes(1);
    expect(results2[0]).toMatchObject({ status: 'sent' });
    
    // Third pass - verify idempotent behavior
    const plan3 = planNotifications(diffBoard(prev, next), readBoardNotifySent(recoveryDir)!);
    expect(plan3.notices).toEqual([]); // No more notices to send since it's already recorded
    
    // If we replay with the same path, no new calls should happen
    const duplicateSender = vi.fn();
    const results3 = await sendNotifications(plan3.notices, { 
      senders: { slack: duplicateSender }, 
      ledgerPath: recoveryDir,
    });
    
    // Since there's no new work, sender should not be called
    expect(duplicateSender).not.toHaveBeenCalled();
  });
});
