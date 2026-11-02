import { describe, expect, it } from 'vitest';
import type { AgentBusReceipt } from './agent-bus-queries.js';
import { replyCounts, threadHeadline, threadOf } from './bus-thread-model.js';

const row = (id: string, cursor: number, receivedAt: number, replyTo?: string): AgentBusReceipt => ({
  cursor, receivedAt, envelope: { id, from: id, to: 'all', priority: 'P2', ttl: 100000, body: { text: id, replyTo } },
});

describe('bus threads', () => {
  it('finds ancestors and all descendants, ordered by time then cursor', () => {
    const messages = [row('root', 1, 100), row('child', 4, 300, 'root'), row('sibling', 2, 200, 'root'),
      row('grandchild', 3, 300, 'child'), row('other', 5, 400)];
    const thread = threadOf(messages, 'grandchild');
    expect(thread).toEqual({ rootId: 'root', ids: ['root', 'sibling', 'grandchild', 'child'] });
    expect(threadHeadline(thread, messages, 120300)).toBe('Thread · 4 messages · last reply from child 2 min ago');
  });

  it('terminates on cycles and includes each reachable envelope once', () => {
    const messages = [row('a', 1, 1, 'b'), row('b', 2, 2, 'a'), row('c', 3, 3, 'a')];
    expect(threadOf(messages, 'a')).toEqual({ rootId: 'b', ids: ['a', 'b', 'c'] });
  });

  it('keeps a missing parent outside the thread and handles unknown ids', () => {
    const messages = [row('orphan', 1, 1, 'missing'), row('reply', 2, 2, 'orphan')];
    expect(threadOf(messages, 'orphan')).toEqual({ rootId: 'orphan', ids: ['orphan', 'reply'] });
    expect(threadOf(messages, 'unknown')).toEqual({ rootId: 'unknown', ids: [] });
    expect(threadHeadline(threadOf([messages[0]!], 'orphan'), messages)).toBe('Thread · 1 message');
  });

  it('bounds ancestor traversal to 50 hops', () => {
    const messages = Array.from({ length: 53 }, (_, i) => row(String(i), i + 1, i, i ? String(i - 1) : undefined));
    const thread = threadOf(messages, '52');
    expect(thread.rootId).toBe('2');
    expect(thread.ids).toHaveLength(51);
    expect(thread.ids.at(-1)).toBe('52');
  });

  it('counts direct replies, including those whose parent is not loaded', () => {
    const messages = [row('root', 1, 1), row('a', 2, 2, 'root'), row('b', 3, 3, 'root'),
      row('c', 4, 4, 'a'), row('orphan', 5, 5, 'missing')];
    expect([...replyCounts(messages)]).toEqual([['root', 2], ['a', 1], ['missing', 1]]);
    expect(replyCounts(messages).has('b')).toBe(false);
  });
});
