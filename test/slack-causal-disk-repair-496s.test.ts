import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { recordSlackObservation, slackJournalPath } from '../src/core/agents/slack-journal.js';
import { readSlackRequestTrace } from '../src/core/agents/slack-request-trace.js';
import { fakeRequestId, replyKey, storeRow } from './helpers/slack-causal.js';

describe('Slack causal disk repair (496S)', () => {
  it('recomputes physical identity conflicts after a receipt is repaired', () => {
    const root = mkdtempSync(join(tmpdir(), 'slack-causal-repair-'));
    try {
      const runsDir = join(root, 'runs');
      const stateRoot = join(root, 'send-store');
      mkdirSync(stateRoot, { mode: 0o700 });
      const storePath = join(stateRoot, 'messages.json');
      const channel = 'C0FAKE496';
      const ids = [fakeRequestId('496-a'), fakeRequestId('496-b')];
      const threads = ['1700000000.000001', '1700000000.000002'];
      const messages = ['1700000000.000100', '1700000000.000101'];
      const sharedTs = '1700000000.000200';
      const repairedTs = '1700000000.000300';
      const privateText = 'synthetic private request text 496';
      for (let i = 0; i < 2; i++) {
        expect(recordSlackObservation({
          at: '2023-11-14T22:13:20.000Z', decision: 'ingested', bus: 'posted',
          channelId: channel, threadTs: threads[i]!, messageTs: messages[i]!, requestId: ids[i]!,
          envelopeId: privateText,
        }, { runsDir })).toBe('recorded');
      }
      const store = {
        version: 1,
        messages: {
          [replyKey(ids[0]!)]: storeRow({ channel, thread: threads[0], state: 'sent', ts: sharedTs }),
          [replyKey(ids[1]!)]: storeRow({ channel, thread: threads[1], state: 'sent', ts: sharedTs }),
          [replyKey(fakeRequestId('496-attempt'))]: storeRow({ channel, thread: threads[0], state: 'attempted', ts: sharedTs }),
        },
      };
      const writeStore = () => writeFileSync(storePath, JSON.stringify(store), { mode: 0o600 });
      writeStore();
      const journalPath = slackJournalPath(runsDir);
      const bytes = () => [readFileSync(journalPath), readFileSync(storePath)];
      const read = () => readSlackRequestTrace({ runsDir, stateRoot, now: () => new Date('2023-11-14T22:13:30.000Z') });
      const before = bytes();
      const conflicted = read();
      expect(conflicted.sources).toEqual({ journal: 'ok', sends: 'ok' });
      expect(conflicted.counts).toEqual({ total: 2, answered: 0, uncertain: 2, busFailed: 0, unanswered: 0 });
      expect(conflicted.rows.map(row => row.outcome)).toEqual(['uncertain', 'uncertain']);
      expect(conflicted.rows.every(row => !('replyTs' in row))).toBe(true);
      expect(bytes()).toEqual(before);

      store.messages[replyKey(ids[1]!)] = storeRow({ channel, thread: threads[1], state: 'sent', ts: repairedTs });
      writeStore();
      const repairedBytes = bytes();
      const repaired = read();
      expect(repaired.sources).toEqual({ journal: 'ok', sends: 'ok' });
      expect(repaired.counts).toEqual({ total: 2, answered: 2, uncertain: 0, busFailed: 0, unanswered: 0 });
      expect(repaired.rows.map(({ threadTs, messageTs, outcome, replyTs }) => ({ threadTs, messageTs, outcome, replyTs }))).toEqual([
        { threadTs: threads[0], messageTs: messages[0], outcome: 'answered', replyTs: sharedTs },
        { threadTs: threads[1], messageTs: messages[1], outcome: 'answered', replyTs: repairedTs },
      ]);
      expect(bytes()).toEqual(repairedBytes);
      for (const trace of [conflicted, repaired]) {
        for (const secret of [...ids, privateText]) expect(JSON.stringify(trace)).not.toContain(secret);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
