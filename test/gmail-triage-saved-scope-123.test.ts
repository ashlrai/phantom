import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetGmailTriage } from '../src/cli/fleet-gmail-triage.js';
import {
  GMAIL_TRIAGE_LATEST_SCHEMA, GMAIL_TRIAGE_STORE_SCHEMA, gmailTriageLatestPath,
  readGmailTriageInboxReports, readGmailTriageLatest, writeGmailTriageLatest,
} from '../src/core/comms/gmail-triage-latest.js';

let root: string, runsDir: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'gmail-scope-'));
  runsDir = join(root, 'runs');
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }); });

/** Synthetic exports only: fake senders and bodies, no real addresses or links. */
function seed(dir: string, total: number): void {
  mkdirSync(dir, { recursive: true });
  for (let i = 0; i < total; i++) {
    const name = `message-${String(i).padStart(4, '0')}.eml`;
    writeFileSync(join(dir, name),
      `From: person${i}@example.test\nMessage-ID: <scope-${i}@example.test>\nSubject: Note ${i}\n\nBody ${i}.\n`);
    utimesSync(join(dir, name), i + 1, i + 1);
  }
}

const counts = { scanned: 2, updates: 1, drafted: 0, review: 1, failed: 0, unreadInSample: 2, target: 100, archiveCandidateCount: 0 };

describe('saved gmail triage scope', () => {
  it('persists the adapter scope so truncation and the scan bound survive the save', async () => {
    const mailDir = join(root, 'big-export');
    seed(mailDir, 6);
    expect(await cmdFleetGmailTriage(['--dir', mailDir, '--scan', '4', '--runs-dir', runsDir, '--json'])).toBe(0);
    const latest = readGmailTriageLatest(runsDir);
    expect(latest).toMatchObject({ dir: 'big-export', scanned: 4, unreadInSample: 4 });
    expect(latest?.scope).toEqual({ source: 'local-eml-export', files: 6, limit: 4, truncated: true });
    // The stored file carries counts and scope only: no export path or content.
    const text = readFileSync(gmailTriageLatestPath(runsDir), 'utf8');
    expect(text).not.toContain(mailDir);
    expect(text).not.toContain('example.test');
    expect(text).not.toContain('Note 0');
  });

  it('keeps each inbox scope when a second export is triaged', async () => {
    const first = join(root, 'accounts', 'alpha');
    const second = join(root, 'accounts', 'beta');
    seed(first, 6); seed(second, 2);
    expect(await cmdFleetGmailTriage(['--dir', first, '--scan', '4', '--runs-dir', runsDir, '--json'])).toBe(0);
    expect(await cmdFleetGmailTriage(['--dir', second, '--runs-dir', runsDir, '--json'])).toBe(0);
    const reports = readGmailTriageInboxReports(runsDir);
    expect(reports?.schema).toBe(GMAIL_TRIAGE_STORE_SCHEMA);
    const alpha = reports?.inboxes.find(r => r.dir === 'alpha');
    const beta = reports?.inboxes.find(r => r.dir === 'beta');
    expect(alpha?.scope).toEqual({ source: 'local-eml-export', files: 6, limit: 4, truncated: true });
    // The whole small export fit under the default bound: complete, not truncated.
    expect(beta?.scope).toEqual({ source: 'local-eml-export', files: 2, limit: 100, truncated: false });
    expect(reports?.latest?.dir).toBe('beta');
  });

  it('--no-save writes no record and therefore no scope', async () => {
    const mailDir = join(root, 'mail');
    seed(mailDir, 3);
    expect(await cmdFleetGmailTriage(['--dir', mailDir, '--scan', '2', '--runs-dir', runsDir, '--no-save'])).toBe(0);
    expect(existsSync(gmailTriageLatestPath(runsDir))).toBe(false);
  });

  it('leaves scope absent on a legacy record that never stored one', () => {
    const legacy = { schema: GMAIL_TRIAGE_LATEST_SCHEMA, at: '2026-11-09T10:00:00.000Z', dir: 'old', ...counts };
    mkdirSync(dirname(gmailTriageLatestPath(runsDir)), { recursive: true });
    writeFileSync(gmailTriageLatestPath(runsDir), `${JSON.stringify(legacy)}\n`);
    const latest = readGmailTriageLatest(runsDir);
    expect(latest).toEqual(legacy);
    expect(latest && 'scope' in latest).toBe(false);
    expect(readGmailTriageInboxReports(runsDir)?.inboxes[0] && 'scope' in readGmailTriageInboxReports(runsDir)!.inboxes[0]).toBe(false);
  });

  it('omits malformed stored scope but keeps the count record, and projects only known fields', () => {
    const base = { schema: GMAIL_TRIAGE_LATEST_SCHEMA, at: '2026-11-09T10:00:00.000Z', dir: 'mail', ...counts };
    const path = gmailTriageLatestPath(runsDir);
    mkdirSync(dirname(path), { recursive: true });
    const malformed = [
      'yes',
      { source: 'gmail-api', files: 6, limit: 4, truncated: true },
      { source: 'local-eml-export', files: '6', limit: 4, truncated: true },
      { source: 'local-eml-export', files: 6, limit: 0, truncated: true },
      { source: 'local-eml-export', files: 6, limit: 4, truncated: 'yes' },
      [{ source: 'local-eml-export', files: 6, limit: 4, truncated: true }],
    ];
    for (const scope of malformed) {
      writeFileSync(path, `${JSON.stringify({ ...base, scope })}\n`);
      const latest = readGmailTriageLatest(runsDir);
      expect(latest, JSON.stringify(scope)).toMatchObject({ dir: 'mail', scanned: 2 });
      expect(latest && 'scope' in latest, JSON.stringify(scope)).toBe(false);
    }
    // A valid scope keeps only its count fields: smuggled paths or content drop out.
    writeFileSync(path, `${JSON.stringify({ ...base,
      scope: { source: 'local-eml-export', files: 6, limit: 4, truncated: true,
        dir: '/secret/path', subject: 'private' } })}\n`);
    expect(readGmailTriageLatest(runsDir)?.scope).toEqual({ source: 'local-eml-export', files: 6, limit: 4, truncated: true });
  });

  it('rejects a malformed scope on write instead of silently dropping the evidence', () => {
    expect(() => writeGmailTriageLatest(runsDir, { dir: '/x/mail', ...counts,
      scope: { source: 'gmail-api', files: 1, limit: 1, truncated: false } })).toThrow('scope is invalid');
    expect(existsSync(gmailTriageLatestPath(runsDir))).toBe(false);
    writeGmailTriageLatest(runsDir, { dir: '/x/mail', ...counts,
      scope: { source: 'local-eml-export', files: 3, limit: 100, truncated: false } });
    expect(readGmailTriageLatest(runsDir)?.scope).toEqual({ source: 'local-eml-export', files: 3, limit: 100, truncated: false });
  });
});
