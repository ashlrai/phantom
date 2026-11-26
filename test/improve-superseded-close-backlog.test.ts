import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { discoverBacklog } from '../src/core/improve/discover.js';
import {
  foldSupersededCloseRows,
  parseSupersededCloseJournal,
  supersededCloseBacklogItems,
} from '../src/core/improve/superseded-close-backlog.js';
import { appendUserBacklogItems, readUserBacklogItems, validBacklogItem } from '../src/core/cloud/backlog.js';

let home: string;
let saved: { HOME?: string; ASHLR_HOME?: string; ASHLR_RUNS_DIR?: string };
beforeEach(() => {
  saved = { HOME: process.env.HOME, ASHLR_HOME: process.env.ASHLR_HOME, ASHLR_RUNS_DIR: process.env.ASHLR_RUNS_DIR };
  delete process.env.ASHLR_HOME;
  delete process.env.ASHLR_RUNS_DIR;
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'improve-supersededclose-')));
  process.env.HOME = home;
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  fs.rmSync(home, { recursive: true, force: true });
});

const NOW = new Date('2026-11-23T12:00:00Z');
/** ISO timestamp `days` before NOW (fractional hours allowed via `hours`). */
const at = (days: number, hours = 0): string =>
  new Date(NOW.getTime() - days * 86400_000 + hours * 3600_000).toISOString();

const REPO = 'ashlrai/phantom';

interface Row {
  at?: string;
  pr?: number;
  supersededBy?: number;
  ok?: boolean;
  error?: string;
}

const row = (pr: number, ok: boolean, days: number, error?: string, supersededBy = 7001): Row => ({
  at: at(days), pr, supersededBy, ok, ...(error === undefined ? {} : { error }),
});

const journal = (rows: Array<Row | string>): string =>
  rows.map((r) => (typeof r === 'string' ? r : JSON.stringify(r))).join('\n') + '\n';

/** Write journal text to <dir>/queue/superseded-closes.jsonl and return the file path. */
const writeJournal = (rows: Array<Row | string> | string, dir = path.join(home, 'runs')): string => {
  const queue = path.join(dir, 'queue');
  fs.mkdirSync(queue, { recursive: true });
  const file = path.join(queue, 'superseded-closes.jsonl');
  fs.writeFileSync(file, typeof rows === 'string' ? rows : journal(rows));
  return file;
};

/** The writer's own location: ~/.ashlr-runs/queue/superseded-closes.jsonl (homedir, env ignored). */
const writeWriterJournal = (rows: Array<Row | string>): string =>
  writeJournal(rows, path.join(home, '.ashlr-runs'));

/** Three failed attempts on PR 4321 across two UTC days — the recurring close failure. */
const failedRows = (pr = 4321): Row[] => [
  row(pr, false, 1, 'gh pr close exited 1: GraphQL: Resource not accessible by integration'),
  row(pr, false, 2, 'gh pr close exited 1: GraphQL: Resource not accessible by integration'),
  row(pr, false, 4, 'gh: auth login required'),
];

describe('parseSupersededCloseJournal', () => {
  it('validates rows against the writer contract and skips malformed lines', () => {
    const rows = parseSupersededCloseJournal(journal([
      'not json',
      `{"at":"${at(1)}","pr":1,"supersededBy":9,"ok":"yes"}`,
      `{"at":"${at(1)}","pr":0,"supersededBy":9,"ok":true}`,
      `{"at":"${at(1)}","pr":1,"supersededBy":9}`,
      row(7, true, 1),
      { at: at(1), pr: 8, supersededBy: 10, ok: false, error: 'boom' },
      { at: 'not-a-date', pr: 9, supersededBy: 10, ok: false },
    ]));
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ pr: 7, supersededBy: 7001, ok: true, error: null });
    expect(rows[1]).toMatchObject({ pr: 8, supersededBy: 10, ok: false, error: 'boom' });
  });
});

