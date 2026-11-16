import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { readSlackJournal, recordSlackObservation, slackJournalPath } from '../src/core/agents/slack-journal.js';

const roots: string[] = [];
function root(): string {
  const dir = mkdtempSync(join(tmpdir(), 'slack-channel-449s-'));
  roots.push(dir);
  return dir;
}
afterEach(() => { for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const base = { at: '2026-11-15T12:00:00.000Z', decision: 'ingested' as const };

it('degrades and excludes a malformed channel while retaining neighboring valid evidence', () => {
  const runsDir = root();
  mkdirSync(join(runsDir, 'slack-bridge'), { mode: 0o700 });
  const valid = { ...base, channelId: 'C0FAKE449S' };
  const bad = { ...base, channelId: 'not-a-channel' };
  const body = [valid, bad].map(row => JSON.stringify(row)).join('\n') + '\n';
  writeFileSync(slackJournalPath(runsDir), body, { mode: 0o600 });
  expect(readSlackJournal({ runsDir })).toEqual({ state: 'degraded', entries: [valid] });
  expect(recordSlackObservation(valid, { runsDir })).toBe('failed');
  expect(readFileSync(slackJournalPath(runsDir), 'utf8')).toBe(body);
});

it('preserves valid channel identities and ignored observations without a channel', () => {
  const runsDir = root();
  const rows = [
    { ...base, channelId: 'C0FAKE449S' },
    { ...base, channelId: 'G0FAKE449S' },
    { at: base.at, decision: 'ignored' as const, reason: 'prevalidation' },
  ];
  for (const row of rows) expect(recordSlackObservation(row, { runsDir })).toBe('recorded');
  expect(readSlackJournal({ runsDir })).toEqual({ state: 'ok', entries: [...rows].reverse() });
  expect(recordSlackObservation({ ...base, channelId: 'bad' }, { runsDir })).toBe('failed');
  expect(readSlackJournal({ runsDir })).toEqual({ state: 'ok', entries: [...rows].reverse() });
});
