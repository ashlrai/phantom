import { describe, expect, it, vi } from 'vitest';
import type { WorkBoardItem, WorkBoardResult } from '../src/core/comms/work-board.js';
import { diffBoard, planNotifications, snapshotBoard } from '../src/core/fleet/work-board-notify.js';

const at = '2026-11-12T22:30:00.000Z';
const source = 'bus-reply:fake-a';
const item = (over: Partial<WorkBoardItem>): WorkBoardItem => ({
  id: 'fake-request', channel: 'slack', channelRef: 'fake-thread', receivedAt: at,
  state: 'VERIFIED', asOf: at, source, missing: [], owner: 'fake-owner',
  claimReceipt: 'fake-claim', ...over,
});
const board = (row: WorkBoardItem): WorkBoardResult => ({ items: [row], inbox: 'ok', truncated: false });
const plan = (snapshot: ReturnType<typeof snapshotBoard>) => planNotifications(diffBoard([], snapshot), new Set());
const verified = { kind: 'verified' as const, pr: 42, head: null, tests: 'passed-a', artifact: null };
const later = { verified: { pr: 99, source: 'bus-reply:fake-b', at: 'later' },
  blocker: { dependency: 'dependency-b', source: 'bus-reply:fake-b', at: 'later' } };

describe('snapshot board evidence consistency', () => {
  it('uses the listed verification without rereading and omits null fields', () => {
    const read = vi.fn(() => later);
    const snapshot = snapshotBoard(board(item({ result: verified })), read);
    expect(read).not.toHaveBeenCalled();
    expect(snapshot[0]).toMatchObject({ owner: 'fake-owner', claimReceipt: 'fake-claim', channel: 'slack', channelRef: 'fake-thread',
      verified: { pr: 42, tests: 'passed-a', source, at } });
    expect(snapshot[0]!.verified).not.toHaveProperty('head');
    expect(snapshot[0]!.verified).not.toHaveProperty('artifact');
    expect(plan(snapshot).notices[0]).toMatchObject({ detail: 'PR #42 tests passed-a', source, asOf: at, sourceThread: 'fake-thread' });
  });

  it('uses the listed blocker and its provenance', () => {
    const read = vi.fn(() => later);
    const snapshot = snapshotBoard(board(item({ state: 'BLOCKED', result: { kind: 'blocked', dependency: 'dependency-a' } })), read);
    expect(read).not.toHaveBeenCalled();
    expect(snapshot[0]!.blocker).toEqual({ dependency: 'dependency-a', source, at });
    expect(plan(snapshot).notices[0]).toMatchObject({ detail: 'dependency-a', source, asOf: at });
  });

  it('does not call a throwing reader for a coherent result', () => {
    const read = vi.fn(() => { throw new Error('unexpected read'); });
    expect(plan(snapshotBoard(board(item({ result: verified })), read)).notices).toHaveLength(1);
    expect(read).not.toHaveBeenCalled();
  });

  it('retains the reader fallback for legacy result-less items', () => {
    const read = vi.fn(() => later);
    const snapshot = snapshotBoard(board(item({})), read);
    expect(read).toHaveBeenCalledOnce();
    expect(plan(snapshot).notices[0]!.detail).toBe('PR #99');
  });

  it('does not invent proof without a result or callback', () => {
    const result = plan(snapshotBoard(board(item({}))));
    expect(result.notices).toEqual([]);
    expect(result.dropped[0]!.reason).toContain('no PR');
  });

  it('does not fall back or invent proof for a mismatched result', () => {
    const read = vi.fn(() => later);
    const result = plan(snapshotBoard(board(item({ result: { kind: 'blocked', dependency: 'dependency-a' } })), read));
    expect(read).not.toHaveBeenCalled();
    expect(result.notices).toEqual([]);
    expect(result.dropped).toHaveLength(1);
  });
});
