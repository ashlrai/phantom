import { describe, expect, it } from 'vitest';
import { traceSlackRequests } from '../src/core/agents/slack-request-trace.js';
import type { SlackObservation } from '../src/core/agents/slack-journal.js';
import type { SentReceipt } from '../src/core/agents/slack-reply-binding.js';

const channel = 'C0FAKE4401';
const thread = '1700000000.000001';
const now = new Date('2023-11-14T22:14:00.000Z');
const replyTs = '1700000010.000000';
const atFailed = '2023-11-14T22:13:21.000Z';
const atPosted = '2023-11-14T22:13:25.000Z';
const atLater = '2023-11-14T22:13:30.000Z';

const entry = (at: string, messageTs: string, bus: SlackObservation['bus'] = 'posted'): SlackObservation =>
  ({ at, decision: 'ingested', bus, channelId: channel, threadTs: thread, messageTs });
const sent = (ts = replyTs, extra: Partial<SentReceipt> = {}): SentReceipt =>
  ({ channel, thread, state: 'sent', ts, ...extra });
const trace = (entries: SlackObservation[], receipts: SentReceipt[]) =>
  traceSlackRequests({ entries, receipts, now });

describe('Slack trace failed-ingress reply allocation', () => {
  it('a failed row never steals the only confirmed reply from a later posted row', () => {
    const failed = entry(atFailed, '1700000000.000100', 'failed');
    const posted = entry(atPosted, '1700000000.000200', 'posted');
    for (const entries of [[failed, posted], [posted, failed]]) {
      const result = trace(entries, [sent()]);
      expect(result.rows.map((row) => [row.ingress, row.outcome])).toEqual([
        ['failed', 'bus-failed'], ['posted', 'answered'],
      ]);
      expect(result.rows.find((row) => row.ingress === 'failed')?.replyTs).toBe(replyTs);
      expect(result.rows.find((row) => row.ingress === 'posted')?.replyTs).toBe(replyTs);
      expect(result.counts).toEqual({ total: 2, answered: 1, uncertain: 0, busFailed: 1, unanswered: 0 });
    }
  });

  it('a failed then retried successful row sharing one identity still answers the retry', () => {
    const messageTs = '1700000000.000100';
    const result = trace([
      entry(atFailed, messageTs, 'failed'), entry(atPosted, messageTs, 'posted'),
    ], [sent()]);
    expect(result.rows.map((row) => row.outcome)).toEqual(['bus-failed', 'answered']);
    expect(result.counts).toEqual({ total: 2, answered: 1, uncertain: 0, busFailed: 1, unanswered: 0 });
  });

  it('a failed row in another thread cannot consume this thread reply', () => {
    const otherThread = '1700001000.000001';
    const result = trace([
      { ...entry(atFailed, '1700000000.000100', 'failed'), threadTs: otherThread },
      entry(atPosted, '1700000000.000200', 'posted'),
    ], [sent()]);
    expect(result.rows.map((row) => row.outcome)).toEqual(['bus-failed', 'answered']);
    expect(result.counts.answered).toBe(1);
  });

  it('one reply answers at most one of several competing successful requests', () => {
    const result = trace([
      entry(atFailed, '1700000000.000050', 'failed'),
      entry(atPosted, '1700000000.000100', 'posted'),
      entry(atLater, '1700000000.000200', 'posted'),
    ], [sent()]);
    expect(result.rows.map((row) => row.outcome)).toEqual(['bus-failed', 'answered', 'unanswered']);
    expect(result.counts).toEqual({ total: 3, answered: 1, uncertain: 0, busFailed: 1, unanswered: 1 });
  });

  it('attempted and future-dated evidence stays nonproof for every ingress', () => {
    const attemptTs = '1700000007.000000';
    const entries = [entry(atFailed, '1700000000.000100', 'failed'), entry(atPosted, '1700000000.000200')];
    const attempted = trace(entries, [{ channel, thread, state: 'attempted', ts: attemptTs }]);
    expect(attempted.rows.map((row) => row.outcome)).toEqual(['bus-failed', 'uncertain']);
    expect(attempted.counts.answered).toBe(0);
    const future = trace(entries, [sent(`${now.getTime() / 1000 + 60}.000000`)]);
    expect(future.rows.map((row) => row.outcome)).toEqual(['bus-failed', 'unanswered']);
    expect(future.counts.answered).toBe(0);
  });
});
