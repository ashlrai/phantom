import { describe, expect, it } from 'vitest';
import { traceSlackRequests } from '../src/core/agents/slack-request-trace.js';
import type { SlackObservation } from '../src/core/agents/slack-journal.js';
import type { SentReceipt } from '../src/core/agents/slack-reply-binding.js';
import { fakeRequestId, replyKey } from './helpers/slack-causal.js';

const now = new Date('2023-11-14T22:14:00.000Z');
const requestId = fakeRequestId('936s-request');
const base: SlackObservation = {
  at: '2023-11-14T22:13:21.000Z', decision: 'ingested', bus: 'posted',
  channelId: 'C0FAKE9361', threadTs: '1700000000.000001',
  messageTs: '1700000000.000100', requestId,
};
const receipt: SentReceipt = {
  key: replyKey(requestId), channel: base.channelId!, thread: base.threadTs!,
  state: 'sent', ts: '1700000010.000000',
};

describe('Slack trace cross-ingress identity conflicts', () => {
  for (const bus of ['posted', 'duplicate'] as const) {
    for (const change of [
      { channelId: 'C0FAKE9362' },
      { threadTs: '1700000000.000002' },
      { messageTs: '1700000000.000200' },
    ]) {
      it(`${bus} cannot be answered when a failed observation has conflicting ${Object.keys(change)[0]}`, () => {
        const success = { ...base, bus };
        const failed: SlackObservation = { ...base, ...change, bus: 'failed', at: '2023-11-14T22:13:22.000Z' };
        for (const entries of [[success, failed], [failed, success]]) {
          const result = traceSlackRequests({ entries, receipts: [receipt], now });
          expect(result.rows.map((row) => row.outcome)).toEqual(['uncertain', 'bus-failed']);
          expect(result.rows.every((row) => row.replyTs === undefined)).toBe(true);
          const filtered = traceSlackRequests({ entries, receipts: [receipt], now, thread: base.threadTs });
          expect(filtered.rows.find((row) => row.ingress === bus)?.outcome).toBe('uncertain');
        }
      });
    }
  }

  it('retains retries, duplicates, unknown ingress, and unrelated failure diagnostics', () => {
    const failed: SlackObservation = { ...base, bus: 'failed', at: '2023-11-14T22:13:20.000Z' };
    const duplicate: SlackObservation = { ...base, bus: 'duplicate', at: '2023-11-14T22:13:22.000Z' };
    const unknown: SlackObservation = { ...base, bus: undefined, at: '2023-11-14T22:13:23.000Z' };
    const other: SlackObservation = { ...base, bus: 'failed', requestId: fakeRequestId('936s-other'), messageTs: '1700000000.000300', at: '2023-11-14T22:13:24.000Z' };
    const entries = [failed, base, duplicate, unknown, other];
    for (const observations of [entries, [...entries].reverse()]) {
      const result = traceSlackRequests({ entries: observations, receipts: [receipt], now });
      expect(result.rows.map((row) => row.outcome)).toEqual(['bus-failed', 'answered', 'answered', 'uncertain', 'bus-failed']);
      expect(result.rows.map((row) => row.replyTs)).toEqual([receipt.ts, receipt.ts, receipt.ts, undefined, undefined]);
    }
  });
});
