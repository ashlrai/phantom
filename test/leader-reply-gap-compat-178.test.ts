// RQ-PHX-REDTYPEFIXC164 — regression for PR #4939's Quick typecheck fix:
// `OwnerThreadRead.replyGap` must stay optional. #4939 made it required, so
// leader-owner-model.test.ts's literal reads ({ paused, channels, lines })
// failed TS2741 in the web typecheck. The type is additive metadata — absent
// on reads from daemons that predate reply-gap reporting — and every consumer
// (OwnerChannelsStrip's `replyGap = []` default, parse's own `[]` fill) already
// tolerates it missing.
import { describe, expect, it } from 'vitest';
import { mergeOwnerThread } from '../src/web-ui/routes/verse/mobile/screens/leader-owner-model.js';
import { NO_OWNER_THREAD, parseOwnerThreadRead, type OwnerThreadRead } from '../src/web-ui/routes/verse/leader-thread/owner-thread-queries.js';
import type { ThreadEntry } from '../src/web-ui/routes/verse/leader/thread-model.js';

const entry = (id: string): ThreadEntry => ({
  type: 'message', key: id, at: '2026-11-09T12:00:00.000Z',
  message: { id, at: '2026-11-09T12:00:00.000Z', from: 'mason', channel: 'imessage', kind: 'message', text: 'hi' },
});

describe('OwnerThreadRead.replyGap', () => {
  it('stays optional: a paused read built without replyGap typechecks and merges to a no-op', () => {
    // This literal shape is exactly what leader-owner-model.test.ts builds;
    // it broke the web typecheck while replyGap was required.
    const read: OwnerThreadRead = { paused: true, channels: [], lines: [] };
    expect(mergeOwnerThread([entry('a')], read).entries).toHaveLength(1);
    expect(read.replyGap).toBeUndefined();
  });

  it('parses well-formed replyGap rows and drops malformed ones', () => {
    const out = parseOwnerThreadRead({
      status: {
        paused: false,
        replyGap: [
          { teammate: 'Ashlr.', unansweredCount: 2, oldestUnansweredMs: 360_000, state: 'late' },
          { teammate: 'B', unansweredCount: 'two', oldestUnansweredMs: 0, state: 'ok' },
          { teammate: 'C', unansweredCount: 1, oldestUnansweredMs: 0, state: 'bogus' },
          'not-a-row',
        ],
      },
    });
    expect(out.replyGap).toEqual([
      { teammate: 'Ashlr.', unansweredCount: 2, oldestUnansweredMs: 360_000, state: 'late' },
    ]);
  });

  it('fills replyGap with [] when the daemon omits it and NO_OWNER_THREAD ships it', () => {
    expect(parseOwnerThreadRead({ status: { paused: false } }).replyGap).toEqual([]);
    expect(NO_OWNER_THREAD.replyGap).toEqual([]);
  });
});
