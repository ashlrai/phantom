import { describe, expect, it } from 'vitest';
import { traceSlackRequests } from '../src/core/agents/slack-request-trace.js';
import type { SlackObservation } from '../src/core/agents/slack-journal.js';
import { fakeRequestId, replyKey } from './helpers/slack-causal.js';

const channel = 'C0FAKE9601';
const thread = '1700000000.000001';
const message = '1700000000.000100';
const replyTs = '1700000010.000000';
const requestId = fakeRequestId('cross-ingress');
const now = new Date('2023-11-14T22:14:00.000Z');
const failed: SlackObservation = { at: '2023-11-14T22:13:21.000Z', decision: 'ingested',
  bus: 'failed', channelId: channel, threadTs: thread, messageTs: message, requestId };
const posted: SlackObservation = { ...failed, at: '2023-11-14T22:13:25.000Z', bus: 'posted' };
const receipt = { key: replyKey(requestId), channel, thread, state: 'sent' as const, ts: replyTs };
const trace = (entries: SlackObservation[]) => traceSlackRequests({ entries, receipts: [receipt], now });

describe('cross-ingress request identity', () => {
  it.each([
    ['message', { messageTs: '1700000000.000200' }],
    ['channel', { channelId: 'C0FAKE9602' }],
    ['thread', { threadTs: '1700000000.000002' }],
  ])('rejects a conflicting %s in either input order', (_field, change) => {
    const entries = [failed, { ...posted, ...change }];
    for (const order of [entries, [...entries].reverse()]) {
      const result = trace(order);
      expect(result.rows.map((row) => row.outcome)).toEqual(['bus-failed', 'uncertain']);
      expect(result.rows.map((row) => row.replyTs)).toEqual([undefined, undefined]);
      expect(result.counts).toEqual({ total: 2, answered: 0, uncertain: 1, busFailed: 1, unanswered: 0 });
    }
  });

  it('retains evidence for a consistent retry', () => {
    const result = trace([failed, posted]);
    expect(result.rows.map((row) => row.outcome)).toEqual(['bus-failed', 'answered']);
    expect(result.rows.map((row) => row.replyTs)).toEqual([replyTs, replyTs]);
    expect(result.counts).toEqual({ total: 2, answered: 1, uncertain: 0, busFailed: 1, unanswered: 0 });
  });

  it('keeps distinct request IDs independent', () => {
    const result = trace([{ ...failed, requestId: fakeRequestId('other'), messageTs: '1700000000.000200' }, posted]);
    expect(result.rows.map((row) => row.outcome)).toEqual(['bus-failed', 'answered']);
    expect(result.rows.map((row) => row.replyTs)).toEqual([undefined, replyTs]);
    expect(result.counts).toEqual({ total: 2, answered: 1, uncertain: 0, busFailed: 1, unanswered: 0 });
  });
});
