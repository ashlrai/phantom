import { describe, expect, it } from 'vitest';
import { bindSlackReplies, type InboundRequest, type SentReceipt } from '../src/core/agents/slack-reply-binding.js';
import { fakeRequestId, replyKey } from './helpers/slack-causal.js';

const now = new Date('2023-11-14T22:13:30.000Z');
const requestId = fakeRequestId('decimal-961');
const request: InboundRequest = {
  at: '2023-11-14T22:13:20.000Z', channelId: 'C0FAKE961', requestId,
  threadTs: '1700000000.100', messageTs: '1700000000.200',
};
const duplicate = { ...request, threadTs: '1700000000.1000', messageTs: '1700000000.2000' };
const reply: SentReceipt = {
  key: replyKey(requestId), channel: request.channelId, thread: '1700000000.10',
  state: 'sent', ts: '1700000000.3000',
};
const bind = (requests: InboundRequest[], receipts: SentReceipt[]) => bindSlackReplies({ requests, receipts, now });

describe('decimal Slack request identity', () => {
  it('shares one answered verdict across equivalent duplicates and input permutations', () => {
    const unrelated: SentReceipt = { ...reply, key: replyKey(fakeRequestId('other-961')), ts: '1700000000.400' };
    for (const requests of [[request, duplicate], [duplicate, request]]) {
      for (const receipts of [[reply, unrelated], [unrelated, reply]]) {
        const result = bind(requests, receipts);
        expect(result.answered).toEqual([{ ...request, replyTs: reply.ts }]);
        expect(result.byRequestId.get(requestId)).toEqual({ verdict: 'answered', replyTs: reply.ts });
        expect(result.uncertain).toEqual([]);
        expect(result.rejected).toBe(0);
      }
    }
  });

  it('matches an equivalent sent thread for a single request without rewriting evidence', () => {
    expect(bind([duplicate], [reply]).answered).toEqual([{ ...duplicate, replyTs: reply.ts }]);
  });

  it('keeps distinct request locations uncertain, including high precision differences', () => {
    for (const other of [
      { ...request, channelId: 'C0OTHER961' },
      { ...request, threadTs: '1700000000.1000000001' },
      { ...request, messageTs: '1700000000.2000000001' },
    ]) {
      const result = bind([request, other], [reply]);
      expect(result.answered).toEqual([]);
      expect(result.uncertain).toHaveLength(2);
      expect(result.byRequestId.get(requestId)).toEqual({ verdict: 'uncertain' });
    }
  });

  it('keeps mismatched or absent sent locations uncertain and other keys unanswered', () => {
    for (const receipt of [
      { ...reply, channel: 'C0OTHER961' },
      { ...reply, thread: '1700000000.1000000001' },
      { ...reply, thread: undefined },
    ]) {
      const result = bind([request], [receipt]);
      expect(result.byRequestId.get(requestId)).toEqual({ verdict: 'uncertain' });
      expect(result.answered).toEqual([]);
    }
    const result = bind([request], [{ ...reply, key: replyKey(fakeRequestId('other-961')) }]);
    expect(result.unanswered).toEqual([request]);
    expect(result.answered).toEqual([]);
  });
});
