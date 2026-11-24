import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recordSlackObservation, type SlackObservation } from '../src/core/agents/slack-journal.js';
import { readSlackRequestTrace, traceSlackRequests } from '../src/core/agents/slack-request-trace.js';
import type { SentReceipt } from '../src/core/agents/slack-reply-binding.js';
import { fakeRequestId, replyKey } from './helpers/slack-causal.js';

const now = new Date('2025-11-07T18:00:00.000Z');
const channel = 'C0FAKE0001';
const thread = '1731000000.000100';
const replyTs = '1731000050.000100';
const entry: SlackObservation = {
  at: '2024-11-07T17:00:00.000Z', decision: 'ingested', bus: 'failed',
  channelId: channel, threadTs: thread, messageTs: '1731000010.000100', requestId: fakeRequestId('438s'),
};
const sent: SentReceipt = { key: replyKey(entry.requestId!), channel, thread, state: 'sent', ts: replyTs };
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function readFixture(observation: SlackObservation, receipts: SentReceipt[]) {
  const root = mkdtempSync(join(tmpdir(), 'slack-ingress-438-')); roots.push(root);
  const runsDir = join(root, 'runs');
  const stateRoot = join(root, 'state');
  expect(recordSlackObservation(observation, { runsDir })).toBe('recorded');
  mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
  const messages = Object.fromEntries(receipts.map((receipt, index) => [receipt.key ?? String(index).padStart(64, '0'), receipt]));
  writeFileSync(join(stateRoot, 'messages.json'), JSON.stringify({ version: 1, messages }), { mode: 0o600 });
  return readSlackRequestTrace({ runsDir, stateRoot, now: () => now });
}

describe('Slack ingress proof', () => {
  it('retains a bound reply as evidence without treating failed ingress as answered', () => {
    const trace = readFixture(entry, [sent]);
    expect(trace.sources).toEqual({ journal: 'ok', sends: 'ok' });
    expect(trace.rows[0]).toMatchObject({ ingress: 'failed', outcome: 'bus-failed', replyTs });
    expect(trace.counts).toEqual({ total: 1, answered: 0, uncertain: 0, busFailed: 1, unanswered: 0 });
    expect(trace.rows.length > 0 && trace.rows.every((row) => row.outcome === 'answered')).toBe(false);
  });

  it('answers a posted ingress with a bound reply', () => {
    const trace = readFixture({ ...entry, bus: 'posted' }, [sent]);
    expect(trace.rows[0]).toMatchObject({ ingress: 'posted', outcome: 'answered', replyTs });
    expect(trace.counts).toEqual({ total: 1, answered: 1, uncertain: 0, busFailed: 0, unanswered: 0 });
  });

  it('reports failure without a reply and does not bind unrelated threads', () => {
    const failed = readFixture(entry, []);
    expect(failed.rows[0]).toMatchObject({ ingress: 'failed', outcome: 'bus-failed' });
    expect(failed.rows[0]?.replyTs).toBeUndefined();
    const unrelated = readFixture({ ...entry, bus: 'posted' }, [{ ...sent, key: replyKey(fakeRequestId('unrelated')), thread: '1731000001.000100' }]);
    expect(unrelated.rows[0]?.outcome).toBe('unanswered');
    expect(unrelated.counts.answered).toBe(0);
  });

  it('preserves unknown ingress in the pure join', () => {
    const { bus: _bus, ...unknown } = entry;
    const trace = traceSlackRequests({ entries: [unknown], receipts: [sent], now });
    // A keyed send exists but ingress was never durably recorded: UNCERTAIN, with no replyTs.
    expect(trace.rows[0]).toMatchObject({ ingress: 'unknown', outcome: 'uncertain' });
    expect(trace.rows[0]?.replyTs).toBeUndefined();
    expect(traceSlackRequests({ entries: [unknown], receipts: [], now }).rows[0]).toMatchObject({ ingress: 'unknown', outcome: 'unanswered' });
  });
});
