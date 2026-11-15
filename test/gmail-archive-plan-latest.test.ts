import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetGmailArchivePlan } from '../src/cli/fleet-gmail-archive-plan.js';
import {
  GMAIL_ARCHIVE_PLAN_LATEST_SCHEMA, gmailArchivePlanLatestPath, readGmailArchivePlanLatest, writeGmailArchivePlanLatest,
} from '../src/core/comms/gmail-archive-plan-latest.js';

let runsDir: string;
beforeEach(() => { runsDir = mkdtempSync(join(tmpdir(), 'archive-plan-')); });
afterEach(() => { vi.restoreAllMocks(); rmSync(runsDir, { recursive: true, force: true }); });

const base = { inbox: 'inbox-a', unread: 140, target: 100, archiveCount: 40, topSenders: [{ sender: 'sender@example.com', count: 25 }] };

describe('gmail archive plan latest', () => {
  it('round trips and keeps one entry per inbox', () => {
    expect(readGmailArchivePlanLatest(runsDir)).toBeNull();
    writeGmailArchivePlanLatest(runsDir, { ...base, now: () => new Date('2026-11-09T10:00:00Z') });
    writeGmailArchivePlanLatest(runsDir, { ...base, inbox: 'inbox-b', unread: 90, archiveCount: 0, topSenders: [] });
    writeGmailArchivePlanLatest(runsDir, { ...base, archiveCount: 41 });
    const latest = readGmailArchivePlanLatest(runsDir)!;
    expect(latest.schema).toBe(GMAIL_ARCHIVE_PLAN_LATEST_SCHEMA);
    expect(latest.plans.map(p => [p.inbox, p.archiveCount])).toEqual([['inbox-a', 41], ['inbox-b', 0]]);
  });

  it('reads corrupt, unknown or malformed files as null', () => {
    const path = gmailArchivePlanLatestPath(runsDir);
    mkdirSync(dirname(path), { recursive: true });
    for (const text of ['{not json', '[]', JSON.stringify({ schema: 'other', plans: [] }),
      JSON.stringify({ schema: GMAIL_ARCHIVE_PLAN_LATEST_SCHEMA, plans: [{ ...base, at: 'x', unread: -1 }] })]) {
      writeFileSync(path, text);
      expect(readGmailArchivePlanLatest(runsDir)).toBeNull();
    }
  });

  it('leaves no partial or temp file when the write fails', () => {
    writeGmailArchivePlanLatest(runsDir, base);
    const path = gmailArchivePlanLatestPath(runsDir);
    const before = readGmailArchivePlanLatest(runsDir);
    // A non-empty directory at the target makes the final rename fail.
    rmSync(path);
    mkdirSync(join(path, 'blocker'), { recursive: true });
    expect(() => writeGmailArchivePlanLatest(runsDir, { ...base, archiveCount: 1 })).toThrow();
    expect(readdirSync(dirname(path))).toEqual(['gmail-archive-plan-latest.json']);
    rmSync(path, { recursive: true });
    expect(existsSync(path)).toBe(false);
    expect(before?.plans).toHaveLength(1);
  });

  it('leaves the old file intact when the directory is not writable', () => {
    writeGmailArchivePlanLatest(runsDir, base);
    const dir = dirname(gmailArchivePlanLatestPath(runsDir));
    chmodSync(dir, 0o500);
    try {
      if (process.getuid?.() !== 0) expect(() => writeGmailArchivePlanLatest(runsDir, { ...base, archiveCount: 2 })).toThrow();
    } finally { chmodSync(dir, 0o700); }
    expect(readGmailArchivePlanLatest(runsDir)?.plans[0]?.archiveCount).toBe(40);
    expect(readdirSync(dir)).toEqual(['gmail-archive-plan-latest.json']);
  });
});

describe('ashlr fleet gmail-archive-plan', () => {
  it('saves the plan with top senders and moves nothing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'archive-eml-'));
    try {
      for (const [i, from] of ['News <noreply@example.com>', 'noreply@example.com', 'newsletter@example.com', 'digest@example.com', 'Pat <pat@example.com>'].entries()) {
        writeFileSync(join(dir, `m${i}.eml`), `From: ${from}\nMessage-ID: <m${i}@example.com>\nSubject: Hi\n\nHello`);
      }
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      expect(await cmdFleetGmailArchivePlan(['--dir', dir, '--inbox', 'inbox-a', '--target', '1', '--runs-dir', runsDir])).toBe(0);
      expect(String(log.mock.calls[0]![0])).toContain('nothing is deleted');
      const plan = readGmailArchivePlanLatest(runsDir)!.plans[0]!;
      expect(plan).toMatchObject({ inbox: 'inbox-a', unread: 5, target: 1, archiveCount: 4,
        topSenders: [{ sender: 'noreply@example.com', count: 2 }, { sender: 'digest@example.com', count: 1 }, { sender: 'newsletter@example.com', count: 1 }] });
      expect(readdirSync(dir)).toHaveLength(5);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('rejects a missing directory', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await cmdFleetGmailArchivePlan([])).toBe(2);
    expect(await cmdFleetGmailArchivePlan(['--dir', '/nonexistent/archive-folder'])).toBe(2);
  });
});
