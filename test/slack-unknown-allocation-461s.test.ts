import { describe, expect, it } from 'vitest';
import { traceSlackRequests } from '../src/core/agents/slack-request-trace.js';
import type { SlackObservation } from '../src/core/agents/slack-journal.js';
import type { SentReceipt } from '../src/core/agents/slack-reply-binding.js';

const channel = 'C0FAKE4611';
const thread = '1700000000.000001';
const now = new Date('2023-11-14T22:14:00.000Z');
const replyTs = '1700000040.000000';
const entry = (n: number, bus?: SlackObservation['bus'], channelId = channel): SlackObservation => ({
  at: `2023-11-14T22:13:${21 + n}.000Z`, decision: 'ingested',
  channelId, threadTs: thread, messageTs: `1700000000.00000${n}`,
  ...(bus === undefined ? {} : { bus }),
});
const sent: SentReceipt = { channel, thread, state: 'sent', ts: replyTs };
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
    const result = trace([entry(1)]);
    expect(result.rows[0]).toMatchObject({ ingress: 'unknown', outcome: 'unanswered' });
    expect(result.rows[0]?.replyTs).toBeUndefined();
    expect(result.counts).toEqual({ total: 1, answered: 0, uncertain: 0, busFailed: 0, unanswered: 1 });
    expect(trace([entry(1)], [{ ...sent, state: 'attempted' }]).rows[0])
      .toMatchObject({ ingress: 'unknown', outcome: 'uncertain' });
  });

  it('preserves failed evidence and one-to-one posted/duplicate allocation across all input permutations', () => {
    for (const entries of permutations([entry(1), entry(2, 'failed'), entry(3, 'posted'), entry(4, 'duplicate')])) {
      const result = trace(entries);
      expect(result.rows.map(row => [row.ingress, row.outcome, row.replyTs])).toEqual([
        ['unknown', 'unanswered', undefined], ['failed', 'bus-failed', replyTs],
        ['posted', 'answered', replyTs], ['duplicate', 'unanswered', undefined],
      ]);
      expect(result.counts).toEqual({ total: 4, answered: 1, uncertain: 0, busFailed: 1, unanswered: 2 });
    }
  });

  it('keeps receipt allocation inside each sibling channel even when thread ids match', () => {
    const sibling = 'C0FAKE4612';
    for (const entries of permutations([entry(1), entry(2, 'posted'), entry(3, 'duplicate', sibling)])) {
      for (const receipts of permutations([sent, { ...sent, channel: sibling }])) {
        expect(trace(entries, receipts).rows.map(row => [row.channelId, row.outcome, row.replyTs])).toEqual([
          [channel, 'unanswered', undefined], [channel, 'answered', replyTs], [sibling, 'answered', replyTs],
        ]);
      }
      expect(trace(entries).rows[2]).toMatchObject({ channelId: sibling, outcome: 'unanswered' });
    }
  });
});
