import { describe, expect, it } from 'vitest';
import type { AgentBusReceipt } from '../fleet-bus/agent-bus-queries.js';
import type { MergedLine } from './thread-merge-model.js';
import { busRepliesToMason, countNewReplies, mergeByTime } from './thread-bus-replies.js';

const receipt = (cursor: number, to = 'mason', body: unknown = { kind: 'ack', text: 'Got it' }): AgentBusReceipt => ({
  cursor, receivedAt: cursor * 1000, envelope: { id: `id-${cursor}`, from: 'claude-leader', to, priority: 'P2', ttl: 2000, body },
});
const line = (id: string, at: number): MergedLine => ({ id, at, who: 'leader', source: 'verse', text: id, ack: null });

describe('bus replies to Mason', () => {
  it('filters recipients case-insensitively, deduplicates by id and orders oldest first', () => {
    const duplicate = { ...receipt(3), envelope: { ...receipt(3).envelope, id: 'id-1' } };
    const rows = busRepliesToMason([receipt(2, 'leader'), receipt(1, 'MASON'), duplicate, receipt(4, 'other')], 5000);
    expect(rows).toEqual([{ key: 'bus-id-1', at: new Date(3000).toISOString(), from: 'claude-leader', kind: 'ack', excerpt: 'Got it', expired: true }]);
  });

  it('renders bounded text and JSON excerpts, reply references and expiry', () => {
    const rows = busRepliesToMason([receipt(2, 'mason', { kind: 'report', detail: 'x'.repeat(200), replyTo: 'fake-request' }),
      receipt(1, 'mason', { kind: 'interjection', text: 'y'.repeat(200) })], 2500);
    expect(rows.map(row => row.excerpt.length)).toEqual([120, 120]);
    expect(rows[1]?.excerpt).toMatch(/^\{"kind":"report"/);
    expect(rows[1]?.replyTo).toBe('fake-request');
    expect(rows.map(row => row.expired)).toEqual([false, false]);
    expect(countNewReplies(rows, 1000)).toBe(1);
  });

  it('inserts replies by time while retaining thread order for ties and undated entries', () => {
    const rows = busRepliesToMason([receipt(2), receipt(4)], 5000);
    const items = mergeByTime([line('one', 1000), line('two', 2000), line('three', 3000), line('unknown', NaN)], rows);
    expect(items.map(item => item.type === 'line' ? item.line.id : item.row.key))
      .toEqual(['one', 'two', 'bus-id-2', 'three', 'bus-id-4', 'unknown']);
  });
});
