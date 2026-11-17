import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readSlackJournal, slackJournalPath } from '../src/core/agents/slack-journal.js';
import { leaderReplyEnvelopeId, leaderReplySendKey, slackSendStoreKey } from '../src/core/agents/slack-reply-identity.js';
import { readSlackRequestTrace } from '../src/core/agents/slack-request-trace.js';
import { readSlackSendReceipts } from '../src/core/agents/slack-send-receipts.js';

describe('Slack thread request evidence across disk replay', () => {
  it('binds each request only to its own receipt, counting duplicate ingress rows', () => {
    const root = mkdtempSync(join(tmpdir(), 'slack-thread-disk-'));
    try {
      const runsDir = join(root, 'runs');
      const stateRoot = join(root, 'sends');
      const journalPath = slackJournalPath(runsDir);
      const storePath = join(stateRoot, 'messages.json');
      mkdirSync(join(runsDir, 'slack-bridge'), { recursive: true, mode: 0o700 });
      mkdirSync(stateRoot, { mode: 0o700 });
      const channelId = 'D0FAKELEADER';
      const threadTs = '1793920000.000001';
      const ids = ['a'.repeat(64), 'b'.repeat(64)];
      const keys = ids.map(id => leaderReplySendKey(id));
      expect(keys[0]).not.toBe(keys[1]);
      expect(keys).toEqual(ids.map(id => slackSendStoreKey(leaderReplyEnvelopeId(id))));
      const first = { at: '2026-11-06T01:46:41.000Z', decision: 'ingested', bus: 'posted', channelId, threadTs,
        messageTs: '1793920001.000001', requestId: ids[0], text: 'synthetic-first-payload-canary' };
      const second = { ...first, at: '2026-11-06T01:46:42.000Z', messageTs: '1793920002.000001',
        requestId: ids[1], text: 'synthetic-second-payload-canary' };
      const duplicate = { ...first, at: '2026-11-06T01:46:43.000Z', bus: 'duplicate' };
      writeFileSync(journalPath, [first, second, duplicate].map(row => JSON.stringify(row)).join('\n') + '\n', { mode: 0o600 });
      const sentFirst = { state: 'sent', channel: channelId, thread: threadTs, ts: '1793920003.000001' };
      const save = (messages: Record<string, unknown>) => writeFileSync(storePath, JSON.stringify({ version: 1, messages }), { mode: 0o600 });
      const now = () => new Date('2026-11-06T02:00:00Z');
      const inspect = () => {
        const before = [readFileSync(journalPath), readFileSync(storePath)];
        const journal = readSlackJournal({ runsDir });
        const sends = readSlackSendReceipts({ stateRoot });
        const trace = readSlackRequestTrace({ runsDir, stateRoot, now });
        expect([readFileSync(journalPath), readFileSync(storePath)]).toEqual(before);
        expect(journal.state).toBe('ok');
        expect(sends.state).toBe('ok');
        expect(trace.sources).toEqual({ journal: 'ok', sends: 'ok' });
        expect(journal.entries.map(row => [row.requestId, row.messageTs, row.bus])).toEqual([
          [ids[0], first.messageTs, 'duplicate'], [ids[1], second.messageTs, 'posted'], [ids[0], first.messageTs, 'posted'],
        ]);
        for (const secret of [...ids, first.text, second.text]) expect(JSON.stringify(trace)).not.toContain(secret);
        return trace;
      };
      save({ [keys[0]!]: sentFirst });
      let trace = inspect();
      expect(trace.counts).toEqual({ total: 3, answered: 2, uncertain: 0, busFailed: 0, unanswered: 1 });
      expect(trace.rows.map(row => [row.messageTs, row.ingress, row.outcome, row.replyTs])).toEqual([
        [first.messageTs, 'posted', 'answered', sentFirst.ts],
        [second.messageTs, 'posted', 'unanswered', undefined],
        [first.messageTs, 'duplicate', 'answered', sentFirst.ts],
      ]);
      save({ [keys[0]!]: sentFirst, [keys[1]!]: { state: 'attempted', channel: channelId, thread: threadTs } });
      trace = inspect();
      expect(trace.counts).toEqual({ total: 3, answered: 2, uncertain: 1, busFailed: 0, unanswered: 0 });
      expect(trace.rows[1]).toMatchObject({ messageTs: second.messageTs, outcome: 'uncertain' });
      expect(trace.rows[1]?.replyTs).toBeUndefined();
      const sentSecond = { state: 'sent', channel: channelId, thread: threadTs, ts: '1793920004.000001' };
      save({ [keys[0]!]: sentFirst, [keys[1]!]: sentSecond });
      trace = inspect();
      expect(trace.counts).toEqual({ total: 3, answered: 3, uncertain: 0, busFailed: 0, unanswered: 0 });
      expect(trace.rows.map(row => [row.messageTs, row.outcome, row.replyTs])).toEqual([
        [first.messageTs, 'answered', sentFirst.ts], [second.messageTs, 'answered', sentSecond.ts],
        [first.messageTs, 'answered', sentFirst.ts],
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
