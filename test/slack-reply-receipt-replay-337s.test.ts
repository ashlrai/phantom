import { describe, expect, it } from 'vitest';
import { bindSlackReplies, type InboundRequest, type SentReceipt } from '../src/core/agents/slack-reply-binding.js';

const now = new Date('2023-11-14T22:13:30.000Z');
const request: InboundRequest = {
  at: '2023-11-14T22:13:20.000Z', channelId: 'C0FAKE337',
  messageTs: '1700000000.000100', threadTs: '1700000000.000001',
};
const reply: SentReceipt = { channel: request.channelId, thread: request.threadTs, state: 'sent', ts: '1700000000.000200' };
const newer = { ...request, messageTs: '1700000000.000150' };
const bind = (requests: InboundRequest[], receipts: SentReceipt[]) => bindSlackReplies({ requests, receipts, now });

describe('Slack reply receipt replay uniqueness (337S)', () => {
  it('lets one sent receipt prove at most one answer when replayed in one thread', () => {
    expect(bind([request, newer], [reply, { ...reply }])).toEqual({
      answered: [{ channelId: request.channelId, threadTs: request.threadTs, messageTs: request.messageTs, replyTs: reply.ts }],
      unanswered: [newer], rejected: 0, futureDated: 0,
    });
  });

  it('collapses decimal-equivalent spellings and shuffled replays to one answer', () => {
    const spellings = ['1700000000.000200', '1700000000.0002000', '1700000000.0002'];
    const receipts = spellings.map((ts) => ({ ...reply, ts }));
    const deduped = bind([request, newer], receipts);
    expect(deduped.answered).toHaveLength(1);
    expect(deduped.unanswered).toHaveLength(1);
    expect(spellings).toContain(deduped.answered[0]!.replyTs);
    for (const shuffled of [[...receipts].reverse(), [receipts[1]!, receipts[2]!, receipts[0]!], [...receipts, { ...reply }]])
      expect(bind([newer, request], shuffled)).toEqual(deduped);
  });

  it('keeps contradictory thread claims independent: one answer per claim, never multiplied', () => {
    const otherThread = '1700000000.000002';
    const result = bind([request, { ...request, threadTs: otherThread }, { ...request, messageTs: '1700000000.000120' }],
      [reply, { ...reply }, { ...reply, thread: otherThread }]);
    expect(result.answered).toHaveLength(2);
    expect(result.unanswered).toHaveLength(1);
    expect(new Set(result.answered.map((row) => row.threadTs))).toEqual(new Set([request.threadTs, otherThread]));
  });

  it('keeps equal reply timestamps in different channels distinct', () => {
    const otherChannel = 'C0OTHER337';
    const bound = bind([{ ...request, channelId: otherChannel }, request],
      [reply, { ...reply }, { ...reply, channel: otherChannel }]);
    expect(bound.answered).toHaveLength(2);
    expect(bound.unanswered).toEqual([]);
  });

  it('still ignores attempted and top-level receipts while deduplicating, without mutating inputs', () => {
    const requests = [request, newer];
    const receipts: SentReceipt[] = [{ ...reply, state: 'attempted' }, { ...reply, thread: undefined }];
    const before = structuredClone({ requests, receipts });
    expect(bind(requests, receipts)).toEqual({ answered: [], unanswered: [request, newer], rejected: 0, futureDated: 0 });
    expect({ requests, receipts }).toEqual(before);
  });
});
