import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { discoverBacklog } from '../src/core/improve/discover.js';
import {
  foldTeammateInboxCells,
  parseTeammateInboxEntry,
  parseTeammateInboxText,
  TEAMMATE_INBOX_BACKLOG_MAX_ITEMS,
  TEAMMATE_INBOX_MIN_DAYS,
  TEAMMATE_INBOX_MIN_ROWS,
  TEAMMATE_INBOX_STALE_MS,
  TEAMMATE_INBOX_WINDOW_MS,
  teammateInboxBacklogItems,
  type TeammateInboxMarkerRow,
  type TeammateInboxTextRow,
} from '../src/core/improve/teammate-inbox-backlog.js';
import { appendUserBacklogItems, readUserBacklogItems, validBacklogItem } from '../src/core/cloud/backlog.js';

let home: string;
let saved: { HOME?: string; ASHLR_HOME?: string; ASHLR_RUNS_DIR?: string };
beforeEach(() => {
  saved = { HOME: process.env.HOME, ASHLR_HOME: process.env.ASHLR_HOME, ASHLR_RUNS_DIR: process.env.ASHLR_RUNS_DIR };
  delete process.env.ASHLR_HOME;
  delete process.env.ASHLR_RUNS_DIR;
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'improve-teammate-')));
  process.env.HOME = home;
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  fs.rmSync(home, { recursive: true, force: true });
});

const NOW = new Date('2026-11-23T12:00:00Z');
const NOW_MS = NOW.getTime();
/** ISO timestamp `days` before NOW (fractional via `hours`, which may be negative). */
const at = (days: number, hours = 0): string =>
  new Date(NOW_MS - days * 86400_000 + hours * 3600_000).toISOString();

const REPO = 'ashlrai/phantom';
const SENDER = 'imessage:0123456789abcdef';
const DOT = 'imessage:e2e0809f8676fb7d';
const INSTINCT = 'imessage:f5228be7cfedb6cb';

// Intent fixtures under classifyTeammateIntent(text, true) — the responder's own classifier.
const REPLY = 'Could you check whether the queue drain finished last night and let me know what is still pending?';
const ACTIONABLE = 'Please review the auth module spec and send me your findings when you have them.';
const ACK = 'Handoff complete on my side — the refactor is ready for review, all local checks pass, and I am waiting on the merge decision before I touch anything else.';
const LEADER = 'Can you approve the production release when you get a chance?';
const IGNORE = 'thanks!';

interface JournalRow {
  v?: number;
  at?: string;
  rowid?: number;
  answered?: number;
  senderId?: string;
  text?: string;
}

let seq = 0;
/** One teammate text row under the writer's contract. */
const text = (body: string, daysAgo: number, sender: string = SENDER, hours = 0): JournalRow & { rowid: number } => ({
  v: 1, at: at(daysAgo, hours), rowid: ++seq, senderId: sender, text: body,
});
/** One answered marker under markTeammateTextsAnswered's contract. */
const marker = (rowid: number, daysAgo: number): JournalRow => ({ v: 1, answered: rowid, at: at(daysAgo) });

const journal = (rows: Array<JournalRow | string>): string =>
  rows.map((r) => (typeof r === 'string' ? r : JSON.stringify(r))).join('\n') + '\n';

const writeInbox = (rows: Array<JournalRow | string> | string): string => {
  const dir = path.join(home, '.ashlr-runs', 'imessage');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'teammates.jsonl');
  fs.writeFileSync(file, typeof rows === 'string' ? rows : journal(rows));
  return file;
};

const inboxRow = (over: Partial<TeammateInboxTextRow>): TeammateInboxTextRow => ({
  rowid: 1, atMs: NOW_MS - 3 * 86400_000, senderId: SENDER, text: REPLY, ...over,
});
const markerRow = (answeredRowid: number, atMs: number): TeammateInboxMarkerRow => ({ answeredRowid, atMs });

