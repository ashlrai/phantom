import { describe, expect, it } from 'vitest';
import { traceSlackRequests } from '../src/core/agents/slack-request-trace.js';
import type { SlackObservation } from '../src/core/agents/slack-journal.js';
import type { SentReceipt } from '../src/core/agents/slack-reply-binding.js';
import { fakeRequestId, replyKey } from './helpers/slack-causal.js';

const now = new Date('2023-11-14T22:14:00.000Z');
const requestId = fakeRequestId('926');
const base: SlackObservation = { at: '2023-11-14T22:13:20.000Z', decision: 'ingested', bus: 'posted',
  channelId: 'C0FAKE926', messageTs: '1700000000.000100', threadTs: '1700000000.000001', requestId };
const sent: SentReceipt = { key: replyKey(requestId), channel: 'C0FAKE926', thread: '1700000000.000001',
  state: 'sent', ts: '1700000001.000000' };

describe('ineligible Slack ingress evidence', () => {
  it('keeps invalid observations unverified even with exact-key receipts', () => {
    const entries: SlackObservation[] = [
      { ...base, at: '2023-11-14T22:15:00.000Z' },
      { ...base, at: 'invalid' },
      { ...base, channelId: 'bad' },
      { ...base, messageTs: 'bad' },
      { ...base, threadTs: 'bad' },
    ];
    for (const receipt of [sent, { ...sent, state: 'attempted' as const }]) {
      const result = traceSlackRequests({ entries, receipts: [receipt], now });
      expect(result.rows).toHaveLength(entries.length);
      for (const row of result.rows) {
        expect(row.outcome).toBe('uncertain');
        expect(row.evidence).toBe('unverified');
        expect(row).not.toHaveProperty('replyTs');
      }
      expect(result.counts).toEqual({ total: 5, answered: 0, uncertain: 5, busFailed: 0, unanswered: 0 });
    }
  });

  it('preserves valid and failed ingress, and legacy identity behavior', () => {
    const noSend = { ...base, messageTs: '1700000000.000200', requestId: fakeRequestId('no-send') };
    const legacy = { ...base, messageTs: '1700000000.000300' };
    delete legacy.requestId;
    const failed = { ...base, at: 'invalid', bus: 'failed' as const };
    const result = traceSlackRequests({ entries: [base, noSend, legacy, failed], receipts: [sent], now });
    expect(result.rows.find((row) => row.messageTs === base.messageTs && row.ingress === 'posted'))
      .toMatchObject({ outcome: 'answered', replyTs: sent.ts });
    expect(result.rows.find((row) => row.messageTs === noSend.messageTs)?.outcome).toBe('unanswered');
    expect(result.rows.find((row) => row.messageTs === legacy.messageTs))
      .toMatchObject({ outcome: 'uncertain', evidence: 'unverified' });
    const failedRow = result.rows.find((row) => row.ingress === 'failed');
    expect(failedRow).toMatchObject({ outcome: 'bus-failed', evidence: 'unverified' });
    expect(failedRow).not.toHaveProperty('replyTs');
    expect(result.counts).toEqual({ total: 4, answered: 1, uncertain: 1, busFailed: 1, unanswered: 1 });
  });
});
