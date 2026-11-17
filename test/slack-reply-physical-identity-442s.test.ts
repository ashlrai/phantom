import { describe, expect, it } from 'vitest';
import { bindSlackReplies, type InboundRequest, type SentReceipt } from '../src/core/agents/slack-reply-binding.js';
import { fakeRequestId, replyKey } from './helpers/slack-causal.js';

const now = new Date('2023-11-14T22:13:30.000Z');
const idA = fakeRequestId('442a'), idB = fakeRequestId('442b');
const first: InboundRequest = {
  at: '2023-11-14T22:13:20.000Z', channelId: 'C0FAKE442',
  messageTs: '1700000000.000100', threadTs: '1700000000.000001', requestId: idA,
};
const second: InboundRequest = { ...first, threadTs: '1700000000.000002', requestId: idB };
const reply: SentReceipt = {
  key: replyKey(idA), channel: first.channelId, thread: first.threadTs, state: 'sent', ts: '1700000000.000200',
};
const replyB: SentReceipt = { ...reply, key: replyKey(idB), thread: second.threadTs };
const bind = (receipts: SentReceipt[], requests = [first, second]) => bindSlackReplies({ requests, receipts, now });
const plain = (b: ReturnType<typeof bind>) => ({ ...b, byRequestId: [...b.byRequestId] });

describe('Slack physical reply identity (442S)', () => {
  it.each(['1700000000.000200', '01700000000.0002000'])('excludes conflicting threads for physical ts %s in either order', (ts) => {
    // The same physical message recorded under two threads proves no answer for either request.
    const receipts = [reply, { ...replyB, ts }];
    const before = structuredClone(receipts);
    const result = bind(receipts);
    expect(result.answered).toEqual([]);
    expect(result.uncertain).toEqual([first, second]);
    expect(plain(bind([...receipts].reverse(), [second, first]))).toEqual(plain(result));
    expect(receipts).toEqual(before);
  });

  it('excludes top-level versus threaded sent conflicts in either order', () => {
    const receipts = [reply, { ...reply, key: replyKey(fakeRequestId('top')), thread: undefined }];
    expect(bind(receipts).answered).toEqual([]);
    expect(plain(bind([...receipts].reverse()))).toEqual(plain(bind(receipts)));
  });

  it('collapses identical replays of one key into one answer without mutation', () => {
    const requests = [first, { ...first, messageTs: '1700000000.000150', requestId: fakeRequestId('442c') }];
    const receipts = [reply, { ...reply }, { ...reply, ts: '01700000000.0002000' }];
    const before = structuredClone({ requests, receipts });
    const result = bind(receipts, requests);
    expect(result.answered).toHaveLength(1);
    expect(result.unanswered).toEqual([requests[1]]);
    expect(plain(bind([...receipts].reverse(), [...requests].reverse()))).toEqual(plain(result));
    expect({ requests, receipts }).toEqual(before);
  });

  it('keeps equal timestamps in distinct channels independent', () => {
    const other = { ...second, channelId: 'C0OTHER442' };
    expect(bind([reply, { ...replyB, channel: other.channelId }], [first, other]).answered).toHaveLength(2);
  });

  it('allows two distinct real sent identities to answer two threads', () => {
    expect(bind([reply, { ...replyB, ts: '1700000000.000300' }]).answered).toHaveLength(2);
  });

  it('ignores attempts with conflicting associations, even when they carry a timestamp', () => {
    const attempts: SentReceipt[] = [
      { ...reply, key: replyKey(fakeRequestId('x1')), state: 'attempted', thread: second.threadTs },
      { ...reply, key: replyKey(fakeRequestId('x2')), state: 'attempted', thread: undefined },
    ];
    expect(bind([reply, ...attempts], [first])).toEqual(bind([reply], [first]));
    expect(bind([...attempts].reverse().concat(reply), [first])).toEqual(bind([reply], [first]));
  });
});