describe('parseTeammateInboxEntry / parseTeammateInboxText', () => {
  it('keeps contract text and marker rows and skips malformed or off-contract lines', () => {
    const t = text(REPLY, 3);
    const { texts, markers, invalidRows } = parseTeammateInboxText(journal([
      'not json',
      t,
      marker(t.rowid, 1),
      // off-contract rows:
      '{"rowid":9}',
      { v: 1, at: at(1), rowid: 0, senderId: SENDER, text: 'x' },
      { v: 1, at: at(1), rowid: 5, senderId: SENDER },
      { v: 1, at: 'not-a-date', rowid: 6, senderId: SENDER, text: 'x' },
      { v: 1, at: at(1), answered: 'three' },
      { v: 1, at: at(1), answered: 7, extra: 'tolerated' },
    ]));
    expect(invalidRows).toBe(6);
    expect(texts).toHaveLength(1);
    expect(markers).toHaveLength(2);
    expect(texts[0]!.rowid).toBe(t.rowid);
    expect(markers.map((m) => m.answeredRowid)).toEqual([t.rowid, 7]);
  });

  it('parseTeammateInboxEntry returns null for non-object and off-contract values', () => {
    expect(parseTeammateInboxEntry(null)).toBeNull();
    expect(parseTeammateInboxEntry('x')).toBeNull();
    expect(parseTeammateInboxEntry({ at: at(1) })).toBeNull();
    expect(parseTeammateInboxEntry({ at: at(1), answered: 4 })).not.toBeNull();
    expect(parseTeammateInboxEntry({ at: at(1), rowid: 4, senderId: SENDER, text: 'hi' })).not.toBeNull();
  });
});

