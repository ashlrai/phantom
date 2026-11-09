import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetGmailTriage } from '../src/cli/fleet-gmail-triage.js';
import { gmailTriageLatestPath, readGmailTriageLatest } from '../src/core/comms/gmail-triage-latest.js';

let root: string, mailDir: string, runsDir: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'gmail-save-'));
  mailDir = join(root, 'mail'); runsDir = join(root, 'runs');
  mkdirSync(mailDir, { recursive: true });
  const subjects = ['Weekly digest alpha', 'Lunch plan bravo', 'Receipt charlie'];
  subjects.forEach((subject, i) => writeFileSync(join(mailDir, `m${i}.eml`),
    `From: Someone Sender${i} <someone${i}@example.test>\r\nTo: me@example.test\r\nSubject: ${subject}\r\nMessage-ID: <id${i}@example.test>\r\nDate: Mon, 09 Nov 2026 10:0${i}:00 +0000\r\n\r\nBody ${i}\r\n`));
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }); });

describe('fleet gmail-triage saves the latest result', () => {
  it('writes counts that match the report, with no mail content', async () => {
    expect(await cmdFleetGmailTriage(['--dir', mailDir, '--runs-dir', runsDir])).toBe(0);
    const latest = readGmailTriageLatest(runsDir);
    expect(latest).toMatchObject({ dir: 'mail', scanned: 3, unreadInSample: 3, target: 100, archiveCandidateCount: 0 });
    const text = readFileSync(gmailTriageLatestPath(runsDir), 'utf8');
    for (const secret of ['example.test', 'Sender', 'digest', 'Lunch', 'Receipt']) expect(text).not.toContain(secret);
  });

  it('--no-save leaves no file', async () => {
    expect(await cmdFleetGmailTriage(['--dir', mailDir, '--runs-dir', runsDir, '--no-save'])).toBe(0);
    expect(existsSync(gmailTriageLatestPath(runsDir))).toBe(false);
  });

  it('an unwritable runs dir still exits 0 and says so on stderr', async () => {
    const blocker = join(root, 'blocker');
    writeFileSync(blocker, 'file');
    expect(await cmdFleetGmailTriage(['--dir', mailDir, '--runs-dir', join(blocker, 'runs')])).toBe(0);
    expect(console.error).toHaveBeenCalledWith('Could not save the triage summary.');
  });
});
