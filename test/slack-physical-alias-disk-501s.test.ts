import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { slackJournalPath } from '../src/core/agents/slack-journal.js';
import { leaderReplySendKey } from '../src/core/agents/slack-reply-identity.js';
import { readSlackRequestTrace } from '../src/core/agents/slack-request-trace.js';
import { readSlackSendReceipts } from '../src/core/agents/slack-send-receipts.js';

describe('physical Slack reply aliases on disk', () => {
  it('replays consistent and conflicting evidence without selecting a winner', () => {
    const root = mkdtempSync(join(tmpdir(), 'slack-alias-501s-'));
    try {
      const runsDir = join(root, 'runs');
      const stateRoot = join(root, 'sends');
      mkdirSync(join(runsDir, 'slack-bridge'), { recursive: true, mode: 0o700 });
      mkdirSync(stateRoot, { mode: 0o700 });
      const channelId = 'D0FAKELEADER';
      const thread = '1793920000.000001';
      const otherThread = '1793920000.000002';
      const ids = ['a'.repeat(64), 'b'.repeat(64), 'c'.repeat(64)];
      const keys = ids.map(leaderReplySendKey);
      expect(new Set(keys).size).toBe(3);
      const requests = ids.map((requestId, i) => ({
        at: `2026-11-06T01:46:4${i + 1}.000Z`, decision: 'ingested', bus: 'posted', channelId,
        threadTs: thread, messageTs: `179392000${i + 1}.000001`, requestId,
        text: `synthetic-payload-canary-${i}`,
      }));
      writeFileSync(slackJournalPath(runsDir), requests.map(row => JSON.stringify(row)).join('\n') + '\n', { mode: 0o600 });
      const sent = (ts: string, replyThread?: string) => ({ state: 'sent', channel: channelId, ts,
        ...(replyThread === undefined ? {} : { thread: replyThread }) });
      const first = sent('1793920005.100000', thread);
      const alias = sent('01793920005.1000000', thread);
      const independent = sent('1793920006.000001', thread);
      const attempt = { state: 'attempted', channel: channelId, thread: otherThread, ts: alias.ts };
      const save = (rows: Array<[string, unknown]>) => writeFileSync(join(stateRoot, 'messages.json'),
        JSON.stringify({ version: 1, messages: Object.fromEntries(rows) }), { mode: 0o600 });
      const inspect = (expectedCount: number) => {
        const sends = readSlackSendReceipts({ stateRoot });
        expect(sends.state).toBe('ok');
        expect(sends.receipts).toHaveLength(expectedCount);
        const trace = readSlackRequestTrace({ runsDir, stateRoot, now: () => new Date('2026-11-06T02:00:00Z') });
        expect(trace.sources).toEqual({ journal: 'ok', sends: 'ok' });
        for (const hidden of [root, runsDir, stateRoot, ...ids, ...requests.map(row => row.text)]) {
          expect(JSON.stringify(trace)).not.toContain(hidden);
        }
        return trace.rows.map(row => [row.messageTs, row.outcome, row.replyTs]);
      };
      const expected = (a: string, b: string, aTs?: string, bTs?: string) => [
        [requests[0]!.messageTs, a, aTs], [requests[1]!.messageTs, b, bTs],
        [requests[2]!.messageTs, 'unanswered', undefined],
      ];
      // An attempt for another key at the same physical location cannot override a sent receipt.
      save([[keys[0]!, first], [keys[1]!, attempt]]);
      expect(inspect(2)).toEqual(expected('answered', 'uncertain', first.ts));
      // Both exact keys name the same message in the same thread, despite decimal aliases.
      save([[keys[0]!, first], [keys[1]!, alias]]);
      expect(inspect(2)).toEqual(expected('answered', 'answered', alias.ts, alias.ts));
      for (const conflicting of [sent(alias.ts, otherThread), sent(alias.ts)]) {
        const rows: Array<[string, unknown]> = [[keys[0]!, first], [keys[1]!, conflicting]];
        save(rows);
        expect(inspect(2)).toEqual(expected('uncertain', 'uncertain'));
        save(rows.reverse());
        expect(inspect(2)).toEqual(expected('uncertain', 'uncertain'));
      }
      // Removing the conflict and assigning a distinct physical reply restores both requests.
      save([[keys[0]!, first], [keys[1]!, independent]]);
      expect(inspect(2)).toEqual(expected('answered', 'answered', first.ts, independent.ts));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
