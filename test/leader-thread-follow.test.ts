import { describe, expect, it } from 'vitest';
import { followThread } from '../src/core/vision/leader-thread-follow.js';
import type { LeaderThreadMessage } from '../src/core/vision/leader-thread-types.js';

const message = (id: string): LeaderThreadMessage => ({ id, at: '', from: 'mason', channel: 'verse', kind: 'message', text: id });

describe('followThread', () => {
  it('emits the backlog and new messages once in order', async () => {
    const controller = new AbortController();
    const rows = [message('a'), message('b'), message('c')];
    const emitted: string[] = [];
    let sleeps = 0;
    await followThread({ list: () => rows, backlog: 2, signal: controller.signal,
      onMessage: m => emitted.push(m.id), sleep: async () => {
        if (++sleeps === 1) rows.push(message('d'));
        if (sleeps === 3) controller.abort();
      } });
    expect(emitted).toEqual(['b', 'c', 'd']);
  });

  it('waits for sinceId and skips all older messages', async () => {
    const controller = new AbortController();
    let polls = 0;
    const emitted: string[] = [];
    await followThread({ list: () => ++polls === 1 ? [message('a')] : [message('a'), message('b'), message('c')],
      sinceId: 'b', signal: controller.signal, onMessage: m => emitted.push(m.id),
      sleep: async () => { if (polls === 2) controller.abort(); } });
    expect(emitted).toEqual(['c']);
  });

  it('reports distinct list errors once and continues until aborted', async () => {
    const controller = new AbortController();
    const errors: unknown[] = [];
    const emitted: string[] = [];
    let polls = 0;
    await followThread({ list: () => { if (++polls < 3) throw new Error('unavailable'); return [message('a')]; },
      signal: controller.signal, onMessage: m => emitted.push(m.id), onError: e => errors.push(e),
      sleep: async () => { if (polls === 3) controller.abort(); } });
    expect(errors).toHaveLength(1);
    expect(emitted).toEqual(['a']);
    expect(polls).toBe(3);
  });
});
