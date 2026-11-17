import { describe, expect, it } from 'vitest';
import { bindSlackReplies, type InboundRequest, type SentReceipt } from '../src/core/agents/slack-reply-binding.js';
import { traceSlackRequests } from '../src/core/agents/slack-request-trace.js';
import { fakeRequestId, replyKey } from './helpers/slack-causal.js';

/**
 * 439S guards: a historical reply must never answer a later request, and
 * delayed or replayed delivery must still be answered. 6338 removed the
 * request.at lower bound because request.at (host clock) and receipt ts (Slack
 * clock) are not comparable. Causal binding satisfies both with no clock
 * comparison between hosts: the reply is bound by its exact key.
 */
const now = new Date('2023-11-14T22:14:00.000Z');
const requestId = fakeRequestId('439');
const request: InboundRequest = { at: '2023-11-14T22:13:20.123Z', channelId: 'C0FAKE439',
  threadTs: '1700000000.000001', messageTs: '1700000000.000100', requestId };
const sentFor = (id: string, ts: string): SentReceipt =>
  ({ key: replyKey(id), channel: request.channelId, thread: request.threadTs, state: 'sent', ts });
const bind = (requests: InboundRequest[], receipts: SentReceipt[]) => bindSlackReplies({ requests, receipts, now });

describe('Slack historical versus delayed replies (439S)', () => {
  it('rejects a historical reply from another request, at any precision around the receive time', () => {
    const old = fakeRequestId('historical');
    for (const ts of ['1700000000.100000', '1700000000.122999', '1700000000.123000', '1700000000.123001']) {
      const result = bind([request], [sentFor(old, ts)]);
      expect(result.answered).toEqual([]);
      expect(result.unanswered).toEqual([request]);
    }
  });

  it('answers delayed delivery and ordinary replies by key, ignoring the host receive time', () => {
    const delayed = { ...request, at: '2023-11-14T22:13:21.000Z' };
    expect(bind([delayed], [sentFor(requestId, '1700000002.000000')]).answered).toHaveLength(1);
    expect(bind([request], [sentFor(requestId, '1700000000.200000')]).answered).toHaveLength(1);
    expect(bind([request], [{ ...sentFor(requestId, '1700000000.200000'), thread: '1700000000.000002' }]).answered).toEqual([]);
  });

  it('keeps an old unused reply from being claimed by a later request, in either order', () => {
    const earlier = { ...request, messageTs: '1700000000.000050', requestId: fakeRequestId('earlier') };
    const receipts = [sentFor(earlier.requestId, '1700000000.000060')];
    const result = bind([earlier, request], receipts);
    expect(result.answered.map((a) => a.requestId)).toEqual([earlier.requestId]);
    expect(result.unanswered).toEqual([request]);
    expect(bind([request, earlier], [...receipts].reverse())).toEqual(result);
  });

  it('does not report successful ingress as answered by an old reply', () => {
    const trace = traceSlackRequests({ entries: [{ ...request, decision: 'ingested', bus: 'posted' }],
      receipts: [sentFor(fakeRequestId('historical'), '1700000000.100000')], now });
    expect(trace.rows[0]?.outcome).toBe('unanswered');
    expect(trace.counts.answered).toBe(0);
  });

  it('answers the exact-key reply in the trace and never exposes the request id', () => {
    const trace = traceSlackRequests({ entries: [{ ...request, decision: 'ingested', bus: 'posted' }],
      receipts: [sentFor(requestId, '1700000000.200000')], now });
    expect(trace.rows[0]).toEqual({ at: request.at, channelId: request.channelId, threadTs: request.threadTs,
      messageTs: request.messageTs, ingress: 'posted', outcome: 'answered', replyTs: '1700000000.200000' });
  });
});
