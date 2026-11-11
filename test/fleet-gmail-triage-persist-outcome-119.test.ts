import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetGmailTriage } from '../src/cli/fleet-gmail-triage.js';
import { gmailTriageLatestPath, readGmailTriageLatest } from '../src/core/comms/gmail-triage-latest.js';

let root: string, mailDir: string, runsDir: string;

function writeMail(): void {
  writeFileSync(join(mailDir, 'update.eml'),
    'From: newsletter@example.test\r\nTo: me@example.test\r\nSubject: Weekly digest\r\nMessage-ID: <u@example.test>\r\nDate: Mon, 09 Nov 2026 10:00:00 +0000\r\nList-Unsubscribe: <mailto:u@example.test>\r\n\r\nBody\r\n');
  writeFileSync(join(mailDir, 'reply.eml'),
    'From: pat@example.test\r\nTo: me@example.test\r\nSubject: Question?\r\nMessage-ID: <r@example.test>\r\nDate: Mon, 09 Nov 2026 10:01:00 +0000\r\nAuto-Submitted: no\r\n\r\nCan you reply?\r\n');
  writeFileSync(join(mailDir, 'review.eml'),
    'From: sam@example.test\r\nTo: me@example.test\r\nSubject: Note\r\nMessage-ID: <n@example.test>\r\nDate: Mon, 09 Nov 2026 10:02:00 +0000\r\n\r\nHello\r\n');
}

/** Deterministic cross-platform unwritable destination: a regular file where the comms dir must be. */
function blockCommsDir(): void {
  writeFileSync(join(runsDir, 'comms'), 'not a directory');
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'gmail-persist-'));
  mailDir = join(root, 'mail'); runsDir = join(root, 'runs');
  mkdirSync(mailDir, { recursive: true });
  writeMail();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }); });

function lastJson() {
  const calls = vi.mocked(console.log).mock.calls;
  return JSON.parse(String(calls[calls.length - 1]![0]));
}

describe('fleet gmail-triage persistence outcome', () => {
  it('successful save exits 0, reports persistence saved and round-trips the latest record', async () => {
    expect(await cmdFleetGmailTriage(['--dir', mailDir, '--runs-dir', runsDir, '--json'])).toBe(0);
    const out = lastJson();
    expect(out.schema).toBe('fleet.gmail-triage.v1');
    expect(out.persistence).toBe('saved');
    expect(out.report).toMatchObject({ scanned: 3, drafted: 1, review: 1, failed: 0 });
    expect(out.report.updates).toHaveLength(1);
    expect(out.archivePlan).toMatchObject({ unread: 3, target: 100 });
    expect(readGmailTriageLatest(runsDir)).toMatchObject({ dir: 'mail', scanned: 3, updates: 1, drafted: 1, review: 1, unreadInSample: 3, archiveCandidateCount: 0 });
  });

  it('failed save exits nonzero, keeps parseable JSON with the full report and marks persistence failed', async () => {
    mkdirSync(runsDir, { recursive: true });
    blockCommsDir();
    expect(await cmdFleetGmailTriage(['--dir', mailDir, '--runs-dir', runsDir, '--json'])).toBe(1);
    const out = lastJson();
    expect(out.persistence).toBe('failed');
    expect(out.report).toMatchObject({ scanned: 3, drafted: 1, review: 1, failed: 0 });
    expect(out.report.updates).toHaveLength(1);
    expect(out.archivePlan).toMatchObject({ unread: 3, target: 100 });
    expect(readGmailTriageLatest(runsDir)).toBeNull();
    // The stderr notice must not leak the raw exception, paths or mail content.
    const errText = vi.mocked(console.error).mock.calls.map(c => String(c[0])).join('\n');
    expect(errText).toContain('shared latest result was not updated');
    for (const leak of ['ENOENT', 'ENOTDIR', 'EEXIST', runsDir, mailDir, 'example.test', 'digest', 'Question']) {
      expect(errText).not.toContain(leak);
    }
    // Computation ran once: exactly one draft was created, no retry duplicates.
    const drafts = readFileSync(join(runsDir, 'drafts', 'drafts.jsonl'), 'utf8').trim().split('\n');
    expect(drafts).toHaveLength(1);
  });

  it('human output on failed save still prints the report and clearly says the shared result was not updated', async () => {
    mkdirSync(runsDir, { recursive: true });
    blockCommsDir();
    expect(await cmdFleetGmailTriage(['--dir', mailDir, '--runs-dir', runsDir])).toBe(1);
    const out = vi.mocked(console.log).mock.calls.map(c => String(c[0])).join('\n');
    expect(out).toContain('Scanned: 3');
    expect(out).toContain('drafted: 1');
    expect(out).toContain('Archive candidates: 0');
    expect(vi.mocked(console.error)).toHaveBeenCalledWith('Could not save the triage summary; the shared latest result was not updated.');
    expect(existsSync(gmailTriageLatestPath(runsDir))).toBe(false);
  });

  it('--no-save on the same unusable destination stays a successful computation-only run', async () => {
    mkdirSync(runsDir, { recursive: true });
    blockCommsDir();
    expect(await cmdFleetGmailTriage(['--dir', mailDir, '--runs-dir', runsDir, '--json', '--no-save'])).toBe(0);
    expect(lastJson().persistence).toBe('skipped');
    expect(lastJson().report).toMatchObject({ scanned: 3, drafted: 1 });
    expect(console.error).not.toHaveBeenCalled();
  });

  it('a failed save leaves bytes already occupying the destination untouched', async () => {
    mkdirSync(join(runsDir, 'comms'), { recursive: true });
    mkdirSync(gmailTriageLatestPath(runsDir));
    const sentinel = join(gmailTriageLatestPath(runsDir), 'keep.txt');
    writeFileSync(sentinel, 'prior bytes');
    expect(await cmdFleetGmailTriage(['--dir', mailDir, '--runs-dir', runsDir, '--json'])).toBe(1);
    expect(lastJson().persistence).toBe('failed');
    expect(readFileSync(sentinel, 'utf8')).toBe('prior bytes');
    expect(readGmailTriageLatest(runsDir)).toBeNull();
  });
});
