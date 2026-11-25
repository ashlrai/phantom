import { describe, expect, it } from 'vitest';
import { bindSlackReplies, type InboundRequest, type SentReceipt } from '../src/core/agents/slack-reply-binding.js';
import { fakeRequestId, replyKey } from './helpers/slack-causal.js';

const now = new Date('2023-11-14T22:13:30.000Z');
const requestId = fakeRequestId('938s');
const request: InboundRequest = {
  at: '2023-11-14T22:13:20.000Z', channelId: 'C0FAKE938',
  threadTs: '1700000000.000001', messageTs: '1700000000.000100', requestId,
};
const reply: SentReceipt = {
  key: replyKey(requestId), channel: request.channelId, thread: request.threadTs,
  ts: '1700000000.000200', state: 'sent',
};
const keyless: SentReceipt = { channel: reply.channel, thread: reply.thread, ts: reply.ts, state: 'sent' };
const bind = (receipts: SentReceipt[]) => bindSlackReplies({ requests: [request], receipts, now });

describe('keyless Slack physical reply evidence', () => {
  it.each(['1700000000.000200', '01700000000.0002000'])('preserves conflicting threads for %s in either order', (ts) => {
    const rows = [reply, { ...keyless, ts, thread: '1700000000.000002' }];
    for (const receipts of [rows, [...rows].reverse()]) {
      const result = bind(receipts);
      expect(result.byRequestId.get(requestId)).toEqual({ verdict: 'uncertain' });
      expect(result.answered).toEqual([]);
    }
  });

  it('treats a top-level observation as a conflict in either order', () => {
    const rows = [reply, { ...keyless, thread: undefined }];
    for (const receipts of [rows, [...rows].reverse()])
      expect(bind(receipts).byRequestId.get(requestId)).toEqual({ verdict: 'uncertain' });
  });

  it('accepts consistent duplicates but never correlates a keyless row alone', () => {
    expect(bind([reply, keyless]).answered).toHaveLength(1);
    expect(bind([keyless, reply]).answered).toHaveLength(1);
    expect(bind([keyless]).byRequestId.get(requestId)).toEqual({ verdict: 'unanswered' });
    expect(bind([reply, { ...keyless, ts: '1700000000.000300', thread: undefined }]).answered).toHaveLength(1);
    expect(bind([reply, { ...keyless, channel: 'C0OTHER938', thread: undefined }]).answered).toHaveLength(1);
  });

  it('excludes rejected, future and attempted observations from physical conflicts', () => {
    const result = bind([reply, { ...keyless, thread: 'invalid' },
      { ...keyless, ts: '1700000015.000001', thread: undefined },
      { ...keyless, state: 'attempted', thread: undefined }]);
    expect(result.answered).toHaveLength(1);
    expect(result.rejected).toBe(1);
    expect(result.futureDated).toBe(1);
  });
});
