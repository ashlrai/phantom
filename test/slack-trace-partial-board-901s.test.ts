import { describe, expect, it } from 'vitest';
import { joinSlackWork } from '../src/web-ui/routes/verse/fleet-channels/slack-trace-work-join.js';

const thread = '1234567890.000100';
const item = (state = 'RUNNING', id = 'fake-1') => ({
  id, state, owner: 'fake-owner', channel: 'slack', channelRef: `TFAKE/CFAKE/${thread}`,
});
const board = (items: unknown[], truncated: unknown) => ({ inbox: 'ok', items, truncated });

describe('Slack work on partial boards', () => {
  it.each(['RECEIVED', 'ASSIGNED', 'RUNNING', 'BLOCKED', 'VERIFIED'])(
    'does not attribute a single %s match on a truncated board', (state) => {
      expect(joinSlackWork(thread, 'CFAKE', board([item(state)], true))).toEqual({ kind: 'unknown' });
    },
  );

  it('preserves complete single and zero match results', () => {
    expect(joinSlackWork(thread, 'CFAKE', board([item()], false))).toEqual({
      kind: 'item', state: 'RUNNING', owner: 'fake-owner', id: 'fake-1',
    });
    expect(joinSlackWork(thread, 'CFAKE', board([], false))).toEqual({ kind: 'none' });
    expect(joinSlackWork(thread, 'CFAKE', board([], true))).toEqual({ kind: 'unknown' });
  });

  it('reports proven ambiguity even on an incomplete board', () => {
    for (const truncated of [true, false]) {
      expect(joinSlackWork(thread, 'CFAKE', board([item(), item('BLOCKED', 'fake-2')], truncated)))
        .toEqual({ kind: 'ambiguous', count: 2 });
    }
  });

  it('treats missing legacy and malformed completeness markers as unknown', () => {
    for (const truncated of [undefined, null, 'false', 0]) {
      for (const items of [[], [item()]]) {
        expect(joinSlackWork(thread, 'CFAKE', board(items, truncated))).toEqual({ kind: 'unknown' });
      }
    }
    expect(joinSlackWork(thread, 'CFAKE', { inbox: 'ok', items: [item()] })).toEqual({ kind: 'unknown' });
  });

  it('keeps unreadable boards and invalid or nonmatching rows conservative', () => {
    expect(joinSlackWork(thread, 'CFAKE', { inbox: 'unavailable', items: [item()], truncated: false }))
      .toEqual({ kind: 'unknown' });
    expect(joinSlackWork(thread, 'CFAKE', board([item('INVALID')], true))).toEqual({ kind: 'unknown' });
    expect(joinSlackWork(thread, 'COTHER', board([item()], false))).toEqual({ kind: 'none' });
  });
});
