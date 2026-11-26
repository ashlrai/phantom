import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { WorkBoardResult } from '../src/core/comms/work-board.js';
import type { WorkItemEvidence } from '../src/core/comms/work-item-state.js';
import { boardNotifyLedgerPath, diffBoard, planNotifications, readBoardNotifySent,
  sendNotifications, snapshotBoard } from '../src/core/fleet/work-board-notify.js';

const observed = '2026-11-26T12:00:00.000Z';
const old = '2026-11-25T10:00:00.000Z';
const board = (asOf: string): WorkBoardResult => ({ inbox: 'ok', truncated: false, items: [
  { id: 'fake-verified', state: 'VERIFIED', asOf, source: 'board-source', channel: 'slack', channelRef: 'fake-thread', receivedAt: old, owner: null, claimReceipt: null, missing: [] },
  { id: 'fake-blocked', state: 'BLOCKED', asOf, source: 'board-source', channel: 'slack', channelRef: 'fake-thread', receivedAt: old, owner: null, claimReceipt: null, missing: [] },
] });

describe('outcome evidence provenance', () => {
  it('sends the persisted dates and sources once with durable receipts', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'notify-date-'));
    try {
      const evidence = (id: string): WorkItemEvidence => id === 'fake-verified'
        ? { verified: { artifact: 'fake-artifact', at: old, source: 'fake-verification' } }
        : { blocker: { dependency: 'fake-dependency', at: old, source: 'fake-blocker' } };
      const snapshot = snapshotBoard(board(observed), evidence);
      const transitions = diffBoard([], snapshot);
      expect(transitions[0]!.evidence).toMatchObject({ evidenceAt: old, evidenceSource: 'fake-verification' });
      expect(transitions[1]!.evidence).toMatchObject({ evidenceAt: old, evidenceSource: 'fake-blocker' });
      const ledgerPath = boardNotifyLedgerPath(dir);
      const plan = planNotifications(transitions, readBoardNotifySent(ledgerPath)!);
      expect(plan.notices.map(n => n.text)).toEqual([
        `VERIFIED fake-verified as of ${observed} — fake-artifact (evidence date: ${old}; evidence source: fake-verification) (source: board-source)`,
        `BLOCKED fake-blocked as of ${observed} — fake-dependency (evidence date: ${old}; evidence source: fake-blocker) (source: board-source)`,
      ]);
      const sender = vi.fn().mockResolvedValue({ status: 'sent', receipt: 'fake-receipt' });
      expect((await sendNotifications(plan.notices, { senders: { slack: sender }, ledgerPath })).map(r => r.status)).toEqual(['sent', 'sent']);
      const rows = readFileSync(ledgerPath, 'utf8').trim().split('\n').map(line => JSON.parse(line));
      expect(rows).toHaveLength(2);
      expect(rows.map(row => row.receipt)).toEqual(['fake-receipt', 'fake-receipt']);
      const later = snapshotBoard(board('2026-11-27T12:00:00.000Z'), evidence);
      expect(diffBoard(snapshot, later)).toEqual([]);
      expect(planNotifications(diffBoard([], later), readBoardNotifySent(ledgerPath)!).notices).toEqual([]);
      expect(sender).toHaveBeenCalledTimes(2);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it.each([undefined, '', 'not-a-date', '2026-02-30T10:00:00Z'])('labels invalid date %s unknown', at => {
    const evidence = { verified: { artifact: 'fake-artifact', at, source: 'fake\nsource' } } as WorkItemEvidence;
    const snapshot = snapshotBoard({ ...board(observed), items: [board(observed).items[0]!] }, () => evidence);
    const text = planNotifications(diffBoard([], snapshot), new Set()).notices[0]!.text;
    expect(text).toContain('evidence date: unknown; evidence source: fake source');
    expect(text).not.toContain('\n');
  });
});
