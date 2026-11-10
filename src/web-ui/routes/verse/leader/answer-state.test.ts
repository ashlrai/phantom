import { describe, expect, it } from 'vitest';
import { answerStates, OVERDUE_AFTER_MS } from './answer-state.js';
import { msg } from './thread-fixtures.test-support.js';

const T0 = Date.parse('2026-11-09T10:00:00Z');
const at = (min: number) => new Date(T0 + min * 60_000).toISOString();

describe('answerStates', () => {
  it('a replyTo match wins over order', () => {
    const states = answerStates([
      msg({ id: 'm1', from: 'mason', at: at(0) }),
      msg({ id: 'l1', at: at(1) }),
      msg({ id: 'l2', at: at(5), replyTo: 'm1' }),
    ], T0 + 6 * 60_000);
    expect(states.get('m1')).toEqual({ state: 'answered', answeredBy: 'l2', afterMs: 5 * 60_000 });
  });

  it('a Leader update, memo or action does not answer', () => {
    const states = answerStates([
      msg({ id: 'm1', from: 'mason', at: at(0) }),
      msg({ id: 'u', kind: 'update', at: at(1) }),
      msg({ id: 'memo', kind: 'memo', at: at(2) }),
      msg({ id: 'act', kind: 'action', at: at(3) }),
    ], T0 + 4 * 60_000);
    expect(states.get('m1')).toEqual({ state: 'waiting', waitingMs: 4 * 60_000, overdue: false });
  });

  it("Mason's second message ends the first one's window", () => {
    const states = answerStates([
      msg({ id: 'm1', from: 'mason', at: at(0) }),
      msg({ id: 'm2', from: 'mason', at: at(1) }),
      msg({ id: 'l1', at: at(2) }),
    ], T0 + 3 * 60_000);
    expect(states.get('m1')?.state).toBe('waiting');
    expect(states.get('m2')).toMatchObject({ state: 'answered', answeredBy: 'l1' });
  });

  it('flips to overdue past 10 minutes', () => {
    const list = [msg({ id: 'm1', from: 'mason', at: at(0) })];
    expect(answerStates(list, T0 + OVERDUE_AFTER_MS).get('m1')).toMatchObject({ overdue: false });
    expect(answerStates(list, T0 + OVERDUE_AFTER_MS + 1).get('m1')).toMatchObject({ overdue: true });
  });

  it('gives an empty map for a Leader-only thread', () => {
    expect(answerStates([msg({ id: 'l1' }), msg({ id: 'l2', kind: 'update' })], Date.now()).size).toBe(0);
  });
});
