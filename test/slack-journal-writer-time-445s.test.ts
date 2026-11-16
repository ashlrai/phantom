import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readSlackJournal, recordSlackObservation, slackBridgeDir, slackJournalPath } from '../src/core/agents/slack-journal.js';

const roots: string[] = [];
function root(): string {
  const dir = mkdtempSync(join(tmpdir(), 'slack-445s-'));
  roots.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('Slack journal writer timestamps', () => {
  it('rejects an invalid date before creating the journal directory', () => {
    const runsDir = root();
    expect(recordSlackObservation({ at: 'not-a-date', decision: 'ignored' }, { runsDir })).toBe('failed');
    expect(existsSync(slackBridgeDir(runsDir))).toBe(false);
    expect(readSlackJournal({ runsDir })).toEqual({ state: 'missing', entries: [] });
  });

  it('preserves healthy evidence and accepts a subsequent reader-compatible legacy date', () => {
    const runsDir = root();
    const prior = { at: '2026-11-15T12:00:00Z', decision: 'ingested' as const, eventId: 'prior' };
    const next = { at: 'November 15, 2026 13:00:00 GMT', decision: 'ignored' as const, eventId: 'next' };
    expect(recordSlackObservation(prior, { runsDir })).toBe('recorded');
    const before = readFileSync(slackJournalPath(runsDir));
    expect(recordSlackObservation({ at: 'invalid-date', decision: 'ignored' }, { runsDir })).toBe('failed');
    expect(readFileSync(slackJournalPath(runsDir))).toEqual(before);
    expect(recordSlackObservation(next, { runsDir })).toBe('recorded');
    expect(readSlackJournal({ runsDir })).toEqual({ state: 'ok', entries: [next, prior] });
  });

  it('refuses an already damaged predecessor without changing it', () => {
    const runsDir = root();
    mkdirSync(slackBridgeDir(runsDir), { recursive: true, mode: 0o700 });
    const path = slackJournalPath(runsDir);
    const damaged = '{"at":"invalid-date","decision":"ignored"}\n';
    writeFileSync(path, damaged, { mode: 0o600 });
    expect(readSlackJournal({ runsDir }).state).toBe('degraded');
    expect(recordSlackObservation({ at: '2026-11-15T12:00:00Z', decision: 'ignored' }, { runsDir })).toBe('failed');
    expect(readFileSync(path, 'utf8')).toBe(damaged);
    expect(readSlackJournal({ runsDir }).state).toBe('degraded');
  });
});
