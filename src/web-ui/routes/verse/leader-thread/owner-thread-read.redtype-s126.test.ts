import { expect, it } from 'vitest';
import type { ThreadEntry } from '../leader/thread-model.js';
import { mergeOwnerThread } from '../mobile/screens/leader-owner-model.js';
import { NO_OWNER_THREAD, parseOwnerThreadRead } from './owner-thread-queries.js';
import type { OwnerThreadRead, ReplyGapState } from './owner-thread-queries.js';

const gap = (over: Partial<ReplyGapState> = {}): ReplyGapState =>
  ({ teammate: 'Dot', unansweredCount: 2, oldestUnansweredMs: 14 * 60_000, state: 'late', ...over });

it('reads valid replyGap rows and drops malformed rows individually', () => {
  const read = parseOwnerThreadRead({ status: { replyGap: [gap(), null, {}, { ...gap(), unansweredCount: 'x' }, { ...gap(), state: 'weird' }, gap({ teammate: 'Ash', state: 'unknown' })] } });
  expect(read.replyGap).toEqual([gap(), gap({ teammate: 'Ash', state: 'unknown' })]);
});

it('returns an empty replyGap for a missing or malformed status', () => {
  expect(parseOwnerThreadRead({}).replyGap).toEqual([]);
  expect(parseOwnerThreadRead({ status: { replyGap: {} } }).replyGap).toEqual([]);
  expect(NO_OWNER_THREAD.replyGap).toEqual([]);
});

it('feeds a parsed read straight into the mobile owner-thread merge', () => {
  const read: OwnerThreadRead = parseOwnerThreadRead({
    schema: 'comms.owner-thread.v1',
    status: { replyGap: [gap()] },
    messages: [{ seq: 1, id: 'o1', channel: 'imessage', senderId: 'mason-test', direction: 'inbound', at: '2026-11-09T12:01:00.000Z', text: 'Synthetic hello' }],
  });
  const entries: ThreadEntry[] = [{ type: 'message', key: 'a', at: '2026-11-09T12:00:00.000Z', message: { id: 'a', at: '2026-11-09T12:00:00.000Z', from: 'leader', channel: 'verse', kind: 'message', text: 'Earlier' } }];
  const out = mergeOwnerThread(entries, read);
  expect(out.entries.map((e) => e.key)).toEqual(['a', 'owner-o1']);
  expect(read.replyGap).toEqual([gap()]);
});