describe('foldTeammateInboxCells', () => {
  it('counts stale unmarked auto-answer texts per intent and answered texts as delivered context', () => {
    const { cells, context } = foldTeammateInboxCells([
      inboxRow({ rowid: 1, text: REPLY, atMs: NOW_MS - 5 * 86400_000 }),
      inboxRow({ rowid: 2, text: REPLY, atMs: NOW_MS - 3 * 86400_000 }),
      inboxRow({ rowid: 3, text: REPLY, atMs: NOW_MS - 86400_000 }),
      inboxRow({ rowid: 4, text: ACTIONABLE, atMs: NOW_MS - 2 * 86400_000 }),
      inboxRow({ rowid: 5, text: ACTIONABLE, atMs: NOW_MS - 4 * 86400_000 }),
      inboxRow({ rowid: 6, text: ACTIONABLE, atMs: NOW_MS - 6 * 86400_000 }),
      inboxRow({ rowid: 7, text: ACTIONABLE, atMs: NOW_MS - 5 * 86400_000 }),
      inboxRow({ rowid: 8, text: ACK, atMs: NOW_MS - 2 * 86400_000 }),
    ], [
      markerRow(4, NOW_MS - 86400_000), // actionable row 4 answered — delivered context
      markerRow(8, NOW_MS - 86400_000), // ack row 8 answered — delivered context, rows 0 filtered
    ], NOW_MS);
    expect(context).toEqual({ leaderPending: 0, taskPeerTexts: 0 });
    expect(cells.map((c) => [c.intent, c.rows, c.days.size, c.answered])).toEqual([
      ['reply', 3, 3, 0],
      ['actionable', 3, 3, 1],
    ]);
  });

  it('excludes task-peer senders, leader and ignore intents, and fresh unmarked texts', () => {
    const { cells, context } = foldTeammateInboxCells([
      // Task-peer texts — envelope protocol, never cells.
      inboxRow({ rowid: 1, senderId: DOT, atMs: NOW_MS - 5 * 86400_000 }),
      inboxRow({ rowid: 2, senderId: DOT, atMs: NOW_MS - 4 * 86400_000 }),
      inboxRow({ rowid: 3, senderId: DOT, atMs: NOW_MS - 3 * 86400_000 }),
      inboxRow({ rowid: 4, senderId: INSTINCT, atMs: NOW_MS - 2 * 86400_000 }),
      // Leader texts — designed escalation to Mason.
      inboxRow({ rowid: 5, text: LEADER, atMs: NOW_MS - 5 * 86400_000 }),
      inboxRow({ rowid: 6, text: LEADER, atMs: NOW_MS - 4 * 86400_000 }),
      inboxRow({ rowid: 7, text: LEADER, atMs: NOW_MS - 3 * 86400_000 }),
      // Ignore texts — designed suppressions.
      inboxRow({ rowid: 8, text: IGNORE, atMs: NOW_MS - 5 * 86400_000 }),
      inboxRow({ rowid: 9, text: IGNORE, atMs: NOW_MS - 4 * 86400_000 }),
      inboxRow({ rowid: 10, text: IGNORE, atMs: NOW_MS - 3 * 86400_000 }),
      // Fresh reply texts — queue latency, not staleness.
      inboxRow({ rowid: 11, atMs: NOW_MS - 3600_000 }),
      inboxRow({ rowid: 12, atMs: NOW_MS - 7200_000 }),
      inboxRow({ rowid: 13, atMs: NOW_MS - TEAMMATE_INBOX_STALE_MS + 60_000 }),
    ], [], NOW_MS);
    expect(cells).toEqual([]);
    expect(context).toEqual({ leaderPending: 3, taskPeerTexts: 4 });
  });

  it('a marker only answers a text when its stamp is not before the text', () => {
    const { cells } = foldTeammateInboxCells([
      inboxRow({ rowid: 1, atMs: NOW_MS - 6 * 86400_000 }),
      inboxRow({ rowid: 2, atMs: NOW_MS - 5 * 86400_000 }),
      inboxRow({ rowid: 3, atMs: NOW_MS - 4 * 86400_000 }),
      inboxRow({ rowid: 4, atMs: NOW_MS - 3 * 86400_000 }),
      inboxRow({ rowid: 5, atMs: NOW_MS - 2 * 86400_000 }),
      inboxRow({ rowid: 6, atMs: NOW_MS - 86400_000 }),
      inboxRow({ rowid: 7, atMs: NOW_MS - 43200_000 }),
    ], [
      markerRow(1, NOW_MS - 7 * 86400_000), // before the text — does not answer
      markerRow(2, NOW_MS - 4 * 86400_000), // after — answers
      markerRow(3, NOW_MS - 3 * 86400_000), // after — answers
      markerRow(4, NOW_MS - 86400_000),     // after — answers
      markerRow(5, NOW_MS - 3600_000),      // after — answers
      markerRow(6, NOW_MS - 3600_000),      // after — answers
      // row 7 (12h old) stays unmarked but is fresh — never adverse.
    ], NOW_MS);
    // Unmarked stale rows: 1 only — under the bars.
    expect(cells).toEqual([]);
  });

  it('folds duplicate rowids once and windows on the text arrival stamp', () => {
    const { cells } = foldTeammateInboxCells([
      inboxRow({ rowid: 7, atMs: NOW_MS - 5 * 86400_000 }),
      inboxRow({ rowid: 7, atMs: NOW_MS - 4 * 86400_000 }), // duplicate — first wins
      inboxRow({ rowid: 8, atMs: NOW_MS - TEAMMATE_INBOX_WINDOW_MS - 1 }), // outside window
      inboxRow({ rowid: 9, atMs: NOW_MS + 2 * 3600_000 }),   // beyond future skew
      inboxRow({ rowid: 10, atMs: NOW_MS - 2 * 86400_000 }),
      inboxRow({ rowid: 11, atMs: NOW_MS - 3 * 86400_000 }),
      inboxRow({ rowid: 12, atMs: NOW_MS - 4 * 86400_000 }),
    ], [], NOW_MS);
    // Rows 7,10,11,12 are stale unmarked reply texts across 4 days → one recurring cell.
    expect(cells.map((c) => [c.intent, c.rows, c.days.size])).toEqual([['reply', 4, 4]]);
  });
});

