import { describe, expect, it } from 'vitest';
import { bindSlackReplies, type InboundRequest, type SentReceipt } from '../src/core/agents/slack-reply-binding.js';
import { fakeRequestId, replyKey } from './helpers/slack-causal.js';

const now = new Date('2023-11-14T22:13:30.000Z');
const requestId = fakeRequestId('337s');
const request: InboundRequest = {
  at: '2023-11-14T22:13:20.000Z', channelId: 'C0FAKE337',
  messageTs: '1700000000.000100', threadTs: '1700000000.000001', requestId,
};
const reply: SentReceipt = { key: replyKey(requestId), channel: request.channelId, thread: request.threadTs, state: 'sent', ts: '1700000000.000200' };
const newer: InboundRequest = { ...request, messageTs: '1700000000.000150', requestId: fakeRequestId('337s-newer') };
const bind = (requests: InboundRequest[], receipts: SentReceipt[]) => bindSlackReplies({ requests, receipts, now });
const plain = (b: ReturnType<typeof bind>) => ({ ...b, byRequestId: [...b.byRequestId] });

describe('Slack reply receipt replay uniqueness (337S)', () => {
  it('lets one sent receipt prove only its own request when replayed in one thread', () => {
    const result = bind([request, newer], [reply, { ...reply }]);
    expect(result.answered).toEqual([{ channelId: request.channelId, threadTs: request.threadTs,
      messageTs: request.messageTs, replyTs: reply.ts, requestId, at: request.at }]);
    expect(result.unanswered).toEqual([newer]);
  });

  it('collapses decimal-equivalent spellings and shuffled replays to one answer', () => {
    const spellings = ['1700000000.000200', '1700000000.0002000', '1700000000.0002'];
    const receipts = spellings.map((ts) => ({ ...reply, ts }));
    const deduped = bind([request, newer], receipts);
    expect(deduped.answered).toHaveLength(1);
    expect(deduped.unanswered).toEqual([newer]);
    expect(spellings).toContain(deduped.answered[0]!.replyTs);
    for (const shuffled of [[...receipts].reverse(), [receipts[1]!, receipts[2]!, receipts[0]!], [...receipts, { ...reply }]])
      expect(plain(bind([newer, request], shuffled))).toEqual(plain(deduped));
  });

  it('treats contradictory thread claims for one physical send as no answer', () => {
    const otherThread = '1700000000.000002';
    const result = bind([request, { ...request, threadTs: otherThread, requestId: fakeRequestId('337s-other') }, newer],
      [reply, { ...reply }, { ...reply, thread: otherThread, key: replyKey(fakeRequestId('337s-other')) }]);
    expect(result.answered).toHaveLength(0);
    expect(result.rejected).toBe(0);
    expect(result.uncertain.length + result.unanswered.length).toBe(3);
  });

  it('keeps equal reply timestamps in different channels distinct', () => {
    const otherId = fakeRequestId('337s-channel');
    const bound = bind([{ ...request, channelId: 'C0OTHER337', requestId: otherId }, request],
      [reply, { ...reply }, { ...reply, channel: 'C0OTHER337', key: replyKey(otherId) }]);
    expect(bound.answered).toHaveLength(2);
    expect(bound.unanswered).toEqual([]);
  });

  it('still ignores attempted and keyless receipts while deduplicating, without mutating inputs', () => {
    const requests = [request, newer];
    const receipts: SentReceipt[] = [{ ...reply, state: 'attempted' }, { ...reply, key: undefined }];
    const before = structuredClone({ requests, receipts });
    const result = bind(requests, receipts);
    expect(result.answered).toEqual([]);
    expect(result.uncertain).toEqual([request]);
    expect(result.unanswered).toEqual([newer]);
    expect({ requests, receipts }).toEqual(before);
  });
});
