import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GMAIL_TRIAGE_LATEST_SCHEMA, gmailTriageLatestPath, readGmailTriageLatest, writeGmailTriageLatest } from '../src/core/comms/gmail-triage-latest.js';

let runsDir: string;
beforeEach(() => { runsDir = mkdtempSync(join(tmpdir(), 'gmail-latest-')); });
afterEach(() => { rmSync(runsDir, { recursive: true, force: true }); });

const input = { dir: '/private/mail/Secret Folder', scanned: 3, updates: 1, drafted: 1, review: 0, failed: 0, unreadInSample: 3, target: 100, archiveCandidateCount: 0 };

describe('gmail triage latest', () => {
  it('round-trips with a basename label and counts only', () => {
    writeGmailTriageLatest(runsDir, { ...input, now: () => new Date('2026-11-09T10:00:00Z') });
    expect(readGmailTriageLatest(runsDir)).toEqual({ schema: GMAIL_TRIAGE_LATEST_SCHEMA, at: '2026-11-09T10:00:00.000Z', ...input, dir: 'Secret Folder' });
    expect(readFileSync(gmailTriageLatestPath(runsDir), 'utf8')).not.toContain('/private/mail');
  });

  it('uses private modes', () => {
    writeGmailTriageLatest(runsDir, input);
    expect(statSync(gmailTriageLatestPath(runsDir)).mode & 0o777).toBe(0o600);
    expect(statSync(join(runsDir, 'comms')).mode & 0o777).toBe(0o700);
  });

  it('reads null for missing, garbage, wrong schema, bad counts and oversize files', () => {
    expect(readGmailTriageLatest(runsDir)).toBeNull();
    mkdirSync(join(runsDir, 'comms'));
    const path = gmailTriageLatestPath(runsDir);
    for (const text of ['not json', JSON.stringify({ ...input, schema: 'other.v1', at: 'x' }),
      JSON.stringify({ schema: GMAIL_TRIAGE_LATEST_SCHEMA, at: 'x', ...input, scanned: -1 }),
      JSON.stringify({ schema: GMAIL_TRIAGE_LATEST_SCHEMA, at: 'x', ...input, pad: 'x'.repeat(70_000) })]) {
      writeFileSync(path, text);
      expect(readGmailTriageLatest(runsDir)).toBeNull();
    }
  });
});