describe('teammateInboxBacklogItems', () => {
  it('turns recurring stale-unanswered reply texts into a valid item', async () => {
    const answered = text(REPLY, 2);
    writeInbox([
      text(REPLY, 1), text(REPLY, 3), text(REPLY, 5),
      answered, marker(answered.rowid, 1), // delivered context, not adverse
    ]);
    const items = await teammateInboxBacklogItems({ repo: REPO, now: NOW });
    expect(items).toHaveLength(1);
    const item = items[0]!;
    expect(validBacklogItem(item)).not.toBeNull();
    expect(item).toMatchObject({ priority: 3, repo: REPO, area: 'teammate-inbox' });
    expect(item.id).toMatch(/^teaminbox-[0-9a-f]{16}$/);
    expect(item.title).toContain("'reply'");
    expect(item.title).toContain('unanswered');
    expect(item.prompt).toContain('teammates.jsonl');
    expect(item.prompt).toContain("3 'reply' text(s)");
    expect(item.prompt).toContain('distinct UTC day(s)');
    expect(item.prompt).toContain('answered markers');
    expect(item.prompt).toContain('no-change');
    expect(item.prompt).toContain('teammate-status.json');
  });

  it('emits per-intent items for reply and actionable cells', async () => {
    writeInbox([
      text(REPLY, 1), text(REPLY, 3), text(REPLY, 5),
      text(ACTIONABLE, 1), text(ACTIONABLE, 3), text(ACTIONABLE, 5),
      text(ACK, 2), text(ACK, 4), // under the bars — one intent needs 3 rows
    ]);
    const items = await teammateInboxBacklogItems({ repo: REPO, now: NOW });
    expect(items).toHaveLength(2);
    const prompts = items.map((i) => i.prompt).join('\n');
    expect(prompts).toContain("'reply' texts staying unanswered");
    expect(prompts).toContain("'actionable' texts staying unanswered");
    expect(items.every((i) => validBacklogItem(i) !== null)).toBe(true);
  });

  it('emits nothing below the recurring bars of rows and distinct days', async () => {
    // Three stale rows but a single UTC day (all on Nov 22, ages 25h/29h/34h) — under the days bar.
    const oneDay = writeInbox([text(REPLY, 1, SENDER, -1), text(REPLY, 1, SENDER, -5), text(REPLY, 1, SENDER, -10)]);
    expect(await teammateInboxBacklogItems({ repo: REPO, teammatesPath: oneDay, now: NOW })).toEqual([]);
    // Two rows across two days — under the rows bar.
    const twoRows = writeInbox([text(REPLY, 1), text(REPLY, 3)]);
    expect(await teammateInboxBacklogItems({ repo: REPO, teammatesPath: twoRows, now: NOW })).toEqual([]);
    expect(TEAMMATE_INBOX_MIN_ROWS).toBe(3);
    expect(TEAMMATE_INBOX_MIN_DAYS).toBe(2);
    expect(TEAMMATE_INBOX_STALE_MS).toBe(24 * 60 * 60 * 1000);
    expect(TEAMMATE_INBOX_WINDOW_MS).toBe(7 * 24 * 60 * 60 * 1000);
  });

  it('emits nothing for fresh unmarked texts — queue latency is not staleness', async () => {
    writeInbox([text(REPLY, 0, SENDER, -1), text(REPLY, 0, SENDER, -5), text(REPLY, 0, SENDER, -12)]);
    expect(await teammateInboxBacklogItems({ repo: REPO, now: NOW })).toEqual([]);
  });

  it('yields nothing for a missing or malformed journal', async () => {
    expect(await teammateInboxBacklogItems({ repo: REPO, teammatesPath: path.join(home, 'no-such.jsonl'), now: NOW })).toEqual([]);
    const file = writeInbox(['not json', '{"rowid":9}', text(REPLY, 1), text(REPLY, 3)]);
    expect(await teammateInboxBacklogItems({ repo: REPO, teammatesPath: file, now: NOW })).toEqual([]);
    expect(await teammateInboxBacklogItems({ repo: '', teammatesPath: file, now: NOW })).toEqual([]);
    expect(await teammateInboxBacklogItems({ repo: 'not-a-repo', teammatesPath: file, now: NOW })).toEqual([]);
  });

  it('emits nothing for another repository', async () => {
    const file = writeInbox([text(REPLY, 1), text(REPLY, 3), text(REPLY, 5)]);
    expect(await teammateInboxBacklogItems({ repo: 'ashlrai/other', teammatesPath: file, now: NOW })).toEqual([]);
    expect(await teammateInboxBacklogItems({ repo: 'AshlrAI/Phantom', teammatesPath: file, now: NOW })).toHaveLength(1);
  });

  it('designed holds never emit: leader escalation, task peers, ignores and answered texts', async () => {
    const leaders = [text(LEADER, 1), text(LEADER, 3), text(LEADER, 5)];
    const peers = [text(REPLY, 1, DOT), text(REPLY, 3, DOT), text(REPLY, 5, INSTINCT)];
    const ignores = [text(IGNORE, 1), text(IGNORE, 3), text(IGNORE, 5)];
    const replies = [text(REPLY, 1), text(REPLY, 3), text(REPLY, 5)];
    writeInbox([
      ...leaders, ...peers, ...ignores, ...replies,
      marker(replies[0]!.rowid, 1), marker(replies[1]!.rowid, 2), marker(replies[2]!.rowid, 3),
    ]);
    // The three plain REPLY texts are answered; leaders, peers and ignores are designed holds.
    expect(await teammateInboxBacklogItems({ repo: REPO, now: NOW })).toEqual([]);
  });

  it('states truncation as a lower bound in the prompt', async () => {
    const file = writeInbox([text(REPLY, 1), text(REPLY, 3), text(REPLY, 5)]);
    // Pad the journal past the 8 MiB tail so the read reports truncated.
    fs.writeFileSync(file, 'x'.repeat(9 * 1024 * 1024) + '\n' + fs.readFileSync(file, 'utf8'));
    const items = await teammateInboxBacklogItems({ repo: REPO, teammatesPath: file, now: NOW });
    expect(items.length).toBeGreaterThan(0);
    for (const item of items) expect(item.prompt).toContain('lower bound');
  });

  it('derives stable ids so a refresh re-adds nothing', async () => {
    const rows = [text(REPLY, 1), text(REPLY, 3), text(REPLY, 5)];
    const file = writeInbox(rows);
    const first = await teammateInboxBacklogItems({ repo: REPO, teammatesPath: file, now: NOW });
    const second = await teammateInboxBacklogItems({ repo: REPO, teammatesPath: file, now: NOW });
    expect(first.length).toBeGreaterThan(0);
    expect(second.map((i) => i.id)).toEqual(first.map((i) => i.id));
    const grown = writeInbox([...rows, text(REPLY, 6)]);
    const third = await teammateInboxBacklogItems({ repo: REPO, teammatesPath: grown, now: NOW });
    expect(third.map((i) => i.id)).toEqual(first.map((i) => i.id));
    expect(first.length).toBeLessThanOrEqual(TEAMMATE_INBOX_BACKLOG_MAX_ITEMS);
  });

  it('appends teammate-inbox items through discovery and dedupes on refresh', async () => {
    const now = Date.now();
    writeInbox([1, 3, 5].map((days) => ({
      v: 1, at: new Date(now - days * 86400_000).toISOString(), rowid: days * 10 + 1, senderId: SENDER, text: REPLY,
    })));
    const greenGh = async (args: string[]) => {
      const p = args[4] ?? '';
      if (p === 'repos/ashlrai/phantom') return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n{"default_branch":"master"}', stderr: '' };
      return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n[]', stderr: '' };
    };
    const first = await discoverBacklog(REPO, { gh: greenGh });
    const inboxItems = first.items.filter((i) => i.id.startsWith('teaminbox-'));
    expect(inboxItems).toHaveLength(1);
    expect(first.items.every((i) => validBacklogItem(i) !== null)).toBe(true);
    expect(appendUserBacklogItems(inboxItems)).toBe(inboxItems.length);
    const second = await discoverBacklog(REPO, { gh: greenGh });
    expect(appendUserBacklogItems(second.items.filter((i) => i.id.startsWith('teaminbox-')))).toBe(0);
    expect(readUserBacklogItems().filter((i) => i.id.startsWith('teaminbox-'))).toHaveLength(inboxItems.length);
  });
});
