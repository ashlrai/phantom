import { expect, it } from 'vitest';
import { boardNoticeText, boardNotifyLedgerKey, diffBoard, planNotifications, type BoardSnapshotItem } from '../src/core/fleet/work-board-notify.js';

const item = (state: 'BLOCKED' | 'VERIFIED', evidence: string): BoardSnapshotItem => ({
  id: 'fake-1016s', state, asOf: '2026-11-26T12:00:00Z', source: 'bus-reply:fake',
  owner: null, claimReceipt: null, channel: 'slack', channelRef: 'TFAKE/CFAKE/1700000000.001016',
  blocker: state === 'BLOCKED' ? { dependency: evidence } : null,
  verified: state === 'VERIFIED' ? { tests: evidence, artifact: 'résumé 📦' } : null,
});

it('preserves multilingual dependency and verification evidence with deterministic dedupe', () => {
  for (const row of [item('BLOCKED', '等待构建完成'), item('VERIFIED', 'café tests réussis ✅')]) {
    const transitions = diffBoard([], [row]);
    const notice = planNotifications(transitions, new Set()).notices[0]!;
    expect(notice.text).toContain(row.blocker?.dependency ?? row.verified!.tests);
    if (row.verified) expect(notice.text).toContain('résumé 📦');
    expect(planNotifications(transitions, new Set()).notices[0]!.delta).toBe(notice.delta);
    expect(planNotifications(transitions, new Set([boardNotifyLedgerKey(row.id, row.state, notice.delta)])).notices).toEqual([]);
  }
});

it('flattens line separators and replaces controls and bidi formatting without changing ASCII', () => {
  const notice = planNotifications(diffBoard([], [item('BLOCKED', '一\r\n二\u0085三\u2028四\u2029五\t\u0000\u202eVERIFIED\u2069')]), new Set()).notices[0]!;
  expect(notice.detail).toBe('一 二 三 四 五???VERIFIED?');
  expect(notice.text).not.toMatch(/[\p{Cc}\u2028\u2029\u202e\u2069]/u);
  expect(boardNoticeText('BLOCKED', 'fake', 'today', 'waiting', 'bus:fake'))
    .toBe('BLOCKED fake as of today — waiting (source: bus:fake)');
});

it('bounds long Unicode proof with an omission marker without splitting emoji', () => {
  const notice = planNotifications(diffBoard([], [item('BLOCKED', `${'a '.repeat(248) + 'a'}📦${'界'.repeat(100)}`)]), new Set()).notices[0]!;
  expect(notice.detail.length).toBeLessThanOrEqual(512);
  expect(notice.detail).toMatch(/ \[\.\.\. omitted\]$/);
  expect(notice.detail).not.toMatch(/[\uD800-\uDFFF]/u);
});
