import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { readSlackJournal, slackJournalPath } from '../src/core/agents/slack-journal.js';
import { bindSlackReplies } from '../src/core/agents/slack-reply-binding.js';
import { leaderReplySendKey } from '../src/core/agents/slack-reply-identity.js';
import { readSlackRequestTrace } from '../src/core/agents/slack-request-trace.js';
import { readSlackSendReceipts } from '../src/core/agents/slack-send-receipts.js';

it('recovers exact-key Slack reply evidence on fresh disk reads after clock correction', () => {
  const root = mkdtempSync(join(tmpdir(), 'slack-reply-clock-'));
  try {
    const runsDir = join(root, 'runs');
    const stateRoot = join(root, 'sends');
    const journalPath = slackJournalPath(runsDir);
    const storePath = join(stateRoot, 'messages.json');
    mkdirSync(join(runsDir, 'slack-bridge'), { recursive: true, mode: 0o700 });
    mkdirSync(stateRoot, { mode: 0o700 });
    const channelId = 'D0FAKECLOCK';
    const threadTs = '1793929600.000001';
    const ids = ['a'.repeat(64), 'b'.repeat(64)];
    const keys = ids.map(id => leaderReplySendKey(id));
    expect(keys[0]).not.toBe(keys[1]);
    const first = { at: '2026-11-06T01:46:41.000Z', decision: 'ingested', bus: 'posted', channelId, threadTs,
      messageTs: '1793929601.000001', requestId: ids[0], text: 'synthetic-clock-first-payload-canary' };
    const second = { ...first, at: '2026-11-06T01:46:50.000Z', messageTs: '1793929602.000001',
      requestId: ids[1], text: 'synthetic-clock-second-payload-canary' };
    const receipts = [
      { state: 'sent', channel: channelId, thread: threadTs, ts: '1793929610.000000' },
      { state: 'sent', channel: channelId, thread: threadTs, ts: '1793929615.000001' },
    ];
    writeFileSync(journalPath, [first, second].map(row => JSON.stringify(row)).join('\n') + '\n', { mode: 0o600 });
    writeFileSync(storePath, JSON.stringify({ version: 1, messages: {
      [keys[0]!]: receipts[0], [keys[1]!]: receipts[1],
    } }), { mode: 0o600 });
    const bytes = [readFileSync(journalPath), readFileSync(storePath)];
    const inspect = (iso: string, answered: number, futureDated: number) => {
      // Each invocation rereads both files, as a restarted reader would; no sender is imported.
      const now = new Date(iso);
      const journal = readSlackJournal({ runsDir });
      const sends = readSlackSendReceipts({ stateRoot });
      expect(journal.state).toBe('ok');
      expect(journal.entries).toHaveLength(2);
      expect(sends).toEqual({ state: 'ok', receipts: receipts.map((row, i) => ({ ...row, key: keys[i] })) });
      const binding = bindSlackReplies({ requests: journal.entries.map(row => ({
        at: row.at, channelId: row.channelId!, threadTs: row.threadTs!, messageTs: row.messageTs!, requestId: row.requestId,
      })), receipts: sends.receipts, now });
      expect(binding.rejected).toBe(0);
      expect(binding.futureDated).toBe(futureDated);
      expect(binding.answered.map(row => [row.requestId, row.replyTs])).toEqual(answered ? [[ids[0], receipts[0]!.ts]] : []);
      expect(binding.byRequestId.get(ids[1]!)?.replyTs).toBeUndefined();
      const trace = readSlackRequestTrace({ runsDir, stateRoot, now: () => now });
      expect(trace.sources).toEqual({ journal: 'ok', sends: 'ok' });
      expect(trace.rows.map(row => [row.messageTs, row.outcome, row.replyTs])).toEqual([
        [first.messageTs, answered ? 'answered' : 'unanswered', answered ? receipts[0]!.ts : undefined],
        [second.messageTs, 'unanswered', undefined],
      ]);
      expect(trace.counts).toEqual({ total: 2, answered, uncertain: 0, busFailed: 0, unanswered: 2 - answered });
      for (const outcome of ['answered', 'uncertain', 'unanswered'] as const) {
        expect(trace.counts[outcome]).toBe(trace.rows.filter(row => row.outcome === outcome).length);
      }
      expect(trace.counts.busFailed).toBe(trace.rows.filter(row => row.outcome === 'bus-failed').length);
      expect(trace.counts.total).toBe(trace.rows.length);
      for (const canary of [...ids, first.text, second.text]) expect(JSON.stringify(trace)).not.toContain(canary);
      expect([readFileSync(journalPath), readFileSync(storePath)]).toEqual(bytes);
      return binding;
    };
    inspect('2026-11-06T01:46:44.999Z', 0, 3); // First receipt exceeds cutoff 1793929609.999 by 1 ms.
    inspect('2026-11-06T01:46:45.000Z', 1, 2); // Inclusive cutoff 1793929610.000.
    const advanced = inspect('2026-11-06T01:46:50.000Z', 1, 1);
    expect(advanced.byRequestId.get(ids[1]!)).toEqual({ verdict: 'unanswered' }); // Own receipt is 1 microsecond too new.
    const rolledBack = inspect('2026-11-06T01:46:49.999Z', 1, 2);
    expect(rolledBack.byRequestId.has(ids[1]!)).toBe(false); // Observation itself is now future-dated.
    const deepRollback = inspect('2026-11-06T01:46:40.999Z', 0, 4);
    expect(deepRollback.byRequestId.has(ids[0]!)).toBe(false);
    const restored = inspect('2026-11-06T01:46:50.000Z', 1, 1);
    expect(restored.byRequestId.get(ids[1]!)).toEqual({ verdict: 'unanswered' });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
