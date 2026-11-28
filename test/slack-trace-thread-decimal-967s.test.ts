import { afterEach, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recordSlackObservation, type SlackObservation } from '../src/core/agents/slack-journal.js';
import { readSlackRequestTrace, traceSlackRequests } from '../src/core/agents/slack-request-trace.js';
import type { SentReceipt } from '../src/core/agents/slack-reply-binding.js';
import { fakeRequestId, replyKey } from './helpers/slack-causal.js';

const now = new Date('2025-11-07T18:00:00.000Z');
const thread = '1700000000.1';
const requestId = fakeRequestId('967s-request');
const entry: SlackObservation = { at: '2025-11-07T17:00:00.000Z', channelId: 'C0FAKE0001',
  threadTs: thread, messageTs: '1700000001.1', decision: 'ingested', bus: 'posted', requestId };
const other: SlackObservation = { ...entry, threadTs: '1700000000.1000000001',
  messageTs: '1700000002.1', requestId: fakeRequestId('967s-other') };
const receipt: SentReceipt = { key: replyKey(requestId), channel: 'C0FAKE0001', thread,
  state: 'sent', ts: '1700000003.1' };
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

it('selects decimal-equivalent threads without changing evidence or aliasing precision', () => {
  const trace = (selector?: string) => traceSlackRequests({ entries: [entry, other], receipts: [receipt], now,
    ...(selector === undefined ? {} : { thread: selector }) });
  const literal = trace(thread);
  expect(trace('1700000000.100000')).toEqual(literal);
  expect(literal.counts).toEqual({ total: 1, answered: 1, uncertain: 0, busFailed: 0, unanswered: 0 });
  expect(literal.rows[0]).toMatchObject({ threadTs: thread, messageTs: entry.messageTs, outcome: 'answered', replyTs: receipt.ts });
  expect(trace('1700000000.1000000002').rows).toEqual([]);
  expect(trace('1700000000.1000000001').rows[0]?.threadTs).toBe(other.threadTs);
  for (const invalid of ['1700000000.1x', '1700000000.', ' 1700000000.1', '']) {
    expect(trace(invalid).rows).toEqual([]);
  }
  expect(trace().rows.map(row => row.threadTs)).toEqual([thread, other.threadTs]);
});

it('applies the same selector to persisted journal and receipt evidence', () => {
  const root = mkdtempSync(join(tmpdir(), 'slack-trace-967-')); roots.push(root);
  const runsDir = join(root, 'runs'); const stateRoot = join(root, 'state');
  recordSlackObservation(entry, { runsDir });
  recordSlackObservation(other, { runsDir });
  mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
  writeFileSync(join(stateRoot, 'messages.json'), JSON.stringify({ version: 1, messages: {
    [receipt.key!]: { digest: 'a'.repeat(64), clientId: '11111111-1111-1111-1111-111111111111',
      expiresAt: 9e12, ...receipt, key: undefined },
  } }), { mode: 0o600 });
  const read = (selector?: string) => readSlackRequestTrace({ runsDir, stateRoot, now: () => now,
    ...(selector === undefined ? {} : { thread: selector }) });
  const literal = read(thread);
  expect(literal.sources).toEqual({ journal: 'ok', sends: 'ok' });
  expect(read('1700000000.100000')).toEqual(literal);
  expect(literal.rows[0]).toMatchObject({ threadTs: thread, messageTs: entry.messageTs, outcome: 'answered', replyTs: receipt.ts });
  expect(literal.counts.answered).toBe(1);
  expect(read('1700000000.1000000002').rows).toEqual([]);
  expect(read('1700000000.1x').rows).toEqual([]);
  expect(read().rows.map(row => row.threadTs)).toEqual([thread, other.threadTs]);
});
