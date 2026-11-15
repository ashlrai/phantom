import { expect, it } from 'vitest';
import { composeOwnerStatusReply } from '../src/core/agents/owner-status-reply.js';
import type { WorkBoardItem, WorkBoardResult } from '../src/core/comms/work-board.js';

const now = new Date('2026-11-13T20:27:00Z'); // 15:27 ET
const item = (id: string, state: WorkBoardItem['state'], missing: string[] = []): WorkBoardItem =>
  ({ id, channel: 'slack', channelRef: null, receivedAt: now.toISOString(), state, asOf: now.toISOString(), source: 'test', missing });
const brief = async () => 'Morning leader brief\nShipped (last 12h): 3 fake PRs';
const board = (items: WorkBoardItem[]): WorkBoardResult => ({ items, inbox: 'ok', truncated: false });

it('appends counts then a BLOCKED line after the digest', async () => {
  const reply = await composeOwnerStatusReply('/x', now, { brief, board: () => board([
    item('fake-id-0000000001', 'BLOCKED'), item('r2', 'RUNNING'), item('a3', 'ASSIGNED'), item('v4', 'VERIFIED'),
    item('fake-recv-000000009', 'RECEIVED', ['named owner']),
  ]) });
  const lines = reply.split('\n');
  expect(lines[0]).toBe('Phantom status, 15:27 ET');
  expect(lines[1]).toContain('Shipped');
  expect(lines[2]).toBe('Work items as of 15:27 ET: 1 BLOCKED, 1 RUNNING, 1 ASSIGNED, 1 RECEIVED, 1 VERIFIED');
  expect(lines[3]).toBe('BLOCKED fake-id-0000 (slack)');
  expect(lines[4]).toBe('RECEIVED fake-recv-00 (slack): missing named owner');
});

it('prints one unknown line, never zero counts, for an unreadable inbox', async () => {
  const reply = await composeOwnerStatusReply('/x', now, { brief, board: () => ({ items: [], inbox: 'unavailable', truncated: false }) });
  expect(reply.endsWith('\nWork items: unknown (bus inbox unreadable)')).toBe(true);
  expect(reply).not.toMatch(/\b0 (BLOCKED|RUNNING)/);
});

it('keeps the digest intact when the board read throws', async () => {
  const reply = await composeOwnerStatusReply('/x', now, { brief, board: () => { throw new Error('boom'); } });
  expect(reply).toBe('Phantom status, 15:27 ET\nShipped (last 12h): 3 fake PRs\nWork items: unknown (bus inbox unreadable)');
});

it('trims summary lines first and stays within 1500 chars', async () => {
  const long = async () => `Morning leader brief\n${'d'.repeat(1470)}`;
  const reply = await composeOwnerStatusReply('/x', now, { brief: long, board: () => board([item('b1', 'BLOCKED')]) });
  expect(reply.length).toBeLessThanOrEqual(1500);
  expect(reply).toContain('d'.repeat(1400));
  expect(reply).not.toContain('BLOCKED');
  const huge = await composeOwnerStatusReply('/x', now, { brief: async () => `Morning leader brief\n${'d'.repeat(3000)}`, board: () => board([]) });
  expect(huge.length).toBe(1500);
});

it('never leaks body-like text', async () => {
  const reply = await composeOwnerStatusReply('/x', now, { brief, board: () => board([item('b1', 'BLOCKED')]) });
  expect(reply).not.toContain('SENTINEL');
});

it('falls back when the digest fails, as before', async () => {
  const reply = await composeOwnerStatusReply('/x', now, { brief: async () => { throw new Error('x'); }, board: () => board([]) });
  expect(reply).toMatch(/status read failed/);
});
