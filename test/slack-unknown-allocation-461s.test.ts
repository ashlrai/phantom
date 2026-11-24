import { describe, expect, it } from 'vitest';
import { traceSlackRequests } from '../src/core/agents/slack-request-trace.js';
import type { SlackObservation } from '../src/core/agents/slack-journal.js';
import { fakeRequestId, replyKey } from './helpers/slack-causal.js';
import type { SentReceipt } from '../src/core/agents/slack-reply-binding.js';

const channel = 'C0FAKE4611';
const thread = '1700000000.000001';
const now = new Date('2023-11-14T22:14:00.000Z');
const replyTs = '1700000040.000000';
const rid = (n: number, channelId = channel) => fakeRequestId(`461s:${channelId}:${n}`);
const entry = (n: number, bus?: SlackObservation['bus'], channelId = channel): SlackObservation => ({
  at: `2023-11-14T22:13:${21 + n}.000Z`, decision: 'ingested',
  channelId, threadTs: thread, messageTs: `1700000000.00000${n}`,
  requestId: rid(n, channelId), ...(bus === undefined ? {} : { bus }),
});
/** The Leader reply to request `n`, found only through that request's causal key. */
const sentFor = (n: number, channelId = channel): SentReceipt => ({ key: replyKey(rid(n, channelId)), channel: channelId, thread, state: 'sent', ts: replyTs });
const sent = sentFor(2);
const trace = (entries: SlackObservation[], receipts: SentReceipt[] = [sent]) =>
  traceSlackRequests({ entries, receipts, now });
const permutations = <T>(rows: T[]): T[][] => rows.length === 0 ? [[]] :
  rows.flatMap((row, i) => permutations(rows.filter((_, j) => j !== i)).map(rest => [row, ...rest]));

describe('unknown ingress cannot consume durable Slack reply allocation', () => {
  it.each(['posted', 'duplicate'] as const)('keeps the sole reply for later %s ingress in either input order', (bus) => {
    const unknown = entry(1);
    const durable = entry(2, bus);
    for (const entries of permutations([unknown, durable])) {
      const result = trace(entries);
      expect(result.rows).toEqual([
        { at: unknown.at, channelId: channel, threadTs: thread, messageTs: unknown.messageTs,
          ingress: 'unknown', outcome: 'unanswered' },
        { at: durable.at, channelId: channel, threadTs: thread, messageTs: durable.messageTs,
          ingress: bus, outcome: 'answered', replyTs },
      ]);
      expect(result.counts).toEqual({ total: 2, answered: 1, uncertain: 0, busFailed: 0, unanswered: 1 });
    }
  });

  it('does not promote an unknown-only transport reply to durable successful receipt', () => {
    // Even with the request's own reply key, unknown ingress is never promoted: uncertain, no replyTs.
    const result = trace([entry(1)], [sentFor(1)]);
    expect(result.rows[0]).toMatchObject({ ingress: 'unknown', outcome: 'uncertain' });
    expect(result.rows[0]?.replyTs).toBeUndefined();
    expect(result.counts).toEqual({ total: 1, answered: 0, uncertain: 1, busFailed: 0, unanswered: 0 });
    expect(trace([entry(1)], [sent]).rows[0]).toMatchObject({ ingress: 'unknown', outcome: 'unanswered' });
    expect(trace([entry(1)], [{ ...sentFor(1), state: 'attempted' }]).rows[0])
      .toMatchObject({ ingress: 'unknown', outcome: 'uncertain' });
  });

  it('preserves failed evidence and one-to-one posted/duplicate allocation across all input permutations', () => {
    for (const entries of permutations([entry(1), entry(2, 'failed'), entry(3, 'posted'), entry(4, 'duplicate')])) {
      const result = trace(entries, [sentFor(3)]);
      expect(result.rows.map(row => [row.ingress, row.outcome, row.replyTs])).toEqual([
        ['unknown', 'unanswered', undefined], ['failed', 'bus-failed', undefined],
        ['posted', 'answered', replyTs], ['duplicate', 'unanswered', undefined],
      ]);
      expect(result.counts).toEqual({ total: 4, answered: 1, uncertain: 0, busFailed: 1, unanswered: 2 });
    }
  });

  it('keeps receipt allocation inside each sibling channel even when thread ids match', () => {
    const sibling = 'C0FAKE4612';
    for (const entries of permutations([entry(1), entry(2, 'posted'), entry(3, 'duplicate', sibling)])) {
      for (const receipts of permutations([sentFor(2), sentFor(3, sibling)])) {
        expect(trace(entries, receipts).rows.map(row => [row.channelId, row.outcome, row.replyTs])).toEqual([
          [channel, 'unanswered', undefined], [channel, 'answered', replyTs], [sibling, 'answered', replyTs],
        ]);
      }
      expect(trace(entries, [sentFor(2)]).rows[2]).toMatchObject({ channelId: sibling, outcome: 'unanswered' });
    }
  });
});