describe('foldSupersededCloseRows', () => {
  it('folds ok:false rows per-PR and into the close-path track; ok:true is context only', () => {
    const fold = foldSupersededCloseRows(parseSupersededCloseJournal(journal([
      row(1, true, 1),
      row(2, false, 1, 'boom'),
      row(3, false, 2, 'bang'),
      row(1, true, 3),
    ])), NOW.getTime());
    expect(fold.closedRows).toBe(2);
    expect(fold.failed.get(2)?.rows).toBe(1);
    expect(fold.failed.get(3)?.rows).toBe(1);
    expect(fold.failed.has(1)).toBe(false);
    expect(fold.closePath.rows).toBe(2);
    expect(fold.closePath.prs.has(2)).toBe(true);
    expect(fold.closePath.prs.has(3)).toBe(true);
  });

  it('drops rows outside the window and beyond the future-skew allowance', () => {
    const fold = foldSupersededCloseRows(parseSupersededCloseJournal(journal([
      row(1, false, 10, 'stale'),
      { at: new Date(NOW.getTime() + 3600_000).toISOString(), pr: 2, supersededBy: 9, ok: false, error: 'future' },
      row(3, false, 1, 'in-window'),
    ])), NOW.getTime());
    expect(fold.closePath.rows).toBe(1);
    expect(fold.closePath.prs.has(3)).toBe(true);
    expect(fold.closedRows).toBe(0);
  });
});

