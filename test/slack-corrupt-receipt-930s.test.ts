import { describe, expect, it } from 'vitest';
import { bindSlackReplies, type InboundRequest, type SentReceipt } from '../src/core/agents/slack-reply-binding.js';
import { fakeRequestId, replyKey } from './helpers/slack-causal.js';

const now = new Date('2023-11-14T22:13:30.000Z');
const ids = ['930a', '930b', '930c'].map(fakeRequestId);
const requests: InboundRequest[] = ids.map((requestId, i) => ({
  at: '2023-11-14T22:13:20.000Z', channelId: 'C0FAKE930', threadTs: '1700000000.000001',
  messageTs: `1700000000.00010${i}`, requestId,
}));
const sent = (i: number): SentReceipt => ({
  key: replyKey(ids[i]!), channel: requests[i]!.channelId, thread: requests[i]!.threadTs,
  state: 'sent', ts: `1700000000.00020${i}`,
});
const bind = (receipts: SentReceipt[]) => bindSlackReplies({ requests, receipts, now });
const malformed = [
  { ...sent(0), ts: 'bad' }, { ...sent(0), ts: undefined },
  { ...sent(0), channel: 'bad' }, { ...sent(0), thread: 'bad' },
  { ...sent(0), state: 'unknown' } as unknown as SentReceipt,
];

describe('corrupt exact-key Slack receipt evidence', () => {
  it.each(malformed)('keeps rejected matching evidence uncertain', (receipt) => {
    const result = bind([receipt]);
    expect(result.rejected).toBe(1);
    expect(result.byRequestId.get(ids[0]!)).toEqual({ verdict: 'uncertain' });
    expect(result.uncertain).toEqual([requests[0]]);
    expect(result.answered).toEqual([]);
    expect(result.unanswered).not.toContainEqual(requests[0]);
  });

  it.each(malformed)('cannot prove an answer with a malformed same-key duplicate in either order', (receipt) => {
    for (const rows of [[receipt, sent(0)], [sent(0), receipt]]) {
      const result = bind(rows);
      expect(result.rejected).toBe(1);
      expect(result.byRequestId.get(ids[0]!)).toEqual({ verdict: 'uncertain' });
      expect(result.answered).toEqual([]);
      expect(result.unanswered).not.toContainEqual(requests[0]);
    }
  });

  it('isolates unrelated and invalid keys while preserving a normal sent control', () => {
    const result = bind([{ ...sent(0), channel: 'bad' }, { ...sent(0), key: 'invalid', ts: 'bad' }, sent(1)]);
    expect(result.rejected).toBe(2);
    expect(result.byRequestId.get(ids[0]!)).toEqual({ verdict: 'uncertain' });
    expect(result.byRequestId.get(ids[1]!)).toEqual({ verdict: 'answered', replyTs: sent(1).ts });
    expect(result.byRequestId.get(ids[2]!)).toEqual({ verdict: 'unanswered' });
    expect(result.answered.map((row) => row.requestId)).toEqual([ids[1]]);
    expect(result.unanswered).toEqual([requests[2]]);
  });
});
