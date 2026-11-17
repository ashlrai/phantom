import { describe, expect, it } from 'vitest';
import { bindSlackReplies, type InboundRequest, type SentReceipt } from '../src/core/agents/slack-reply-binding.js';
import { fakeRequestId, replyKey } from './helpers/slack-causal.js';

const now = new Date('2023-11-14T22:13:30.000Z');
const requestId = fakeRequestId('335');
const request: InboundRequest = {
  at: '2023-11-14T22:13:20.000Z', channelId: 'C0FAKE335',
  messageTs: '1700000000.000100', threadTs: '1700000000.000001', requestId,
};
const reply: SentReceipt = {
  key: replyKey(requestId), channel: request.channelId, thread: request.threadTs, state: 'sent', ts: '1700000000.000200',
};
const bind = (requests: InboundRequest[] = [request], receipts: SentReceipt[] = [reply]) =>
  bindSlackReplies({ requests, receipts, now });
const shape = (b: ReturnType<typeof bind>) => ({ ...b, byRequestId: Object.fromEntries(b.byRequestId) });

describe('Slack causal reply binding (335)', () => {
  it('answers a request by the exact reply key and projects evidence only', () => {
    expect(shape(bind([{ ...request, text: 'omit payload' } as InboundRequest]))).toEqual({
      answered: [{ channelId: request.channelId, threadTs: request.threadTs, messageTs: request.messageTs,
        replyTs: reply.ts, requestId, at: request.at }],
      unanswered: [], uncertain: [], unverified: [], byRequestId: { [requestId]: { verdict: 'answered', replyTs: reply.ts } },
      rejected: 0, futureDated: 0,
    });
  });

  it('answers a delayed or replayed ingest whatever the host clock says', () => {
    // request.at is the host clock at ingest; the key ignores it entirely.
    for (const at of ['2023-11-14T22:13:00.000Z', '2023-11-14T22:13:29.000Z'])
      expect(bind([{ ...request, at }]).answered).toHaveLength(1);
  });

  it('never answers from a different key, location, or an inconsistent ts', () => {
    for (const receipt of [
      { ...reply, key: replyKey(fakeRequestId('other')) },
      { ...reply, thread: '1700000000.000002' }, { ...reply, thread: undefined },
      { ...reply, channel: 'C0OTHER335' },
    ]) {
      const result = bind([request], [receipt]);
      expect(result.answered).toEqual([]);
      expect(result.unverified).toEqual([]);
    }
    // Key present but ts not after the message: uncertain, not answered, not unanswered.
    for (const ts of ['1700000000.000099', request.messageTs])
      expect(bind([request], [{ ...reply, ts }]).uncertain).toEqual([request]);
    // A different key simply leaves this request unanswered.
    expect(bind([request], [{ ...reply, key: replyKey(fakeRequestId('other')) }]).unanswered).toEqual([request]);
  });

  it('marks an exact-key attempted receipt uncertain, with or without a ts', () => {
    for (const attempt of [{ ...reply, state: 'attempted' as const }, { ...reply, state: 'attempted' as const, ts: undefined }])
      expect(bind([request], [attempt]).uncertain).toEqual([request]);
    expect(bind([request], [{ ...reply, state: 'attempted', key: replyKey(fakeRequestId('x')) }]).unanswered).toEqual([request]);
  });

  it('leaves requests without a reply identity unverified, never answered or unanswered', () => {
    const legacy = { ...request, requestId: undefined };
    delete legacy.requestId;
    // Even a later same-thread sent receipt cannot answer an id-less request.
    const result = bind([legacy], [reply]);
    expect(result.unverified).toEqual([legacy]);
    expect(result.answered).toEqual([]);
    expect(result.unanswered).toEqual([]);
  });

  it('keeps an old reply from answering a later request in the same thread', () => {
    const later = { ...request, messageTs: '1700000000.000900', requestId: fakeRequestId('later'), at: '2023-11-14T22:13:25.000Z' };
    const result = bind([request, later]);
    expect(result.answered.map((a) => a.requestId)).toEqual([requestId]);
    expect(result.unanswered).toEqual([later]);
  });

  it('shares one verdict between duplicate journal rows of the same request id', () => {
    const duplicate = { ...request, at: '2023-11-14T22:13:21.000Z' };
    const result = bind([duplicate, request]);
    expect(result.answered).toHaveLength(1);
    expect(result.byRequestId.get(requestId)).toEqual({ verdict: 'answered', replyTs: reply.ts });
  });

  it('orders .10 before .9 by padding the fractional decimal, without floats', () => {
    const low = { ...request, messageTs: '1700000000.10' };
    const high = { ...request, messageTs: '1700000000.9' };
    expect(bind([high], [{ ...reply, ts: low.messageTs }]).uncertain).toEqual([high]);
    expect(bind([low], [{ ...reply, ts: high.messageTs }]).answered[0]?.replyTs).toBe(high.messageTs);
    const precise = { ...request, messageTs: '01700000000.9000000001' };
    expect(bind([precise], [{ ...reply, ts: '1700000000.9000000002' }]).answered).toHaveLength(1);
    expect(bind([request], [{ ...reply, ts: '99999999999999999999.1' }]).futureDated).toBe(1);
  });

  it('counts malformed and future rows, tolerates malformed input, and enforces the 5s boundary', () => {
    const result = bind([
      null, { ...request, channelId: 'bad' }, { ...request, messageTs: 'bad' },
      { ...request, threadTs: 'bad' }, { ...request, at: 'bad' }, { ...request, requestId: 'not-hex' },
      { ...request, at: '2023-11-14T22:13:30.001Z' },
    ] as InboundRequest[], [
      null, { ...reply, channel: 'bad' }, { ...reply, ts: undefined },
      { ...reply, thread: 'bad' }, { ...reply, state: 'unknown' }, { ...reply, key: 'bad' },
      { ...reply, state: 'attempted', channel: 'bad' }, { ...reply, state: 'attempted', ts: 'bad' },
      { ...reply, ts: '1700000015.000001' },
    ] as SentReceipt[]);
    expect(result).toMatchObject({ answered: [], unanswered: [], uncertain: [], unverified: [], rejected: 14, futureDated: 2 });
    expect(bind([request], [{ ...reply, ts: '1700000015.000000' }]).answered).toHaveLength(1);
    expect(bind([{ ...request, at: now.toISOString() }]).answered).toHaveLength(1);
    expect(bindSlackReplies(null as unknown as Parameters<typeof bindSlackReplies>[0]))
      .toMatchObject({ answered: [], unanswered: [], uncertain: [], unverified: [], rejected: 0, futureDated: 0 });
    expect(bindSlackReplies({ requests: [request], receipts: [reply], now: new Date(NaN) }).rejected).toBe(2);
    expect(bindSlackReplies({ requests: null, receipts: {}, now } as unknown as Parameters<typeof bindSlackReplies>[0]))
      .toMatchObject({ answered: [], rejected: 0 });
  });

  it('is deterministic across shuffled inputs and never mutates them', () => {
    const ids = [1, 2, 3].map((n) => fakeRequestId(`shuffle-${n}`));
    const requests = [
      request, { ...request, messageTs: '1700000000.000150', requestId: ids[0] },
      { ...request, threadTs: '1700000000.000002', requestId: ids[1] },
      { ...request, channelId: 'C0AAA335', requestId: ids[2] },
    ];
    const receipts = [reply, { ...reply, key: replyKey(ids[0]!), ts: '1700000000.000300' },
      { ...reply, key: replyKey(ids[1]!), thread: '1700000000.000002', ts: '1700000000.000400' }];
    const before = structuredClone({ requests, receipts });
    const expected = shape(bind(requests, receipts));
    expect(expected.answered).toHaveLength(3);
    expect(expected.unanswered.map((r) => r.requestId)).toEqual([ids[2]]);
    for (let i = 0; i < requests.length; i++) {
      const shuffled = [...requests.slice(i), ...requests.slice(0, i)].reverse();
      expect(shape(bind(shuffled, [...receipts].reverse()))).toEqual(expected);
    }
    expect({ requests, receipts }).toEqual(before);
  });

  it('fails closed when rows sharing one requestId disagree about the message (no first-row-wins)', () => {
    const id = request.requestId!;
    for (const other of [
      { ...request, channelId: 'C0OTHER335' },
      { ...request, messageTs: '1700000000.000150' },
      { ...request, threadTs: '1700000000.000002' },
    ]) {
      // Even with a valid exact-key sent receipt for that id, neither row may be answered.
      const result = bind([request, other], [reply]);
      expect(result.answered).toEqual([]);
      expect(result.unanswered).toEqual([]);
      expect(result.uncertain).toHaveLength(2);
      expect(result.byRequestId.get(id)).toEqual({ verdict: 'uncertain' });
    }
    // Identical duplicate rows (a redelivery) are still one request with one shared verdict.
    expect(bind([request, { ...request, at: '2023-11-14T22:13:21.000Z' }], [reply]).answered).toHaveLength(1);
  });
});
