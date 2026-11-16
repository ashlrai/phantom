import { describe, expect, it } from 'vitest';
import { stepMatch, threadMatches, type ThreadFindItem } from './thread-find-model.js';

const items: ThreadFindItem[] = [
  { type: 'day', key: 'day', label: 'Needle day' },
  { type: 'line', key: 'line', line: { id: 'line', at: 0, who: 'leader', source: 'thread', text: 'A Needle here', ack: null } },
  { type: 'bus', key: 'bus', row: { key: 'bus', at: '', from: 'Example Agent', kind: 'reply', excerpt: 'Other needle', expired: false } },
];

describe('thread find', () => {
  it('matches text case insensitively, trims queries, and skips days', () => {
    expect(threadMatches(items, ' NEEDLE ')).toEqual(['line', 'bus']);
    expect(threadMatches(items, 'day')).toEqual([]);
    expect(threadMatches(items, '')).toEqual([]);
    expect(threadMatches(items, '   ')).toEqual([]);
  });
  it('matches bus sender and excerpt', () => {
    expect(threadMatches(items, 'agent')).toEqual(['bus']);
    expect(threadMatches(items, 'other')).toEqual(['bus']);
  });
  it('wraps in both directions', () => {
    expect(stepMatch(1, 2, 1)).toBe(0);
    expect(stepMatch(0, 2, -1)).toBe(1);
    expect(stepMatch(0, 0, 1)).toBe(0);
  });
});
