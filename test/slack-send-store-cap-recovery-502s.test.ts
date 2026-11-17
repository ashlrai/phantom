import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { slackJournalPath } from '../src/core/agents/slack-journal.js';
import { leaderReplySendKey } from '../src/core/agents/slack-reply-identity.js';
import { readSlackRequestTrace } from '../src/core/agents/slack-request-trace.js';
import { readSlackSendReceipts } from '../src/core/agents/slack-send-receipts.js';

describe('Slack send-store cap recovery preserves exact request evidence', () => {
  it.each(['rows', 'bytes'] as const)('recovers after exceeding the %s cap', cap => {
    const root = mkdtempSync(join(tmpdir(), 'slack-cap-502s-'));
    try {
      const runsDir = join(root, 'runs');
      const stateRoot = join(root, 'sends');
      mkdirSync(join(runsDir, 'slack-bridge'), { recursive: true, mode: 0o700 });
      mkdirSync(stateRoot, { mode: 0o700 });
      const journalPath = slackJournalPath(runsDir);
      const storePath = join(stateRoot, 'messages.json');
      const channelId = 'D0FAKE502S';
      const threadTs = '1794520000.000001';
      const ids = ['a'.repeat(64), 'b'.repeat(64)];
      const keys = ids.map(id => leaderReplySendKey(id));
      expect(new Set(keys).size).toBe(2);
      const payloads = ['synthetic-private-request-502s', 'synthetic-private-reply-502s'];
      const entries = ids.map((requestId, i) => ({
        at: `2026-11-13T02:30:0${i}.000Z`, decision: 'ingested', bus: 'posted', channelId, threadTs,
        messageTs: `179452000${i + 1}.000001`, requestId, text: payloads[0],
      }));
      writeFileSync(journalPath, entries.map(row => JSON.stringify(row)).join('\n') + '\n', { mode: 0o600 });
      const replies = ids.map((_, i) => ({ state: 'sent', channel: channelId, thread: threadTs,
        ts: `179452000${i + 3}.000001`, digest: payloads[1], clientId: payloads[1] }));
      const messages: Record<string, unknown> = Object.fromEntries(keys.map((key, i) => [key, replies[i]]));
      if (cap === 'rows') {
        for (let i = 0; i < 1022; i++) messages[i.toString(16).padStart(64, '0')] = replies[0];
      }
      const save = (rows: Record<string, unknown>, padding = '') => {
        const bytes = JSON.stringify({ version: 1, messages: rows, padding });
        writeFileSync(storePath, bytes, { mode: 0o600 });
        return Buffer.byteLength(bytes);
      };
      const inspect = (state: 'ok' | 'degraded') => {
        const before = [readFileSync(journalPath), readFileSync(storePath)];
        const sends = readSlackSendReceipts({ stateRoot });
        const trace = readSlackRequestTrace({ runsDir, stateRoot, thread: threadTs,
          now: () => new Date('2026-11-13T03:00:00Z') });
        expect([readFileSync(journalPath), readFileSync(storePath)]).toEqual(before);
        expect(sends.state).toBe(state);
        expect(trace.sources).toEqual({ journal: 'ok', sends: state });
        expect(trace.rows.map(row => row.messageTs)).toEqual(entries.map(row => row.messageTs));
        for (const privateValue of [...ids, ...keys, ...payloads]) expect(JSON.stringify(trace)).not.toContain(privateValue);
        return { sends, trace };
      };
      expect(save(messages)).toBeLessThan(1024 * 1024);
      const boundary = inspect('ok');
      expect(boundary.sends.receipts).toHaveLength(cap === 'rows' ? 1024 : 2);
      expect(boundary.trace.rows.map(row => [row.outcome, row.replyTs])).toEqual(replies.map(row => ['answered', row.ts]));
      if (cap === 'rows') {
        messages['f'.repeat(64)] = replies[1];
        expect(Object.keys(messages)).toHaveLength(1025);
        expect(save(messages)).toBeLessThan(1024 * 1024);
      } else {
        expect(Object.keys(messages)).toHaveLength(2);
        expect(save(messages, 'x'.repeat(1024 * 1024))).toBeGreaterThan(1024 * 1024);
      }
      const unavailable = inspect('degraded');
      expect(unavailable.sends.receipts).toEqual([]);
      expect(unavailable.trace.counts.answered).toBe(0);
      for (const row of unavailable.trace.rows) {
        expect(row.outcome).not.toBe('answered');
        expect(row.replyTs).toBeUndefined();
      }
      // Unavailable evidence cannot certify execution absence or authorize retry.
      const retained = cap === 'rows' ? 0 : 1;
      save({ [keys[retained]!]: replies[retained] });
      const recovered = inspect('ok');
      expect(recovered.sends.receipts).toHaveLength(1);
      expect(recovered.trace.counts.answered).toBe(1);
      expect(recovered.trace.rows[retained]).toMatchObject({ outcome: 'answered', replyTs: replies[retained]!.ts });
      expect(recovered.trace.rows[1 - retained]?.outcome).not.toBe('answered');
      expect(recovered.trace.rows[1 - retained]?.replyTs).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
