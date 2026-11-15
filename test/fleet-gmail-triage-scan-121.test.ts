import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetGmailTriage } from '../src/cli/fleet-gmail-triage.js';
import { EML_INBOX_READ_MAX } from '../src/core/comms/gmail-eml-adapter.js';
import { gmailTriageLatestPath, readGmailTriageLatest } from '../src/core/comms/gmail-triage-latest.js';

let root: string, mailDir: string, runsDir: string;

/** 160 synthetic exports, oldest index = oldest mtime. Indices 0-9 review, 10-154 update,
 * 155 and 158 reply (Auto-Submitted: no), the rest update. */
function seed(total: number): void {
  mkdirSync(mailDir, { recursive: true });
  for (let i = 0; i < total; i++) {
    const reply = i === 155 || i === 158;
    const review = i < 10;
    const sender = reply ? 'pat@people.test' : review ? 'sam@people.test' : 'newsletter@news.test';
    const subject = reply ? `Question ${i}?` : review ? `Note ${i}` : `Bulletin ${i}`;
    const body = reply ? 'Can you reply?' : review ? 'Hello' : `Bulletin ${i}.`;
    const auto = reply ? 'Auto-Submitted: no\n' : '';
    writeFileSync(join(mailDir, `message-${String(i).padStart(4, '0')}.eml`),
      `From: ${sender}\nMessage-ID: <m-${i}@example.test>\nSubject: ${subject}\n${auto}\n${body}\n`);
    utimesSync(join(mailDir, `message-${String(i).padStart(4, '0')}.eml`), i + 1, i + 1);
  }
}

function snapshot(dir: string): Map<string, Buffer> {
  const snap = new Map<string, Buffer>();
  for (const name of readdirSync(dir)) snap.set(name, readFileSync(join(dir, name)));
  return snap;
}
function expectIntact(dir: string, snap: Map<string, Buffer>): void {
  expect(readdirSync(dir).sort()).toEqual([...snap.keys()].sort());
  for (const [name, bytes] of snap) expect(readFileSync(join(dir, name))).toEqual(bytes);
}

type Out = {
  schema: string;
  scope: { source: string; scanned: number; files: number; limit: number; truncated: boolean; unreadRepresentsLiveTotal: boolean };
  report: { scanned: number; updates: string[]; drafted: number; review: number; failed: number };
  archivePlan: { unread: number; target: number; archiveCandidates: string[] };
  persistence: string;
};

let log: ReturnType<typeof vi.spyOn>;
let err: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'gmail-triage-scan-'));
  mailDir = join(root, 'mail'); runsDir = join(root, 'runs');
  seed(160);
  log = vi.spyOn(console, 'log').mockImplementation(() => {});
  err = vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

async function run(args: string[]): Promise<{ code: number; out: Out | null; logs: string[]; errors: string[] }> {
  log.mockClear(); err.mockClear();
  const code = await cmdFleetGmailTriage(args);
  const logs = log.mock.calls.map(c => String(c[0]));
  const json = logs.filter(l => l.startsWith('{')).at(-1);
  return { code, out: json ? JSON.parse(json) as Out : null, logs, errors: err.mock.calls.map(c => String(c[0])) };
}

