import { describe, expect, it } from 'vitest';
import type { AgentBusReceipt } from '../fleet-bus/agent-bus-queries.js';
import { chipText, unreadForMason } from './bus-unread.js';

const receipt = (cursor: number, to: string, from = 'claude-leader'): AgentBusReceipt => ({
  cursor, receivedAt: 1_000, envelope: { id: `fake-${cursor}`, from, to, priority: 'P2', ttl: 1000, body: null },
});

describe('unreadForMason', () => {
  it('counts only receipts addressed to Mason above the seen cursor, regardless of order or casing', () => {
    const rows = [receipt(5, 'MASON', 'other-leader'), receipt(2, 'mason'), receipt(8, 'leader'), receipt(4, 'mason')];
    expect(unreadForMason(rows, 2, 2_000)).toMatchObject({ count: 2, newestCursor: 5, newestFrom: 'other-leader' });
    expect(unreadForMason(rows, 5, 2_000)).toEqual({ count: 0, newestCursor: null, newestFrom: null, newestAgeText: null });
  });
  it('provides the newest receipt age', () => {
    expect(unreadForMason([receipt(1, 'mason')], 0, 61_000).newestAgeText).toBe('1m ago');
  });
  it('uses the sender only in the singular text', () => {
    expect(chipText(1, 'claude-leader')).toBe('1 new for you on the bus (from claude-leader)');
    expect(chipText(2, 'claude-leader')).toBe('2 new for you on the bus');
  });
});
