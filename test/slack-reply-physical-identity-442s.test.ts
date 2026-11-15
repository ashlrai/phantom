import { describe, expect, it } from 'vitest';
import { bindSlackReplies, type InboundRequest, type SentReceipt } from '../src/core/agents/slack-reply-binding.js';

const now = new Date('2023-11-14T22:13:30.000Z');
const first: InboundRequest = {
  at: '2023-11-14T22:13:20.000Z', channelId: 'C0FAKE442',
  messageTs: '1700000000.000100', threadTs: '1700000000.000001',
};
const second = { ...first, threadTs: '1700000000.000002' };
const reply: SentReceipt = {
  channel: first.channelId, thread: first.threadTs, state: 'sent', ts: '1700000000.000200',
};
const bind = (receipts: SentReceipt[], requests = [first, second]) => bindSlackReplies({ requests, receipts, now });

describe('Slack physical reply identity (442S)', () => {
  it.each(['1700000000.000200', '01700000000.0002000'])('excludes conflicting threads for physical ts %s in either order', (ts) => {
    const receipts = [reply, { ...reply, thread: second.threadTs, ts }];
    const before = structuredClone(receipts);
    const expected = { answered: [], unanswered: [first, second], rejected: 0, futureDated: 0 };
    expect(bind(receipts)).toEqual(expected);
    expect(bind([...receipts].reverse(), [second, first])).toEqual(expected);
    expect(receipts).toEqual(before);
  });

  it('excludes top-level versus threaded sent conflicts in either order', () => {
    const receipts = [reply, { ...reply, thread: undefined }];
    expect(bind(receipts).answered).toEqual([]);
    expect(bind([...receipts].reverse())).toEqual(bind(receipts));
  });

  it('collapses identical and decimal-equivalent replays into one answer without mutation', () => {
    const requests = [first, { ...first, messageTs: '1700000000.000150' }];
    const receipts = [reply, { ...reply }, { ...reply, ts: '01700000000.0002000' }];
    const before = structuredClone({ requests, receipts });
    const result = bind(receipts, requests);
    expect(result.answered).toHaveLength(1);
    expect(result.unanswered).toEqual([requests[1]]);
    expect(bind([...receipts].reverse(), [...requests].reverse())).toEqual(result);
    expect({ requests, receipts }).toEqual(before);
  });

  it('keeps equal timestamps in distinct channels independent', () => {
    const other = { ...second, channelId: 'C0OTHER442' };
    expect(bind([reply, { ...reply, channel: other.channelId, thread: other.threadTs }], [first, other]).answered)
      .toHaveLength(2);
  });

  it('allows two distinct real sent identities to answer two threads', () => {
    expect(bind([reply, { ...reply, thread: second.threadTs, ts: '1700000000.000300' }]).answered).toHaveLength(2);
  });

  it('ignores attempts with conflicting associations, even when they carry a timestamp', () => {
    const attempts: SentReceipt[] = [
      { ...reply, state: 'attempted', thread: second.threadTs },
      { ...reply, state: 'attempted', thread: undefined },
    ];
    expect(bind(attempts).answered).toEqual([]);
    expect(bind([reply, ...attempts])).toEqual(bind([reply]));
    expect(bind([...attempts].reverse().concat(reply))).toEqual(bind([reply]));
  });
});