describe('fleet gmail-triage --scan/--target', () => {
  it('scans past 100 and plans against the wider window with honest scope', async () => {
    const snap = snapshot(mailDir);
    const r = await run(['--dir', mailDir, '--scan', '150', '--target', '100', '--runs-dir', runsDir, '--json']);
    expect(r.code).toBe(0);
    expect(r.errors).toEqual([]);
    const out = r.out!;
    expect(out.schema).toBe('fleet.gmail-triage.v1');
    expect(out.scope).toEqual({ source: 'local-eml-export', scanned: 150, files: 160,
      limit: 150, truncated: true, unreadRepresentsLiveTotal: false });
    // Two bridge batches (100 + 50) cover the same selected messages; drafts dedupe per message.
    expect(out.report).toMatchObject({ scanned: 150, drafted: 2, review: 0, failed: 0 });
    expect(out.report.updates).toHaveLength(148);
    expect(out.archivePlan.unread).toBe(150);
    expect(out.archivePlan.target).toBe(100);
    // Oldest 50 updates inside the scanned window (indices 10-59); replies are never candidates.
    expect(out.archivePlan.archiveCandidates).toEqual(
      Array.from({ length: 50 }, (_, k) => `m-${10 + k}@example.test`));
    expect(out.persistence).toBe('saved');
    expect(readGmailTriageLatest(runsDir)).toMatchObject({ scanned: 150, unreadInSample: 150, target: 100, archiveCandidateCount: 50 });
    // Local drafts only; the export itself is untouched.
    expectIntact(mailDir, snap);
  });

  it('keeps the 100-message default scan and target for existing callers', async () => {
    const r = await run(['--dir', mailDir, '--runs-dir', runsDir, '--json', '--no-save']);
    expect(r.code).toBe(0);
    const out = r.out!;
    expect(out.scope).toEqual({ source: 'local-eml-export', scanned: 100, files: 160,
      limit: 100, truncated: true, unreadRepresentsLiveTotal: false });
    expect(out.report.scanned).toBe(100);
    expect(out.archivePlan).toEqual({ unread: 100, target: 100, archiveCandidates: [] });
    expect(out.persistence).toBe('skipped');
  });

  it('--target 0 makes every scanned update an archive candidate', async () => {
    const r = await run(['--dir', mailDir, '--scan', '150', '--target', '0', '--runs-dir', runsDir, '--json', '--no-save']);
    expect(r.code).toBe(0);
    expect(r.out!.archivePlan.target).toBe(0);
    expect(r.out!.archivePlan.archiveCandidates).toHaveLength(148);
    expect(r.out!.archivePlan.archiveCandidates[0]).toBe('m-10@example.test');
    expect(r.out!.archivePlan.archiveCandidates.at(-1)).toBe('m-159@example.test');
  });

  it('clamps --scan to the reader maximum and reports the full export when it fits', async () => {
    const r = await run(['--dir', mailDir, '--scan', '5000', '--runs-dir', runsDir, '--json', '--no-save']);
    expect(r.code).toBe(0);
    expect(r.out!.scope).toEqual({ source: 'local-eml-export', scanned: 160, files: 160,
      limit: EML_INBOX_READ_MAX, truncated: false, unreadRepresentsLiveTotal: false });
  });

  it('human output states the truncated scope and the sample-only caveat', async () => {
    const r = await run(['--dir', mailDir, '--scan', '150', '--target', '100', '--runs-dir', runsDir, '--no-save']);
    expect(r.code).toBe(0);
    expect(r.logs[0]).toContain('150 messages from 160 exported files');
    expect(r.logs[0]).toContain('truncated: more files remain unexamined');
    expect(r.logs[0]).toContain('not the live inbox');
    expect(r.logs.join('\n')).toContain('Archive candidates: 50');
  });

  it('rejects malformed, negative, non-finite and missing values before any bridge or persistence write', async () => {
    const bad: string[][] = [
      ['--scan', 'abc'], ['--scan', '-3'], ['--scan', '1.5'], ['--scan', 'Infinity'],
      ['--scan', '12x'], ['--scan'], ['--scan', '--json'],
      ['--target', 'abc'], ['--target', '-1'], ['--target', '2.5'], ['--target'],
      ['--dir', mailDir, '--scan', '150', '--target', '1e3'],
    ];
    let errorCalls = 0;
    for (const extra of bad) {
      const r = await run(['--dir', mailDir, '--runs-dir', runsDir, '--json', '--no-save', ...extra]);
      expect(r.code, JSON.stringify(extra)).toBe(2);
      expect(r.out).toBeNull();
      expect(r.errors.length, JSON.stringify(extra)).toBeGreaterThan(0);
      errorCalls += r.errors.length;
    }
    // Argument errors happen before the bridge runs: no drafts, no saved latest record.
    expect(existsSync(join(runsDir, 'drafts', 'drafts.jsonl'))).toBe(false);
    expect(existsSync(gmailTriageLatestPath(runsDir))).toBe(false);
    expect(errorCalls).toBeGreaterThanOrEqual(bad.length);
  });
});
