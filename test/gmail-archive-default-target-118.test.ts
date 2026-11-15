import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetGmailArchivePlan } from '../src/cli/fleet-gmail-archive-plan.js';
import { cmdFleetGmailTriage } from '../src/cli/fleet-gmail-triage.js';
import {
  EML_INBOX_READ_DEFAULT, EML_INBOX_READ_MAX, readEmlInbox, readEmlInboxDetailed,
} from '../src/core/comms/gmail-eml-adapter.js';
import { readGmailArchivePlanLatest } from '../src/core/comms/gmail-archive-plan-latest.js';

const dirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface Spec { id: string; update: boolean }
/** Writes `total` synthetic .eml files; ascending index = ascending mtime = older message. */
function seed(dir: string, total: number, personalAt: ReadonlySet<number>, prefix: string): Spec[] {
  mkdirSync(dir, { recursive: true });
  const specs: Spec[] = [];
  for (let i = 0; i < total; i++) {
    const update = !personalAt.has(i);
    const id = `${prefix}-${i}@example.test`;
    const sender = update ? (i % 2 ? 'newsletter@news.test' : 'digest@updates.test') : 'pat@people.test';
    const bytes = Buffer.from(`From: ${sender}\nMessage-ID: <${id}>\nSubject: Note ${i}\n\n${update ? `Bulletin ${i}.` : 'Can you look at this?'}\n`);
    const path = join(dir, `message-${String(i).padStart(4, '0')}.eml`);
    writeFileSync(path, bytes);
    utimesSync(path, i + 1, i + 1);
    specs.push({ id, update });
  }
  return specs;
}
const updateIds = (specs: Spec[]): string[] => specs.filter(s => s.update).map(s => s.id);

function snapshot(dir: string): Map<string, Buffer> {
  const snap = new Map<string, Buffer>();
  for (const name of readdirSync(dir)) snap.set(name, readFileSync(join(dir, name)));
  return snap;
}
function expectIntact(dir: string, snap: Map<string, Buffer>): void {
  expect(readdirSync(dir).sort()).toEqual([...snap.keys()].sort());
  for (const [name, bytes] of snap) expect(readFileSync(join(dir, name))).toEqual(bytes);
}

type CliJson = {
  schema: string;
  archivePlan: { unread: number; target: number; archiveCandidates: string[] };
  topSenders: { sender: string; count: number }[];
  scope: { source: string; scanned: number; files: number; limit: number; truncated: boolean; unreadRepresentsLiveTotal: boolean };
};

let log: ReturnType<typeof vi.spyOn>;
let err: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  log = vi.spyOn(console, 'log').mockImplementation(() => {});
  err = vi.spyOn(console, 'error').mockImplementation(() => {});
});
async function run(args: string[]): Promise<{ code: number; logs: string[]; errors: string[] }> {
  log.mockClear(); err.mockClear();
  const code = await cmdFleetGmailArchivePlan(args);
  return { code, logs: log.mock.calls.map(c => String(c[0])), errors: err.mock.calls.map(c => String(c[0])) };
}

