import { describe, expect, it } from 'vitest';
import { bindSlackReplies, type InboundRequest, type SentReceipt } from '../src/core/agents/slack-reply-binding.js';
import { fakeRequestId, replyKey } from './helpers/slack-causal.js';

const now = new Date('2023-11-14T22:13:30.000Z');
const requestId = fakeRequestId('962s');
const request: InboundRequest = { at: '2023-11-14T22:13:20.000Z', channelId: 'C0FAKE962',
  threadTs: '1700000000.000001', messageTs: '1700000000.000100', requestId };
const reply: SentReceipt = { key: replyKey(requestId), channel: request.channelId, state: 'sent',
  thread: '01700000000.0000010', ts: '1700000000.000200' };
const bind = (requests: InboundRequest[], receipts: SentReceipt[]) => bindSlackReplies({ requests, receipts, now });
const plain = (result: ReturnType<typeof bind>) => ({ ...result, byRequestId: [...result.byRequestId] });

describe('Slack reply decimal locations (962S)', () => {
  it('answers with an equivalent thread while preserving original request evidence', () => {
    expect(bind([request], [reply]).answered).toEqual([{ ...request, replyTs: reply.ts }]);
  });

  it('collapses equivalent physical receipt threads deterministically', () => {
    const receipts = [reply, { ...reply, thread: request.threadTs, ts: '01700000000.0002000' }];
    const expected = plain(bind([request], receipts));
    expect(expected.answered).toHaveLength(1);
    expect(plain(bind([request], [...receipts].reverse()))).toEqual(expected);
  });

  it('settles duplicate request locations with equivalent thread and message decimals once', () => {
    const alias = { ...request, threadTs: reply.thread!, messageTs: '01700000000.0001000' };
    const expected = plain(bind([request, alias], [reply]));
    expect(expected.answered).toHaveLength(1);
    expect(expected.byRequestId).toHaveLength(1);
    expect(plain(bind([alias, request], [reply]))).toEqual(expected);
  });

  it('keeps genuinely different precise thread or message locations uncertain', () => {
    for (const other of [
      { ...request, threadTs: '1700000000.0000010001' },
      { ...request, messageTs: '1700000000.0001000001' },
    ]) {
      const result = bind([request, other], [reply]);
      expect(result.answered).toEqual([]);
      expect(result.uncertain).toHaveLength(2);
    }
    expect(bind([request], [reply, { ...reply, thread: '1700000000.0000010001' }]).uncertain).toHaveLength(1);
  });

  it('fails closed for absent threads, conflicting channels and keys, and invalid timestamps without mutation', () => {
    const cases: SentReceipt[][] = [
      [{ ...reply, thread: undefined }], [reply, { ...reply, thread: undefined }],
      [{ ...reply, channel: 'C0OTHER962' }],
      [reply, { ...reply, key: replyKey(fakeRequestId('other-962s')) }],
      [{ ...reply, thread: '1700000000.000001x' }],
    ];
    for (const receipts of cases) {
      const requests = [request];
      const before = structuredClone({ requests, receipts });
      expect(bind(requests, receipts).answered).toEqual([]);
      expect({ requests, receipts }).toEqual(before);
    }
    expect(bind([{ ...request, messageTs: '1700000000.1e0' }], [reply]).rejected).toBe(1);
  });
});