describe('supersededCloseBacklogItems', () => {
  it('turns recurring failed closes on one PR into a valid priority-3 backlog item', async () => {
    const items = await supersededCloseBacklogItems({ repo: REPO, journalPath: writeJournal(failedRows()), now: NOW });
    expect(items).toHaveLength(1);
    const item = items[0]!;
    expect(item.id).toMatch(/^superseded-close-failed-[0-9a-f]{16}$/);
    expect(validBacklogItem(item)).not.toBeNull();
    expect(item).toMatchObject({ priority: 3, repo: REPO, area: 'superseded-close' });
    expect(item.title).toContain('#4321');
    expect(item.prompt).toContain("failed attempt(s) for PR #4321 across 3 distinct UTC day(s)");
    expect(item.prompt).toContain('Resource not accessible by integration');
    expect(item.prompt).toContain('auth login required');
    expect(item.prompt).toContain('merged recut(s) #7001');
    expect(item.prompt).toContain('superseded-closes.jsonl');
    expect(item.prompt).toContain('fleet-superseded-close.ts');
    expect(item.prompt).toContain('no-change');
  });

  it('keeps failed closes quiet below the row or day bar', async () => {
    const few = await supersededCloseBacklogItems({
      repo: REPO, now: NOW,
      journalPath: writeJournal([row(9, false, 1, 'boom'), row(9, false, 3, 'boom')]),
    });
    expect(few).toEqual([]);
    const oneDay = await supersededCloseBacklogItems({
      repo: REPO, now: NOW,
      journalPath: writeJournal([
        row(9, false, 1, 'boom'), row(9, false, 1, 'boom'), row(9, false, 1, 'boom'),
      ]),
    });
    expect(oneDay).toEqual([]);
  });

  it('turns failures spread across distinct PRs into a close-path item', async () => {
    const items = await supersededCloseBacklogItems({
      repo: REPO, now: NOW,
      journalPath: writeJournal([
        row(11, false, 1, 'gh: auth login required', 7001),
        row(22, false, 2, 'gh: auth login required', 7002),
        row(33, false, 4, 'gh pr close exited 1: HTTP 502', 7003),
        row(44, true, 2),
      ]),
    });
    expect(items).toHaveLength(1);
    const item = items[0]!;
    expect(item.id).toMatch(/^superseded-close-close-path-[0-9a-f]{16}$/);
    expect(validBacklogItem(item)).not.toBeNull();
    expect(item.title).toContain('across PRs');
    expect(item.prompt).toContain('3 failed attempt(s)');
    expect(item.prompt).toContain('3 distinct PR(s)');
    expect(item.prompt).toContain('1 other in-window attempt(s) closed cleanly');
    expect(item.prompt).toContain('gh pr close');
  });

  it('keeps the close-path cell quiet when failures sit on one PR or below the bars', async () => {
    // Three failures on ONE PR: per-PR cell only, no close-path item.
    const single = await supersededCloseBacklogItems({
      repo: REPO, now: NOW, journalPath: writeJournal(failedRows()),
    });
    expect(single).toHaveLength(1);
    expect(single[0]!.id).toMatch(/^superseded-close-failed-/);
    // Two PRs but only two failed rows — below the row bar.
    const few = await supersededCloseBacklogItems({
      repo: REPO, now: NOW,
      journalPath: writeJournal([row(1, false, 1, 'boom'), row(2, false, 3, 'boom')]),
    });
    expect(few).toEqual([]);
    // Three rows across two PRs but all on one day — below the day bar.
    const oneDay = await supersededCloseBacklogItems({
      repo: REPO, now: NOW,
      journalPath: writeJournal([
        row(1, false, 1, 'boom'), row(2, false, 1, 'boom'), row(1, false, 1, 'boom'),
      ]),
    });
    expect(oneDay).toEqual([]);
  });

  it('emits the close-path cell before per-PR cells and honours the limit', async () => {
    const rows: Row[] = [
      row(11, false, 1, 'boom'), row(22, false, 1, 'boom'), row(33, false, 3, 'boom'),
      ...failedRows(44),
      row(55, false, 2, 'boom'), row(55, false, 3, 'boom'), row(55, false, 5, 'boom'),
    ];
    const items = await supersededCloseBacklogItems({ repo: REPO, journalPath: writeJournal(rows), now: NOW });
    // close-path (9 rows, 5 PRs, days 1-5) + PR44 + PR55 per-PR cells, pr order within the tie.
    expect(items).toHaveLength(3);
    expect(items[0]!.id).toMatch(/^superseded-close-close-path-/);
    expect(items[1]!.id).toMatch(/^superseded-close-failed-/);
    expect(items[2]!.id).toMatch(/^superseded-close-failed-/);
    const one = await supersededCloseBacklogItems({ repo: REPO, journalPath: writeJournal(rows), now: NOW, limit: 1 });
    expect(one).toHaveLength(1);
    expect(one[0]!.id).toBe(items[0]!.id);
  });

  it('drops rows outside the 7-day window and ignores ok:true-only PRs', async () => {
    const stale = failedRows().map((r) => ({ ...r, at: at(10) }));
    expect(await supersededCloseBacklogItems({ repo: REPO, journalPath: writeJournal(stale), now: NOW })).toEqual([]);
    const closedOnly = await supersededCloseBacklogItems({
      repo: REPO, now: NOW,
      journalPath: writeJournal([row(5, true, 1), row(5, true, 2), row(5, true, 4)]),
    });
    expect(closedOnly).toEqual([]);
  });

  it('emits only for the fleet repository', async () => {
    const file = writeJournal(failedRows());
    expect(await supersededCloseBacklogItems({ repo: 'ashlrai/lexicon', journalPath: file, now: NOW })).toEqual([]);
    expect(await supersededCloseBacklogItems({ repo: '', journalPath: file, now: NOW })).toEqual([]);
    expect(await supersededCloseBacklogItems({ repo: 'not-a-repo', journalPath: file, now: NOW })).toEqual([]);
    const items = await supersededCloseBacklogItems({ repo: 'AshlrAI/Phantom', journalPath: file, now: NOW });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ repo: 'AshlrAI/Phantom' });
  });

  it('yields nothing for a missing or malformed journal', async () => {
    expect(await supersededCloseBacklogItems({ repo: REPO, journalPath: path.join(home, 'no-such.jsonl'), now: NOW })).toEqual([]);
    const file = writeJournal([
      'not json',
      `{"at":"${at(1)}","pr":"x","supersededBy":9,"ok":false}`,
      `{"at":"${at(1)}","pr":4,"supersededBy":9,"ok":false,"error":"boom"}`,
    ]);
    expect(await supersededCloseBacklogItems({ repo: REPO, journalPath: file, now: NOW })).toEqual([]);
  });

  it('derives stable ids so a refresh re-adds nothing', async () => {
    const file = writeJournal(failedRows());
    const first = await supersededCloseBacklogItems({ repo: REPO, journalPath: file, now: NOW });
    const second = await supersededCloseBacklogItems({ repo: REPO, journalPath: file, now: NOW });
    expect(first).toHaveLength(1);
    expect(second.map((i) => i.id)).toEqual(first.map((i) => i.id));
    const grown = writeJournal([...failedRows(), row(4321, false, 5, 'another reason')]);
    const third = await supersededCloseBacklogItems({ repo: REPO, journalPath: grown, now: NOW });
    expect(third.map((i) => i.id)).toEqual(first.map((i) => i.id));
  });

  it('scrubs secret-shaped text out of recorded errors before it reaches a prompt', async () => {
    const token = `ghp_${'a'.repeat(36)}`;
    const items = await supersededCloseBacklogItems({
      repo: REPO, now: NOW,
      journalPath: writeJournal([
        row(9, false, 1, `auth failed for ${token}`),
        row(9, false, 2, `auth failed for ${token}`),
        row(9, false, 4, 'plain failure'),
      ]),
    });
    expect(items).toHaveLength(1);
    expect(items[0]!.prompt).not.toContain(token);
    expect(items[0]!.prompt).toContain('[REDACTED]');
  });

  it('reads the writer location ~/.ashlr-runs even when ASHLR_RUNS_DIR points elsewhere', async () => {
    // The writer resolves homedir()/.ashlr-runs and ignores the env var;
    // the fold must find evidence there regardless of ASHLR_RUNS_DIR.
    process.env.ASHLR_RUNS_DIR = path.join(home, 'elsewhere');
    writeWriterJournal(failedRows());
    const items = await supersededCloseBacklogItems({ repo: REPO, now: NOW });
    expect(items).toHaveLength(1);
    expect(items[0]!.id).toMatch(/^superseded-close-failed-/);
  });

  it('also reads the env runs dir when it differs, merging both locations', async () => {
    process.env.ASHLR_RUNS_DIR = path.join(home, 'custom-runs');
    // Two failed rows in the writer location + one in the env location:
    // merged they meet the recurring bar on PR 4321.
    writeWriterJournal([row(4321, false, 1, 'boom'), row(4321, false, 2, 'boom')]);
    writeJournal([row(4321, false, 4, 'boom')], path.join(home, 'custom-runs'));
    const items = await supersededCloseBacklogItems({ repo: REPO, now: NOW });
    expect(items).toHaveLength(1);
    expect(items[0]!.prompt).toContain('3 failed attempt(s) for PR #4321');
  });

  it('appends superseded-close items through discovery and dedupes on refresh', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    try {
      writeWriterJournal(failedRows());
      const greenGh = async (args: string[]) => {
        const p = args[4] ?? '';
        if (p === 'repos/ashlrai/phantom') return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n{"default_branch":"master"}', stderr: '' };
        return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n[]', stderr: '' };
      };
      const first = await discoverBacklog(REPO, { gh: greenGh });
      const folded = first.items.filter((i) => i.id.startsWith('superseded-close-'));
      expect(folded).toHaveLength(1);
      expect(folded[0]!.id).toMatch(/^superseded-close-failed-/);
      expect(first.items.every((i) => validBacklogItem(i) !== null)).toBe(true);
      expect(appendUserBacklogItems(folded)).toBe(folded.length);
      const second = await discoverBacklog(REPO, { gh: greenGh });
      expect(appendUserBacklogItems(second.items.filter((i) => i.id.startsWith('superseded-close-')))).toBe(0);
      expect(readUserBacklogItems().filter((i) => i.id.startsWith('superseded-close-'))).toHaveLength(folded.length);
    } finally {
      vi.useRealTimers();
    }
  });
});
