import { expect, it } from 'vitest';
import { summarizeWorkBoard } from '../src/core/comms/work-board-summary.js';
import type { WorkBoardItem, WorkBoardResult } from '../src/core/comms/work-board.js';

const now = new Date('2026-11-13T20:27:00Z');
const item = (id: string, state: WorkBoardItem['state'], extra: Partial<WorkBoardItem> = {}): WorkBoardItem => ({
  id, state, channel: 'slack', channelRef: null, receivedAt: now.toISOString(), asOf: now.toISOString(),
  source: 'test', missing: [], owner: null, claimReceipt: null, ...extra,
});
const summary = (items: WorkBoardItem[], truncated = false) => summarizeWorkBoard({ items, inbox: 'ok', truncated } satisfies WorkBoardResult, now);

it('shows the structured dependency for an evidenced blocker', () => {
  expect(summary([item('b1', 'BLOCKED', { result: { kind: 'blocked', dependency: 'Security review of PR 123' } })])).toEqual([
    'Work items as of 15:27 ET: 1 BLOCKED, 0 RUNNING, 0 ASSIGNED, 0 RECEIVED, 0 VERIFIED',
    'BLOCKED b1 (slack): dependency Security review of PR 123',
  ]);
});

it('does not invent a dependency for absent, mismatched, or unknown results', () => {
  const verified = { kind: 'verified', pr: 123, head: null, tests: null, artifact: null } as const;
  expect(summary([item('a', 'BLOCKED'), item('b', 'BLOCKED', { result: verified }),
    item('c', 'BLOCKED', { result: { kind: 'blocked', dependency: ' unknown ' } })]).slice(1))
    .toEqual(['BLOCKED a (slack)', 'BLOCKED b (slack)', 'BLOCKED c (slack)']);
});

it('scrubs secrets and bounds control characters and long text to one line', () => {
  const dependency = `review\nnext\u0000 password=fakeSensitiveValue123 ${'x'.repeat(300)}`;
  const line = summary([item('b', 'BLOCKED', { result: { kind: 'blocked', dependency } })])[1];
  expect(line).toContain('dependency review next');
  expect(line).not.toContain('fakeSensitiveValue123');
  expect(line).not.toMatch(/[\p{Cc}\u2028\u2029]/u);
  expect(line.length).toBeLessThanOrEqual('BLOCKED b (slack): dependency '.length + 120);
});

it('keeps blocked-first ordering, the three-line cap, and truncation', () => {
  const lines = summary([item('r1', 'RECEIVED', { missing: ['named owner'] }), item('b1', 'BLOCKED'),
    item('r2', 'RECEIVED', { missing: ['named owner'] }), item('b2', 'BLOCKED'), item('r3', 'RECEIVED')], true);
  expect(lines).toEqual([
    'Work items as of 15:27 ET: 2 BLOCKED, 0 RUNNING, 0 ASSIGNED, 3 RECEIVED, 0 VERIFIED (latest only)',
    'BLOCKED b1 (slack)', 'BLOCKED b2 (slack)', 'RECEIVED r1 (slack): missing named owner',
  ]);
});
