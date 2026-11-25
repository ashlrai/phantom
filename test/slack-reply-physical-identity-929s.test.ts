import { describe, expect, it } from 'vitest';
import { bindSlackReplies, type InboundRequest, type SentReceipt } from '../src/core/agents/slack-reply-binding.js';
import { traceSlackRequests } from '../src/core/agents/slack-request-trace.js';
import { fakeRequestId, replyKey } from './helpers/slack-causal.js';

const now = new Date('2023-11-14T22:13:30.000Z');
const ids = [fakeRequestId('929a'), fakeRequestId('929b')];
const requests: InboundRequest[] = ids.map((requestId, i) => ({
  at: '2023-11-14T22:13:20.000Z', channelId: 'C0FAKE929', threadTs: '1700000000.000001',
  messageTs: i === 0 ? '1700000000.000100' : '1700000000.000150', requestId,
}));
const sent = (i: number, ts = '1700000000.000200'): SentReceipt => ({
  key: replyKey(ids[i]!), channel: requests[0]!.channelId, thread: requests[0]!.threadTs, state: 'sent', ts,
});
const bind = (receipts: SentReceipt[]) => bindSlackReplies({ requests, receipts, now });

describe('Slack physical reply causal identity', () => {
  it.each(['1700000000.000200', '01700000000.0002000'])('leaves both requests uncertain for the same physical reply %s', (ts) => {
    const receipts = [sent(0), sent(1, ts)];
    for (const rows of [receipts, [...receipts].reverse()]) {
      const result = bind(rows);
      expect(result.answered).toEqual([]);
      for (const id of ids) expect(result.byRequestId.get(id)).toEqual({ verdict: 'uncertain' });
      const trace = traceSlackRequests({ entries: requests.map((request) => ({ ...request, decision: 'ingested', bus: 'posted' })), receipts: rows, now });
      expect(trace.counts).toMatchObject({ answered: 0, uncertain: 2 });
      expect(trace.rows.map((row) => row.outcome)).toEqual(['uncertain', 'uncertain']);
    }
  });

  it('accepts same-key replays and independent physical replies', () => {
    expect(bind([sent(0), sent(0, '01700000000.0002000')]).answered.map((row) => row.requestId)).toEqual([ids[0]]);
    expect(bind([sent(0), sent(1, '1700000000.000300')]).answered.map((row) => row.requestId)).toEqual(ids);
  });

  it('does not let an attempted other key poison sent evidence', () => {
    const result = bind([sent(0), { ...sent(1), state: 'attempted' }]);
    expect(result.byRequestId.get(ids[0]!)).toMatchObject({ verdict: 'answered' });
    expect(result.byRequestId.get(ids[1]!)).toEqual({ verdict: 'uncertain' });
  });

  it('continues to reject wrong threads and non-later replies', () => {
    for (const receipt of [{ ...sent(0), thread: '1700000000.000002' }, sent(0, requests[0]!.messageTs)]) {
      expect(bind([receipt]).byRequestId.get(ids[0]!)).toEqual({ verdict: 'uncertain' });
    }
  });
});
