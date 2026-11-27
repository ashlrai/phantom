import { describe, expect, it, vi } from 'vitest';
import {
  diffBoard, planNotifications, sendNotifications, snapshotAfterSend,
  type BoardSendReceipt, type BoardSnapshotItem,
} from '../src/core/fleet/work-board-notify.js';

const at = '2026-11-13T22:00:00.000Z';
const item = (id: string, blocked: boolean): BoardSnapshotItem => ({
  id, state: blocked ? 'BLOCKED' : 'RECEIVED', asOf: at, source: 'fake-source',
  owner: null, claimReceipt: null, channel: 'fake', channelRef: 'fake-thread',
  blocker: blocked ? { dependency: 'dependency-a', source: 'fake-source', at } : null,
  verified: null,
});

describe('sender failure reasons', () => {
  it.each([
    ['refused', 'waiting for dependency-a', 'waiting for dependency-a'],
    ['unavailable', undefined, 'sender-reason-unavailable'],
    ['refused', ' \t\n ', 'sender-reason-unavailable'],
    ['unavailable', { message: 'private' }, 'sender-reason-unavailable'],
    ['refused', ['private'], 'sender-reason-unavailable'],
    ['unavailable', 42, 'sender-reason-unavailable'],
    ['refused', `line one\n${'😀'.repeat(200)}`, undefined],
    ['unavailable', `${'x'.repeat(245)} sk-${'a'.repeat(32)}`, undefined],
  ] as const)('normalizes %s reason and continues', async (status, reason, expected) => {
    const previous = [item('a', false), item('b', false)];
    const current = [item('a', true), item('b', true)];
    const notices = planNotifications(diffBoard(previous, current), new Set()).notices;
    const rows: string[] = [];
    const sender = vi.fn().mockResolvedValueOnce({ status, reason } as BoardSendReceipt)
      .mockResolvedValueOnce({ status: 'sent', receipt: 'receipt-b' });
    const results = await sendNotifications(notices, {
      senders: { fake: sender }, appendLedger: row => { rows.push(row.itemId); },
    });
    expect(results.map(r => r.status)).toEqual([status, 'sent']);
    const actual = results[0]!.reason!;
    if (expected !== undefined) expect(actual).toBe(expected);
    expect(actual.length).toBeLessThanOrEqual(256);
    expect(actual).not.toMatch(/[\r\n\u0085\u2028\u2029]/u);
    expect(actual).not.toMatch(/[\uD800-\uDBFF]$/u);
    expect(actual).not.toContain('sk-');
    expect(rows).toEqual(['b']);
    expect(snapshotAfterSend(previous, current, new Set(['a']))).toEqual([previous[0], current[1]]);
  });
});
