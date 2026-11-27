/**
 * Slack outbound observation journal contract: recordSlackOutbound
 * appends sanitized metadata rows to <runs>/slack-bridge/outbound.jsonl
 * and readSlackOutboundJournal projects them newest-first, bounded and
 * structurally validated — the send-side sibling of journal.jsonl's
 * evidence rules. Rows carry ids, timestamps, closed status
 * vocabularies, static reason codes, the bus topic and pass tallies
 * only; anything else is dropped on write and marks the read degraded
 * on read. Journaling never throws.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  readSlackOutboundJournal,
  recordSlackOutbound,
  slackOutboundJournalPath,
  SLACK_OUTBOUND_MAX_BYTES,
  type SlackOutboundNoticePass,
  type SlackOutboundRow,
} from '../src/core/agents/slack-outbound.js';

const roots: string[] = [];
function root(): string {
  const dir = mkdtempSync(join(tmpdir(), 'slack-outbound-journal-'));
  roots.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const AT = '2026-11-26T12:00:00.000Z';

const delivery = (over: Partial<Extract<SlackOutboundRow, { kind: 'delivery' }>> = {}): SlackOutboundRow => ({
  at: AT, kind: 'delivery', status: 'sent', reason: 'delivery-proved',
  topic: 'leader', envelopeId: 'env-out-1', ...over,
});

const pass = (over: Partial<SlackOutboundNoticePass> = {}): SlackOutboundNoticePass => ({
  at: AT, kind: 'notice-pass', status: 'completed',
  planned: 4, sent: 3, failed: 1, skipped: 0, ...over,
});

describe('recordSlackOutbound + readSlackOutboundJournal', () => {
  it('round-trips both row kinds newest-first with only contract fields', () => {
    const runsDir = root();
    expect(recordSlackOutbound(delivery(), { runsDir })).toBe('recorded');
    expect(recordSlackOutbound(pass({ status: 'board-unavailable', reason: 'board-state-unknown', planned: undefined, sent: undefined, failed: undefined, skipped: undefined }), { runsDir })).toBe('recorded');
    const read = readSlackOutboundJournal({ runsDir });
    expect(read.state).toBe('ok');
    expect(read.entries).toHaveLength(2);
    // Newest-first: the pass row was appended last.
    expect(read.entries[0]).toMatchObject({ kind: 'notice-pass', status: 'board-unavailable', reason: 'board-state-unknown' });
    expect(read.entries[1]).toMatchObject({ kind: 'delivery', status: 'sent', topic: 'leader', envelopeId: 'env-out-1' });
    // Whitelist: no undeclared fields survive, and counts absent stay absent.
    expect(read.entries[0]).not.toHaveProperty('planned');
    expect(read.entries[1]).not.toHaveProperty('text');
  });

  it('reports missing for an absent journal and never creates one on read', () => {
    const runsDir = join(root(), 'runs');
    const read = readSlackOutboundJournal({ runsDir });
    expect(read).toEqual({ state: 'missing', entries: [] });
    expect(() => slackOutboundJournalPath(runsDir)).not.toThrow();
  });

  it('drops rows that fail sanitize and returns failed without writing', () => {
    const runsDir = root();
    const badAt = { ...delivery(), at: 'not-a-date' } as SlackOutboundRow;
    expect(recordSlackOutbound(badAt, { runsDir })).toBe('failed');
    const badStatus = { at: AT, kind: 'delivery', status: 'exploded' } as unknown as SlackOutboundRow;
    expect(recordSlackOutbound(badStatus, { runsDir })).toBe('failed');
    const badCount = pass({ planned: -1 });
    expect(recordSlackOutbound(badCount, { runsDir })).toBe('failed');
    const badKind = { at: AT, kind: 'telemetry', status: 'sent' } as unknown as SlackOutboundRow;
    expect(recordSlackOutbound(badKind, { runsDir })).toBe('failed');
    expect(readSlackOutboundJournal({ runsDir }).state).toBe('missing');
  });

  it('strips undeclared fields and control characters on write', () => {
    const runsDir = root();
    const sneaky = {
      at: AT, kind: 'delivery', status: 'refused', reason: 'audience-unproved',
      topic: 'leader', envelopeId: 'env-x',
      text: 'secret message body', token: 'xoxb-fake',
    } as unknown as SlackOutboundRow;
    expect(recordSlackOutbound(sneaky, { runsDir })).toBe('recorded');
    const read = readSlackOutboundJournal({ runsDir });
    expect(read.state).toBe('ok');
    const row = read.entries[0]!;
    expect(row).toMatchObject({ kind: 'delivery', status: 'refused', reason: 'audience-unproved' });
    expect(JSON.stringify(row)).not.toContain('secret message body');
    expect(JSON.stringify(row)).not.toContain('xoxb');
    // A control-character topic is dropped, not sanitized into the row.
    const ctrl = { ...delivery(), topic: 'lead\ner' } as SlackOutboundRow;
    expect(recordSlackOutbound(ctrl, { runsDir })).toBe('recorded');
    const second = readSlackOutboundJournal({ runsDir }).entries[0]!;
    expect(second).not.toHaveProperty('topic');
  });

  it('marks corrupted lines degraded, skips them and keeps valid rows', () => {
    const runsDir = root();
    mkdirSync(join(runsDir, 'slack-bridge'), { recursive: true, mode: 0o700 });
    writeFileSync(slackOutboundJournalPath(runsDir), [
      JSON.stringify({ at: AT, kind: 'delivery', status: 'sent', topic: 'leader' }),
      '{not json',
      JSON.stringify({ at: AT, kind: 'delivery', status: 'bogus-status' }),
      JSON.stringify({ at: 'garbage', kind: 'notice-pass', status: 'completed' }),
      '',
    ].join('\n'), { mode: 0o600 });
    const read = readSlackOutboundJournal({ runsDir });
    expect(read.state).toBe('degraded');
    expect(read.entries).toHaveLength(1);
    expect(read.entries[0]).toMatchObject({ kind: 'delivery', status: 'sent' });
  });

  it('refuses to append onto a degraded journal — damaged evidence stays untouched', () => {
    const runsDir = root();
    mkdirSync(join(runsDir, 'slack-bridge'), { recursive: true, mode: 0o700 });
    writeFileSync(slackOutboundJournalPath(runsDir), '{torn\n', { mode: 0o600 });
    expect(recordSlackOutbound(delivery(), { runsDir })).toBe('failed');
    expect(readSlackOutboundJournal({ runsDir }).state).toBe('degraded');
  });

  it('keeps only whole rows within the retention cap', () => {
    const runsDir = root();
    mkdirSync(join(runsDir, 'slack-bridge'), { recursive: true, mode: 0o700 });
    const path = slackOutboundJournalPath(runsDir);
    // Fixed-width rows: pad each topic so every line is exactly ROW bytes,
    // then fill to just under the cap so the next append must trim.
    const ROW = 280;
    const COUNT = 936; // 936 * 280 = 262080 bytes — inside (MAX-170, MAX]
    const pad = 't'.repeat(ROW - Buffer.byteLength(
      `${JSON.stringify({ at: AT, kind: 'delivery', status: 'sent', topic: '', envelopeId: 'env-0000' })}\n`, 'utf8'));
    const lines: string[] = [];
    for (let i = 0; i < COUNT; i++) {
      lines.push(`${JSON.stringify({ at: AT, kind: 'delivery', status: 'sent', topic: pad, envelopeId: `env-${String(i).padStart(4, '0')}` })}\n`);
    }
    const sized = lines.join('');
    expect(Buffer.byteLength(sized, 'utf8')).toBe(COUNT * ROW);
    expect(Buffer.byteLength(sized, 'utf8')).toBeLessThanOrEqual(SLACK_OUTBOUND_MAX_BYTES);
    writeFileSync(path, sized, { mode: 0o600 });
    const before = readSlackOutboundJournal({ runsDir, limit: 4096 });
    expect(before.state).toBe('ok');
    expect(before.entries).toHaveLength(COUNT);
    // This append crosses the cap: retention keeps the newest ~192 KiB of
    // whole rows — every retained line still parses and order stays newest-first.
    expect(recordSlackOutbound(delivery({ status: 'refused', reason: 'audience-unproved', topic: 'leader', envelopeId: 'env-newest' }), { runsDir })).toBe('recorded');
    const after = readSlackOutboundJournal({ runsDir, limit: 4096 });
    expect(after.state).toBe('ok');
    expect(after.entries.length).toBeLessThan(COUNT + 1);
    expect(after.entries[0]).toMatchObject({ envelopeId: 'env-newest', status: 'refused' });
    expect(after.entries.every((e) => e.kind === 'delivery')).toBe(true);
  });

  it('honors the projection limit newest-first and flags omitted rows', () => {
    const runsDir = root();
    for (let i = 0; i < 5; i++) {
      expect(recordSlackOutbound(delivery({ at: `2026-11-26T12:00:0${i}.000Z`, envelopeId: `env-${i}` }), { runsDir })).toBe('recorded');
    }
    const read = readSlackOutboundJournal({ runsDir, limit: 2 });
    expect(read.entries).toHaveLength(2);
    expect(read.entries[0]).toMatchObject({ envelopeId: 'env-4' });
    expect(read.entries[1]).toMatchObject({ envelopeId: 'env-3' });
    expect(read.projectionOmitted).toBe(true);
  });
});