describe('fleet gmail-archive-plan at the default target', () => {
  it('proposes the oldest excess updates over 100 for both inboxes', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gmail-arch-118-')); dirs.push(root);
    const runsDir = join(root, 'runs');
    const workDir = join(root, 'work');
    const homeDir = join(root, 'home');
    const work = seed(workDir, 124, new Set([10, 60, 90, 123]), 'work');
    const home = seed(homeDir, 106, new Set([0]), 'home');
    // A byte-identical second copy of the oldest message dedupes but still counts as a file.
    writeFileSync(join(workDir, 'zz-copy.eml'), readFileSync(join(workDir, 'message-0000.eml')));
    utimesSync(join(workDir, 'zz-copy.eml'), 0, 0);
    const snaps = new Map([[workDir, snapshot(workDir)], [homeDir, snapshot(homeDir)]]);

    const w = await run(['--dir', workDir, '--inbox', 'work', '--runs-dir', runsDir, '--json']);
    expect(w.code).toBe(0);
    expect(w.errors).toEqual([]);
    const wj = JSON.parse(w.logs[0]!) as CliJson;
    expect(wj.schema).toBe('fleet.gmail-archive-plan.v1');
    expect(wj.archivePlan.unread).toBe(124);
    expect(wj.archivePlan.target).toBe(100);
    expect(wj.archivePlan.archiveCandidates).toEqual(updateIds(work).slice(0, 24));
    const personals = new Set(work.filter(s => !s.update).map(s => s.id));
    for (const id of wj.archivePlan.archiveCandidates) expect(personals.has(id)).toBe(false);
    expect(wj.scope).toEqual({ source: 'local-eml-export', scanned: 124, files: 125,
      limit: EML_INBOX_READ_MAX, truncated: false, unreadRepresentsLiveTotal: false });

    const h = await run(['--dir', homeDir, '--inbox', 'home', '--runs-dir', runsDir, '--json']);
    expect(h.code).toBe(0);
    const hj = JSON.parse(h.logs[0]!) as CliJson;
    // The single personal message is the oldest file and is still excluded.
    expect(hj.archivePlan.archiveCandidates).toEqual(updateIds(home).slice(0, 6));

    const saved = readGmailArchivePlanLatest(runsDir);
    expect(saved?.plans.map(p => p.inbox).sort()).toEqual(['home', 'work']);
    expect(saved?.plans.find(p => p.inbox === 'work')).toMatchObject({ unread: 124, target: 100, archiveCount: 24 });
    expect(saved?.plans.find(p => p.inbox === 'home')).toMatchObject({ unread: 106, target: 100, archiveCount: 6 });

    // Triage callers keep the 100-message default on the same export.
    expect(readEmlInbox(workDir)).toHaveLength(EML_INBOX_READ_DEFAULT);

    for (const [dir, snap] of snaps) expectIntact(dir, snap);
  });

  it('bounds the sweep at --scan and reports a truncated scope honestly', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gmail-arch-cap-')); dirs.push(root);
    const dir = join(root, 'inbox');
    seed(dir, 8, new Set(), 'cap');
    const snap = snapshot(dir);

    const detailed = readEmlInboxDetailed(dir, { limit: 3 });
    expect(detailed.messages.map(m => m.id)).toEqual(['cap-7@example.test', 'cap-6@example.test', 'cap-5@example.test']);
    expect(detailed.scope).toEqual({ limit: 3, files: 8, truncated: true });
    // The documented finite cap clamps any requested limit.
    expect(readEmlInboxDetailed(dir, { limit: 999999 }).scope).toEqual({ limit: EML_INBOX_READ_MAX, files: 8, truncated: false });
    expect(readEmlInboxDetailed(dir, { limit: 0 }).scope.limit).toBe(1);

    const runsDir = join(root, 'runs');
    const r = await run(['--dir', dir, '--inbox', 'capped', '--scan', '5', '--target', '2', '--runs-dir', runsDir, '--json']);
    expect(r.code).toBe(0);
    const j = JSON.parse(r.logs[0]!) as CliJson;
    expect(j.scope).toEqual({ source: 'local-eml-export', scanned: 5, files: 8,
      limit: 5, truncated: true, unreadRepresentsLiveTotal: false });
    // Candidates are the oldest messages inside the scanned window, not the whole export.
    expect(j.archivePlan.archiveCandidates).toEqual(['cap-3@example.test', 'cap-4@example.test', 'cap-5@example.test']);

    const human = await run(['--dir', dir, '--scan', '5', '--target', '2', '--runs-dir', runsDir, '--no-save']);
    expect(human.code).toBe(0);
    expect(human.logs[0]).toBe('Would archive 3 of 5 scanned messages (target 2). Archive only, nothing is deleted.');
    expect(human.logs).toContain("Only the newest 5 of 8 saved messages were scanned; this sample is not the live inbox's unread total.");

    expect((await run(['--dir', dir, '--scan', 'bogus'])).code).toBe(2);
    expectIntact(dir, snap);
  });

  it('keeps the 100-message triage default for existing callers', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gmail-arch-triage-')); dirs.push(root);
    const dir = join(root, 'triage');
    seed(dir, 130, new Set(), 'tri');
    const snap = snapshot(dir);

    log.mockClear(); err.mockClear();
    expect(await cmdFleetGmailTriage(['--dir', dir, '--runs-dir', join(root, 'runs'), '--json'])).toBe(0);
    const out = JSON.parse(String(log.mock.calls.at(-1)![0])) as { report: { scanned: number }; archivePlan: unknown };
    expect(out.report.scanned).toBe(EML_INBOX_READ_DEFAULT);
    expect(out.archivePlan).toEqual({ unread: EML_INBOX_READ_DEFAULT, target: 100, archiveCandidates: [] });

    expectIntact(dir, snap);
  });
});
