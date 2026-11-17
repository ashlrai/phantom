import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recordSlackObservation, slackJournalPath, type SlackObservation } from '../src/core/agents/slack-journal.js';
import { fakeRequestId, replyKey } from './helpers/slack-causal.js';
import { readSlackRequestTrace } from '../src/core/agents/slack-request-trace.js';

const channel = 'C0FAKE4631';
const sibling = 'C0FAKE4632';
const thread = '1700000000.000001';
const messageTs = '1700000000.000002';
const replyTs = '1700000040.000000';
const now = new Date('2023-11-14T22:14:00.000Z');
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe('persisted unknown Slack ingress allocation', () => {
  it.each(['posted', 'duplicate'] as const)('reopens evidence without stealing the %s reply', (bus) => {
    const root = mkdtempSync(join(tmpdir(), 'slack-463s-')); roots.push(root);
    const runsDir = join(root, 'runs');
    const stateRoot = join(root, 'state');
    const observation = (at: string, channelId: string, ingress?: SlackObservation['bus']): SlackObservation => ({
      at, channelId, threadTs: thread, messageTs, decision: 'ingested', requestId: fakeRequestId(`463s:${channelId}`),
      ...(ingress === undefined ? {} : { bus: ingress }),
    });
    for (const row of [
      observation('2023-11-14T22:13:21.000Z', channel),
      observation('2023-11-14T22:13:22.000Z', channel, bus),
      observation('2023-11-14T22:13:20.000Z', sibling, 'posted'),
    ]) expect(recordSlackObservation(row, { runsDir })).toBe('recorded');

    mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
    const storePath = join(stateRoot, 'messages.json');
    const receipt = (digest: string, state: 'sent' | 'attempted', ts: string) => ({
      digest, clientId: '11111111-1111-1111-1111-111111111111', expiresAt: 9e12,
      channel, thread, state, ts,
    });
    writeFileSync(storePath, JSON.stringify({ version: 1, messages: {
      // Both receipts are keyed to the SAME-channel request; the sibling channel's request has its own key and no send.
      [replyKey(fakeRequestId(`463s:${channel}`))]: receipt('a'.repeat(64), 'sent', replyTs),
      [replyKey(fakeRequestId('463s:other'))]: receipt('b'.repeat(64), 'attempted', '1700000030.000000'),
    } }), { mode: 0o600 });
    const journalPath = slackJournalPath(runsDir);
    const before = [readFileSync(journalPath), readFileSync(storePath)];
    const read = () => readSlackRequestTrace({ runsDir, stateRoot, now: () => now, thread });
    const result = read();
    expect(result.sources).toEqual({ journal: 'ok', sends: 'ok' });
    expect(result.rows.map(row => [row.channelId, row.ingress, row.outcome, row.replyTs])).toEqual([
      [sibling, 'posted', 'unanswered', undefined],
      [channel, 'unknown', 'uncertain', undefined],
      [channel, bus, 'answered', replyTs],
    ]);
    expect(result.counts).toEqual({ total: 3, answered: 1, uncertain: 1, busFailed: 0, unanswered: 1 });
    expect(read()).toEqual(result);
    expect([readFileSync(journalPath), readFileSync(storePath)]).toEqual(before);
  });
});
