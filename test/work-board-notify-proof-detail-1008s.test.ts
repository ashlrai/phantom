import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import {
  boardNotifyLedgerPath, diffBoard, planNotifications, readBoardNotifySent,
  readBoardNotifySnapshot, sendNotifications, writeBoardNotifySnapshot, type BoardSnapshotItem,
} from '../src/core/fleet/work-board-notify.js';

const item = (verified: BoardSnapshotItem['verified']): BoardSnapshotItem => ({
  id: 'fake-proof-1008s', state: 'VERIFIED', asOf: '2026-11-26T12:00:00Z',
  source: 'bus-reply:fake-proof-1008s', owner: null, claimReceipt: null,
  channel: 'slack', channelRef: 'TFAKE/CFAKE/1700000000.001008', blocker: null, verified,
});
const plan = (row: BoardSnapshotItem) => planNotifications(diffBoard([], [row]), new Set());

it('retains full persisted proof and exact source thread, with durable and snapshot dedupe', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'proof-1008s-'));
  try {
    // Every string reaches the snapshot reader limit, with identifying ends.
    const head = `${'h/'.repeat(249)}-fake-head-end`;
    const tests = `${'fake suite; '.repeat(42)}PASS 8/8`;
    const artifact = `https://example.invalid/${'x/'.repeat(238)}proofend.tgz`;
    expect([head.length, tests.length, artifact.length]).toEqual([512, 512, 512]);
    const row = item({ pr: 1008, head, tests, artifact });
    writeBoardNotifySnapshot(dir, [row]);
    const persisted = readBoardNotifySnapshot(dir)!;
    expect(persisted).toEqual([row]);
    const transitions = diffBoard([{ ...row, state: 'RUNNING', verified: null }], persisted);
    const notice = planNotifications(transitions, new Set()).notices[0]!;
    expect(notice.detail).toBe(`PR #1008 head ${head} tests ${tests} artifact ${artifact}`);
    for (const proof of [head, tests, artifact]) expect(notice.text).toContain(proof);
    expect(notice.detail.length).toBeLessThanOrEqual(1600);
    expect(notice).toMatchObject({ sourceChannel: row.channel, sourceThread: row.channelRef });
    const ledgerPath = boardNotifyLedgerPath(dir);
    const results = await sendNotifications([notice], {
      ledgerPath, senders: { slack: received => {
        expect(received).toBe(notice);
        return { status: 'sent', receipt: 'fake-receipt-1008s' };
      } },
    });
    expect(results[0]!.status).toBe('sent');
    expect(planNotifications(transitions, readBoardNotifySent(ledgerPath)!).notices).toEqual([]);
    expect(diffBoard(persisted, [{ ...row, asOf: '2026-11-26T12:01:00Z' }])).toEqual([]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

it('keeps a lone artifact compatible and marks every oversized direct proof field', () => {
  expect(plan(item({ artifact: 'fake-proof.tgz' })).notices[0]!.detail).toBe('fake-proof.tgz');
  const oversized = `${'fake proof; '.repeat(200)}end`;
  const notice = plan(item({ pr: 1008, head: oversized, tests: oversized, artifact: oversized })).notices[0]!;
  expect(notice.detail.match(/\[\.\.\. omitted\]/g)).toHaveLength(3);
  expect(notice.detail).toMatch(/^PR #1008 head .* tests .* artifact /);
  expect(notice.detail.length).toBeLessThanOrEqual(1600);
  expect(notice.text).not.toContain('end');
});

it('flattens newlines and scrubs plainly fake secret assignments before bounding', () => {
  const notice = plan(item({
    head: 'fake-head\r\nend', tests: 'fake suite\nPASS\t8/8',
    artifact: `${'x/'.repeat(240)} API_TOKEN=plainly-fake-noncredential-value\nproof.tgz`,
  })).notices[0]!;
  expect(notice.text).toContain('head fake-head end tests fake suite PASS?8/8');
  expect(notice.text).toContain('[REDACTED]');
  expect(notice.text).not.toContain('plainly-fake-noncredential-value');
  expect(notice.text).not.toMatch(/[\r\n]/);
});
