import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recordSlackObservation, type SlackObservation } from '../src/core/agents/slack-journal.js';
import { traceSlackRequests, readSlackRequestTrace } from '../src/core/agents/slack-request-trace.js';
import type { SentReceipt } from '../src/core/agents/slack-reply-binding.js';

const channel = 'C0FAKE0001';
const thread = '1731000000.000100';
const now = new Date('2025-11-07T18:00:00.000Z');
const at = '2025-11-07T17:00:00.000Z';
const later = '2025-11-07T17:02:00.000Z';
const attemptTs = `${Date.parse('2025-11-07T17:01:00.000Z') / 1000}.000001`;
const entry = (time = at, messageTs = '1731000010.000100'): SlackObservation =>
  ({ at: time, channelId: channel, threadTs: thread, messageTs, decision: 'ingested', bus: 'posted' });
const attempt: SentReceipt = { channel, thread, state: 'attempted', ts: attemptTs };
const trace = (entries: SlackObservation[], receipts: SentReceipt[]) => traceSlackRequests({ entries, receipts, now });
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe('Slack attempt temporal evidence', () => {
  it('marks only requests received by the attempt, without assigning it one-to-one', () => {
    const result = trace([entry(later, '1731000020.000100'), entry(), entry(at, '1731000030.000100')], [attempt]);
    expect(result.rows.map((row) => row.outcome)).toEqual(['uncertain', 'uncertain', 'unanswered']);
    expect(result.counts).toEqual({ total: 3, answered: 0, uncertain: 2, busFailed: 0, unanswered: 1 });
  });

  it('rejects missing, malformed, future, older and mismatched evidence', () => {
    const invalid: SentReceipt[] = [
      { ...attempt, channel: 'C0FAKE0002' }, { ...attempt, thread: '1731000001.000100' },
      { ...attempt, ts: undefined }, { ...attempt, ts: 'bad' }, { ...attempt, channel: 'bad' },
      { ...attempt, ts: `${now.getTime() / 1000}.000001` },
      { ...attempt, ts: `${Date.parse(at) / 1000 - 1}.999999` },
    ];
    expect(trace([entry()], invalid).rows[0]?.outcome).toBe('unanswered');
    expect(trace([entry('invalid'), entry('2025-11-07T19:00:00.000Z')], [attempt]).rows.map(r => r.outcome))
      .toEqual(['unanswered', 'unanswered']);
  });

  it('preserves bus failure and sent-receipt precedence', () => {
    expect(trace([{ ...entry(), bus: 'failed' }], [attempt]).rows[0]?.outcome).toBe('bus-failed');
    const sent: SentReceipt = { ...attempt, state: 'sent', ts: '1731000050.000100' };
    expect(trace([entry()], [attempt, sent]).rows[0]?.outcome).toBe('answered');
  });

  it('reads isolated producer-shaped stores and does not infer time from expiresAt', () => {
    const root = mkdtempSync(join(tmpdir(), 'slack-trace-433-')); roots.push(root);
    const runsDir = join(root, 'runs'); const stateRoot = join(root, 'state');
    recordSlackObservation(entry(), { runsDir });
    recordSlackObservation(entry(later, '1731000020.000100'), { runsDir });
    mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
    const store = (receipt: SentReceipt) => writeFileSync(join(stateRoot, 'messages.json'), JSON.stringify({ version: 1, messages: {
      ['a'.repeat(64)]: { digest: 'a'.repeat(64), clientId: '11111111-1111-1111-1111-111111111111', expiresAt: 9e12, ...receipt },
    } }), { mode: 0o600 });
    store(attempt);
    const result = readSlackRequestTrace({ runsDir, stateRoot, now: () => now });
    expect(result.sources).toEqual({ journal: 'ok', sends: 'ok' });
    expect(result.rows.map(r => r.outcome)).toEqual(['uncertain', 'unanswered']);
    store({ ...attempt, ts: undefined });
    expect(readSlackRequestTrace({ runsDir, stateRoot, now: () => now }).rows.map(r => r.outcome))
      .toEqual(['unanswered', 'unanswered']);
  });
});
