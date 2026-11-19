import { describe, expect, it } from 'vitest';
import { msg } from '../leader/thread-fixtures.test-support.js';
import { askedAgo, choiceForKey, currentAsk, openLeaderAsks, stepAsk } from './leader-asks-model.js';

const NOW = Date.parse('2026-11-18T12:00:00Z');
const at = (minutesAgo: number) => new Date(NOW - minutesAgo * 60_000).toISOString();
const revision = Array(8).fill('a'.repeat(8)).join('-');

describe('openLeaderAsks', () => {
  it('lists unanswered Leader questions oldest first, keyed for the answer route', () => {
    const asks = openLeaderAsks([
      msg({ id: 'q2', at: at(5), kind: 'question', questionId: 'memo-2:0', text: 'Second?',
        questionForm: { schemaVersion: 1, revision, mode: 'single', options: ['Yes', 'No'], expiresAt: at(-60) } }),
      msg({ id: 'q1', at: at(40), kind: 'question', text: 'First?' }),
      msg({ id: 'm1', at: at(3), text: 'Not a question.' }),
    ]);
    expect(asks.map(ask => ask.key)).toEqual(['q1', 'q2']);
    expect(asks[0]).toMatchObject({ questionId: 'q1', typed: false, revision: null, text: 'First?' });
    expect(asks[1]).toMatchObject({ questionId: 'memo-2:0', typed: true, revision });
  });

  it('drops a question once the thread carries the answer, by question id or by reply', () => {
    const asks = openLeaderAsks([
      msg({ id: 'q1', at: at(40), kind: 'question', questionId: 'memo-1:0', text: 'Typed?' }),
      msg({ id: 'q2', at: at(30), kind: 'question', text: 'Replied to?' }),
      msg({ id: 'q3', at: at(20), kind: 'question', text: 'Still open?' }),
      msg({ id: 'a1', at: at(10), from: 'mason', kind: 'answer', questionId: 'memo-1:0', text: 'Yes' }),
      msg({ id: 'a2', at: at(9), from: 'mason', replyTo: 'q2', text: 'No' }),
    ]);
    expect(asks.map(ask => ask.key)).toEqual(['q3']);
  });

  it('never counts a question Mason wrote, and puts an unreadable time last with no invented age', () => {
    const asks = openLeaderAsks([
      msg({ id: 'bad', at: 'not a time', kind: 'question', text: 'When?' }),
      msg({ id: 'mine', at: at(4), from: 'mason', kind: 'question', text: 'My own question' }),
      msg({ id: 'q1', at: at(2), kind: 'question', text: 'Dated?' }),
    ]);
    expect(asks.map(ask => ask.key)).toEqual(['q1', 'bad']);
    expect(asks[1]!.atMs).toBeNull();
    expect(askedAgo(asks[1]!.atMs, NOW)).toBe('asked at an unknown time');
  });
});

describe('ask helpers', () => {
  const asks = openLeaderAsks([
    msg({ id: 'q1', at: at(125), kind: 'question', text: 'One?' }),
    msg({ id: 'q2', at: at(14), kind: 'question', text: 'Two?' }),
    msg({ id: 'q3', at: at(0), kind: 'question', text: 'Three?' }),
  ]);

  it('words the wait', () => {
    expect(asks.map(ask => askedAgo(ask.atMs, NOW))).toEqual(['asked 2h 5m ago', 'asked 14m ago', 'asked just now']);
  });

  it('keeps the picked ask while it is open and falls back to the oldest', () => {
    expect(currentAsk(asks, 'q2')!.key).toBe('q2');
    expect(currentAsk(asks, 'gone')!.key).toBe('q1');
    expect(currentAsk(asks, null)!.key).toBe('q1');
    expect(currentAsk([], 'q1')).toBeNull();
  });

  it('steps through the asks and wraps at both ends', () => {
    expect(stepAsk(asks, asks[2]!, 1).key).toBe('q1');
    expect(stepAsk(asks, asks[0]!, -1).key).toBe('q3');
    expect(stepAsk(asks, asks[0]!, 1).key).toBe('q2');
  });

  it('maps 1-9 to a choice only when that choice exists', () => {
    expect(choiceForKey('1', 2)).toBe(0);
    expect(choiceForKey('2', 2)).toBe(1);
    expect(choiceForKey('3', 2)).toBeNull();
    expect(choiceForKey('0', 2)).toBeNull();
    expect(choiceForKey('a', 2)).toBeNull();
    expect(choiceForKey('12', 20)).toBeNull();
  });
});
