import { afterEach, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recordSlackObservation, slackJournalPath, type SlackObservation } from '../src/core/agents/slack-journal.js';
import { readSlackRequestTrace } from '../src/core/agents/slack-request-trace.js';
import { fakeRequestId, replyKey } from './helpers/slack-causal.js';
import { writePrivateFileAtomic } from '../src/core/verse/preferences.js';

const channel = 'C0FAKE4671';
const thread = '1700000000.000001';
const now = new Date('2023-11-14T22:14:00.000Z');
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

it.each(['posted', 'duplicate'] as const)('reopens a failed ingress and %s retry with sibling evidence', (bus) => {
  const root = mkdtempSync(join(tmpdir(), 'slack-467s-')); roots.push(root);
  const runsDir = join(root, 'runs');
  const stateRoot = join(root, 'state');
  const row = (at: string, messageTs: string, ingress?: SlackObservation['bus']): SlackObservation => ({
    at, channelId: channel, threadTs: thread, messageTs, decision: 'ingested', requestId: fakeRequestId(messageTs),
    ...(ingress === undefined ? {} : { bus: ingress }),
  });
  const target = '1700000001.000000';
  const sibling = '1700000020.000000';
  const targetReply = '1700000015.000000';
  const siblingReply = '1700000035.000000';
  for (const observation of [
    row('2023-11-14T22:13:21.000Z', target, 'failed'),
    row('2023-11-14T22:13:22.000Z', target, bus),
    row('2023-11-14T22:13:23.000Z', '1700000002.000000'),
    row('2023-11-14T22:13:30.000Z', sibling, 'posted'),
    row('2023-11-14T22:15:00.000Z', '1700000003.000000', 'posted'),
  ]) expect(recordSlackObservation(observation, { runsDir })).toBe('recorded');

  mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
  const storePath = join(stateRoot, 'messages.json');
  const receipt = (digest: string, ts: string) => ({ digest, clientId: '11111111-1111-1111-1111-111111111111',
    expiresAt: 9000000000000, channel, thread, state: 'sent', ts });
  // The transport's private atomic writer and v1 receipt schema, without invoking delivery.
  writePrivateFileAtomic(storePath, JSON.stringify({ version: 1, messages: {
    [replyKey(fakeRequestId(target))]: receipt('a'.repeat(64), targetReply),
    [replyKey(fakeRequestId(sibling))]: receipt('b'.repeat(64), siblingReply),
  } }));
  const journalPath = slackJournalPath(runsDir);
  const before = [readFileSync(journalPath), readFileSync(storePath)];
  const read = () => readSlackRequestTrace({ runsDir, stateRoot, now: () => now, thread });
  const result = read();
  expect(result.sources).toEqual({ journal: 'ok', sends: 'ok' });
  expect(result.asOf).toBe(now.toISOString());
  expect(result.rows.map(r => [r.messageTs, r.ingress, r.outcome, r.replyTs])).toEqual([
    [target, 'failed', 'bus-failed', targetReply],
    [target, bus, 'answered', targetReply],
    ['1700000002.000000', 'unknown', 'unanswered', undefined],
    [sibling, 'posted', 'answered', siblingReply],
    ['1700000003.000000', 'posted', 'unanswered', undefined],
  ]);
  expect(result.counts).toEqual({ total: 5, answered: 2, uncertain: 0, busFailed: 1, unanswered: 2 });
  expect(read()).toEqual(result);
  expect([readFileSync(journalPath), readFileSync(storePath)]).toEqual(before);
  // These fields describe the local evidence snapshot, not live ownership or execution.
  expect(Object.keys(result).sort()).toEqual(['asOf', 'counts', 'rows', 'sources']);
  expect(JSON.stringify(result)).not.toMatch(/ASSIGNED|RUNNING|VERIFIED/);

  rmSync(storePath);
  const missing = read();
  expect(missing.sources).toEqual({ journal: 'ok', sends: 'missing' });
  expect(missing.counts).toEqual({ total: 5, answered: 0, uncertain: 0, busFailed: 1, unanswered: 4 });
  expect(missing.rows.every(r => r.replyTs === undefined)).toBe(true);
  expect(read()).toEqual(missing);
  expect(readFileSync(journalPath)).toEqual(before[0]);
});
