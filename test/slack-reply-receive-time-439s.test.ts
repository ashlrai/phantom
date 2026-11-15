import { describe, expect, it } from 'vitest';
import { bindSlackReplies, type InboundRequest, type SentReceipt } from '../src/core/agents/slack-reply-binding.js';
import { traceSlackRequests } from '../src/core/agents/slack-request-trace.js';

const now = new Date('2023-11-14T22:14:00.000Z');
const request: InboundRequest = { at: '2023-11-14T22:13:20.123Z', channelId: 'C0FAKE439',
  threadTs: '1700000000.000001', messageTs: '1700000000.000100' };
const receipt = (ts: string): SentReceipt => ({ channel: request.channelId, thread: request.threadTs, state: 'sent', ts });
const bind = (requests: InboundRequest[], receipts: SentReceipt[]) => bindSlackReplies({ requests, receipts, now });

describe('Slack receive-time reply binding', () => {
  it('rejects a historical reply and compares milliseconds and microseconds exactly', () => {
    for (const ts of ['1700000000.100000', '1700000000.122999']) {
      expect(bind([request], [receipt(ts)]).unanswered).toEqual([request]);
    }
    for (const ts of ['1700000000.123000', '1700000000.123001']) {
      expect(bind([request], [receipt(ts)]).answered[0]?.replyTs).toBe(ts);
    }
  });

  it('accepts delayed delivery and ordinary replies, but not a different thread', () => {
    const delayed = { ...request, at: '2023-11-14T22:13:21.000Z' };
    expect(bind([delayed], [receipt('1700000002.000000')]).answered).toHaveLength(1);
    expect(bind([request], [receipt('1700000000.200000')]).answered).toHaveLength(1);
    expect(bind([request], [{ ...receipt('1700000000.200000'), thread: '1700000000.000002' }]).unanswered).toEqual([request]);
  });

  it('keeps earlier unused receipts available to later requests and deduplicates replays', () => {
    const late = { ...request, at: '2023-11-14T22:13:21.000Z' };
    const earlier = { ...request, messageTs: '1700000000.000200' };
    const receipts = [receipt('1700000001.000001'), receipt('1700000000.2000'), receipt('1700000000.200000')];
    const result = bind([earlier, late], receipts);
    expect(result.answered.map((row) => row.replyTs)).toEqual(['1700000001.000001', '1700000000.2000']);
    expect(bind([late, earlier], [...receipts].reverse())).toEqual(result);
    expect(bind([earlier, request], [receipts[1]!, receipts[2]!]).answered).toHaveLength(1);
  });

  it('does not report successful ingress as answered by an old reply', () => {
    const trace = traceSlackRequests({ entries: [{ ...request, decision: 'ingested', bus: 'posted' }],
      receipts: [receipt('1700000000.100000')], now });
    expect(trace.rows[0]?.outcome).toBe('unanswered');
    expect(trace.counts.answered).toBe(0);
  });
});
