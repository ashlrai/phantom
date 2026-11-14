import { describe, expect, it } from 'vitest';
import { bindSlackReplies, type InboundRequest, type SentReceipt } from '../src/core/agents/slack-reply-binding.js';

const now = new Date('2023-11-14T22:13:30.000Z');
const request: InboundRequest = {
  at: '2023-11-14T22:13:20.000Z', channelId: 'C0FAKE335',
  messageTs: '1700000000.000100', threadTs: '1700000000.000001',
};
const reply: SentReceipt = {
  channel: request.channelId, thread: request.threadTs, state: 'sent', ts: '1700000000.000200',
};
const bind = (requests = [request], receipts = [reply]) => bindSlackReplies({ requests, receipts, now });

describe('Slack reply binding (335)', () => {
  it('answers one request with a later same-thread send and projects evidence only', () => {
    expect(bind([{ ...request, text: 'omit payload' } as InboundRequest])).toEqual({
      answered: [{ channelId: request.channelId, threadTs: request.threadTs,
        messageTs: request.messageTs, replyTs: reply.ts }],
      unanswered: [], rejected: 0, futureDated: 0,
    });
  });

  it('leaves different-thread, top-level, different-channel, earlier and equal replies unanswered', () => {
    for (const receipt of [
      { ...reply, thread: '1700000000.000002' }, { ...reply, thread: undefined },
      { ...reply, channel: 'C0OTHER335' }, { ...reply, ts: '1700000000.000099' },
      { ...reply, ts: request.messageTs },
    ]) expect(bind([request], [receipt])).toEqual({ answered: [], unanswered: [request], rejected: 0, futureDated: 0 });
  });

  it('uses one reply only once, giving it to the oldest request', () => {
    const newer = { ...request, messageTs: '1700000000.000150' };
    const result = bind([newer, request]);
    expect(result.answered).toEqual(bind().answered);
    expect(result.unanswered).toEqual([newer]);
  });

  it('never answers with an attempted receipt, including one without a timestamp', () => {
    expect(bind([request], [{ ...reply, state: 'attempted' }, { ...reply, state: 'attempted', ts: undefined }]))
      .toEqual({ answered: [], unanswered: [request], rejected: 0, futureDated: 0 });
  });

  it('orders .10 before .9 by padding the fractional decimal, without floats', () => {
    const low = { ...request, messageTs: '1700000000.10' };
    const high = { ...request, messageTs: '1700000000.9' };
    expect(bind([high, low], []).unanswered).toEqual([low, high]);
    expect(bind([low], [{ ...reply, ts: high.messageTs }]).answered[0].replyTs).toBe(high.messageTs);
    expect(bind([high], [{ ...reply, ts: low.messageTs }]).unanswered).toEqual([high]);
    // Preserve precision beyond six fractional digits and leading zeroes.
    const precise = { ...request, messageTs: '01700000000.9000000001' };
    expect(bind([precise], [{ ...reply, ts: '1700000000.9000000002' }]).answered).toHaveLength(1);
    const largeLow = { ...request, messageTs: '99999999999999999998.1' };
    const largeHigh = { ...request, messageTs: '99999999999999999999.1' };
    expect(bind([largeHigh, largeLow], []).unanswered).toEqual([largeLow, largeHigh]);
    expect(bind([request], [{ ...reply, ts: '99999999999999999999.1' }]).futureDated).toBe(1);
  });

  it('counts malformed and future rows, tolerates malformed input, and enforces the 5s boundary', () => {
    const result = bind([
      null, { ...request, channelId: 'bad' }, { ...request, messageTs: 'bad' },
      { ...request, threadTs: 'bad' }, { ...request, at: 'bad' },
      { ...request, at: '2023-11-14T22:13:30.001Z' },
    ] as InboundRequest[], [
      null, { ...reply, channel: 'bad' }, { ...reply, ts: undefined },
      { ...reply, thread: 'bad' }, { ...reply, state: 'unknown' },
      { ...reply, state: 'attempted', channel: 'bad' }, { ...reply, state: 'attempted', ts: 'bad' },
      { ...reply, ts: '1700000015.000001' },
    ] as SentReceipt[]);
    expect(result).toEqual({ answered: [], unanswered: [], rejected: 12, futureDated: 2 });
    expect(bind([request], [{ ...reply, ts: '1700000015.000000' }]).answered).toHaveLength(1);
    expect(bind([{ ...request, at: now.toISOString() }]).answered).toHaveLength(1);
    expect(bindSlackReplies(null as unknown as Parameters<typeof bindSlackReplies>[0])).toEqual({
      answered: [], unanswered: [], rejected: 0, futureDated: 0,
    });
    expect(bindSlackReplies({ requests: [request], receipts: [reply], now: new Date(NaN) }).rejected).toBe(2);
    expect(bindSlackReplies({ requests: null, receipts: {}, now } as unknown as Parameters<typeof bindSlackReplies>[0]))
      .toEqual({ answered: [], unanswered: [], rejected: 0, futureDated: 0 });
  });

  it('is deterministic across shuffled inputs and never mutates them', () => {
    const requests = [
      request, { ...request, messageTs: '1700000000.000150' },
      { ...request, threadTs: '1700000000.000002' }, { ...request, channelId: 'C0AAA335' },
      { ...request, channelId: 'C0ZZZ335' },
    ];
    const receipts = [
      reply, { ...reply, ts: '1700000000.000300' },
      { ...reply, thread: '1700000000.000002' }, { ...reply, channel: 'C0AAA335' },
    ];
    const before = structuredClone({ requests, receipts });
    const expected = bind(requests, receipts);
    expect(expected.answered.map(row => row.replyTs)).toEqual([
      reply.ts, reply.ts, '1700000000.000300', reply.ts,
    ]);
    for (let i = 0; i < requests.length; i++) {
      const shuffled = [...requests.slice(i), ...requests.slice(0, i)].reverse();
      expect(bind(shuffled, [...receipts].reverse())).toEqual(expected);
    }
    expect({ requests, receipts }).toEqual(before);
  });
});
