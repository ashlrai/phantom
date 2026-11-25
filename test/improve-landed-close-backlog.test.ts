import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { discoverBacklog } from '../src/core/improve/discover.js';
import {
  foldLandedCloseRows,
  landedCloseBacklogItems,
  parseLandedCloseJournal,
} from '../src/core/improve/landed-close-backlog.js';
import { appendUserBacklogItems, readUserBacklogItems, validBacklogItem } from '../src/core/cloud/backlog.js';

let home: string;
let saved: { HOME?: string; ASHLR_HOME?: string; ASHLR_RUNS_DIR?: string };
beforeEach(() => {
  saved = { HOME: process.env.HOME, ASHLR_HOME: process.env.ASHLR_HOME, ASHLR_RUNS_DIR: process.env.ASHLR_RUNS_DIR };
  delete process.env.ASHLR_HOME;
  delete process.env.ASHLR_RUNS_DIR;
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'improve-landedclose-')));
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
const HEAD_A = 'a'.repeat(40);
const HEAD_B = 'b'.repeat(40);

interface Row {
  at?: string;
  pr?: number;
  head?: string;
  outcome?: string;
  reason?: string;
}

const row = (pr: number, outcome: string, days: number, reason?: string, head = HEAD_A): Row => ({
  at: at(days), pr, head, outcome, ...(reason === undefined ? {} : { reason }),
});

const journal = (rows: Array<Row | string>): string =>
  rows.map((r) => (typeof r === 'string' ? r : JSON.stringify(r))).join('\n') + '\n';

const writeJournal = (rows: Array<Row | string> | string): string => {
  const dir = path.join(home, 'runs', 'queue');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'landed-closes.jsonl');
  fs.writeFileSync(file, typeof rows === 'string' ? rows : journal(rows));
  return file;
};

/** Three 'failed' attempts on PR 4321 across two UTC days — the recurring close failure. */
const failedRows = (pr = 4321): Row[] => [
  row(pr, 'failed', 1, 'gh pr close exited 1: GraphQL: Resource not accessible by integration'),
  row(pr, 'failed', 2, 'gh pr close exited 1: GraphQL: Resource not accessible by integration'),
  row(pr, 'failed', 4, 'gh: auth login required'),
];

describe('parseLandedCloseJournal', () => {
  it('validates rows against the writer contract and skips malformed lines', () => {
    const rows = parseLandedCloseJournal(journal([
      'not json',
      '{"at":"soon","pr":1,"head":"' + HEAD_A + '","outcome":"closed"}',
      '{"at":"' + at(1) + '","pr":0,"head":"' + HEAD_A + '","outcome":"closed"}',
      '{"at":"' + at(1) + '","pr":1,"head":"' + HEAD_A + '","outcome":"bogus"}',
      row(7, 'closed', 1),
      { at: at(1), pr: 8, head: 'not-a-sha', outcome: 'skipped', reason: 'head-moved' },
    ]));
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ pr: 7, outcome: 'closed', head: HEAD_A, reason: null });
    expect(rows[1]).toMatchObject({ pr: 8, outcome: 'skipped', reason: 'head-moved', head: null });
  });
});

describe('foldLandedCloseRows', () => {
  it('classifies skips by reason and never folds closed rows', () => {
    const fold = foldLandedCloseRows(parseLandedCloseJournal(journal([
      row(1, 'closed', 1),
      row(1, 'skipped', 1, 'head-moved'),
      row(2, 'skipped', 1, 'view-failed'),
      row(3, 'skipped', 1, 'some-new-reason'),
      row(3, 'skipped', 2),
    ])), NOW.getTime());
    expect(fold.failed.size).toBe(0);
    expect(fold.headMoved.get(1)?.rows).toBe(1);
    expect(fold.viewFailed.rows).toBe(1);
    expect(fold.viewFailed.prs.has(2)).toBe(true);
    expect(fold.otherSkip.get(3)?.rows).toBe(2);
  });
});

describe('landedCloseBacklogItems', () => {
  it('turns recurring failed closes into a valid priority-3 backlog item', async () => {
    const items = await landedCloseBacklogItems({ repo: REPO, journalPath: writeJournal(failedRows()), now: NOW });
    expect(items).toHaveLength(1);
    const item = items[0]!;
    expect(item.id).toMatch(/^landed-close-failed-[0-9a-f]{16}$/);
    expect(validBacklogItem(item)).not.toBeNull();
    expect(item).toMatchObject({ priority: 3, repo: REPO, area: 'landed-close' });
    expect(item.title).toContain('#4321');
    expect(item.prompt).toContain("'failed' attempt(s) for PR #4321 across 3 distinct UTC day(s)");
    expect(item.prompt).toContain('Resource not accessible by integration');
    expect(item.prompt).toContain('landed-closes.jsonl');
    expect(item.prompt).toContain('fleet-landed-close.ts');
    expect(item.prompt).toContain('no-change');
  });

  it('keeps failed closes quiet below the row or day bar', async () => {
    const few = await landedCloseBacklogItems({
      repo: REPO, now: NOW,
      journalPath: writeJournal([row(9, 'failed', 1, 'boom'), row(9, 'failed', 3, 'boom')]),
    });
    expect(few).toEqual([]);
    const oneDay = await landedCloseBacklogItems({
      repo: REPO, now: NOW,
      journalPath: writeJournal([
        row(9, 'failed', 1, 'boom'), row(9, 'failed', 1, 'boom', HEAD_B), row(9, 'failed', 1, 'boom'),
      ]),
    });
    expect(oneDay).toEqual([]);
  });

  it('turns recurring head-moved skips into a head-moved item', async () => {
    const items = await landedCloseBacklogItems({
      repo: REPO, now: NOW,
      journalPath: writeJournal([
        row(55, 'skipped', 1, 'head-moved', HEAD_A),
        row(55, 'skipped', 2, 'head-moved', HEAD_B),
        row(55, 'skipped', 5, 'head-moved', HEAD_A),
        row(56, 'skipped', 1, 'head-moved'),
        row(56, 'closed', 2),
      ]),
    });
    expect(items).toHaveLength(1);
    const item = items[0]!;
    expect(item.id).toMatch(/^landed-close-head-moved-[0-9a-f]{16}$/);
    expect(validBacklogItem(item)).not.toBeNull();
    expect(item.prompt).toContain("'head-moved' skip(s) for PR #55");
    expect(item.prompt).toContain('2 distinct planned head(s)');
    expect(item.prompt).not.toContain('PR #56');
  });

  it('folds recurring view-failed skips globally across distinct PRs', async () => {
    const items = await landedCloseBacklogItems({
      repo: REPO, now: NOW,
      journalPath: writeJournal([
        row(1, 'skipped', 1, 'view-failed'),
        row(2, 'skipped', 1, 'view-failed'),
        row(3, 'skipped', 3, 'view-failed'),
      ]),
    });
    expect(items).toHaveLength(1);
    const item = items[0]!;
    expect(item.id).toMatch(/^landed-close-view-failed-[0-9a-f]{16}$/);
    expect(validBacklogItem(item)).not.toBeNull();
    expect(item.prompt).toContain('3 \'view-failed\' skip(s)');
    expect(item.prompt).toContain('3 distinct PR(s)');
    expect(item.prompt).toContain('gh pr view');
  });

  it('keeps view-failed quiet below the recurring bar or on one day', async () => {
    const few = await landedCloseBacklogItems({
      repo: REPO, now: NOW,
      journalPath: writeJournal([row(1, 'skipped', 1, 'view-failed'), row(2, 'skipped', 3, 'view-failed')]),
    });
    expect(few).toEqual([]);
    const oneDay = await landedCloseBacklogItems({
      repo: REPO, now: NOW,
      journalPath: writeJournal([
        row(1, 'skipped', 1, 'view-failed'), row(2, 'skipped', 1, 'view-failed'), row(3, 'skipped', 1, 'view-failed'),
      ]),
    });
    expect(oneDay).toEqual([]);
  });

  it('folds skipped rows outside the known vocabulary into other-skip cells', async () => {
    const items = await landedCloseBacklogItems({
      repo: REPO, now: NOW,
      journalPath: writeJournal([
        row(77, 'skipped', 1, 'superseded-by-newer-plan'),
        row(77, 'skipped', 2, 'superseded-by-newer-plan'),
        row(77, 'skipped', 4),
      ]),
    });
    expect(items).toHaveLength(1);
    const item = items[0]!;
    expect(item.id).toMatch(/^landed-close-other-skip-[0-9a-f]{16}$/);
    expect(item.prompt).toContain('superseded-by-newer-plan');
    expect(item.prompt).toContain('skip vocabulary');
  });

  it('emits all four cell kinds in a fixed order and honours the limit', async () => {
    const rows: Row[] = [
      ...failedRows(11),
      row(22, 'skipped', 1, 'head-moved'), row(22, 'skipped', 2, 'head-moved'), row(22, 'skipped', 4, 'head-moved'),
      row(1, 'skipped', 1, 'view-failed'), row(2, 'skipped', 1, 'view-failed'), row(3, 'skipped', 3, 'view-failed'),
      row(33, 'skipped', 1, 'mystery'), row(33, 'skipped', 2, 'mystery'), row(33, 'skipped', 5, 'mystery'),
    ];
    const items = await landedCloseBacklogItems({ repo: REPO, journalPath: writeJournal(rows), now: NOW });
    expect(items).toHaveLength(4);
    expect(items[0]!.id).toMatch(/^landed-close-view-failed-/);
    expect(items[1]!.id).toMatch(/^landed-close-failed-/);
    expect(items[2]!.id).toMatch(/^landed-close-head-moved-/);
    expect(items[3]!.id).toMatch(/^landed-close-other-skip-/);
    const one = await landedCloseBacklogItems({ repo: REPO, journalPath: writeJournal(rows), now: NOW, limit: 1 });
    expect(one).toHaveLength(1);
    expect(one[0]!.id).toBe(items[0]!.id);
  });

  it('drops rows outside the 7-day window and ignores closed-only PRs', async () => {
    const stale = failedRows().map((r) => ({ ...r, at: at(10) }));
    expect(await landedCloseBacklogItems({ repo: REPO, journalPath: writeJournal(stale), now: NOW })).toEqual([]);
    const closedOnly = await landedCloseBacklogItems({
      repo: REPO, now: NOW,
      journalPath: writeJournal([row(5, 'closed', 1), row(5, 'closed', 2), row(5, 'closed', 4)]),
    });
    expect(closedOnly).toEqual([]);
  });

  it('emits only for the fleet repository', async () => {
    const file = writeJournal(failedRows());
    expect(await landedCloseBacklogItems({ repo: 'ashlrai/lexicon', journalPath: file, now: NOW })).toEqual([]);
    expect(await landedCloseBacklogItems({ repo: '', journalPath: file, now: NOW })).toEqual([]);
    expect(await landedCloseBacklogItems({ repo: 'not-a-repo', journalPath: file, now: NOW })).toEqual([]);
    const items = await landedCloseBacklogItems({ repo: 'AshlrAI/Phantom', journalPath: file, now: NOW });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ repo: 'AshlrAI/Phantom' });
  });

  it('yields nothing for a missing or malformed journal', async () => {
    expect(await landedCloseBacklogItems({ repo: REPO, journalPath: path.join(home, 'no-such.jsonl'), now: NOW })).toEqual([]);
    const file = writeJournal([
      'not json',
      '{"at":"' + at(1) + '","pr":"x","outcome":"failed"}',
      '{"at":"' + at(1) + '","pr":4,"outcome":"failed","reason":"boom"}',
    ]);
    expect(await landedCloseBacklogItems({ repo: REPO, journalPath: file, now: NOW })).toEqual([]);
  });

  it('derives stable ids so a refresh re-adds nothing', async () => {
    const file = writeJournal(failedRows());
    const first = await landedCloseBacklogItems({ repo: REPO, journalPath: file, now: NOW });
    const second = await landedCloseBacklogItems({ repo: REPO, journalPath: file, now: NOW });
    expect(first).toHaveLength(1);
    expect(second.map((i) => i.id)).toEqual(first.map((i) => i.id));
    const grown = writeJournal([...failedRows(), row(4321, 'failed', 5, 'another reason')]);
    const third = await landedCloseBacklogItems({ repo: REPO, journalPath: grown, now: NOW });
    expect(third.map((i) => i.id)).toEqual(first.map((i) => i.id));
  });

  it('scrubs secret-shaped text out of recorded reasons before it reaches a prompt', async () => {
    const token = `ghp_${'a'.repeat(36)}`;
    const items = await landedCloseBacklogItems({
      repo: REPO, now: NOW,
      journalPath: writeJournal([
        row(9, 'failed', 1, `auth failed for ${token}`),
        row(9, 'failed', 2, `auth failed for ${token}`),
        row(9, 'failed', 4, 'plain failure'),
      ]),
    });
    expect(items).toHaveLength(1);
    expect(items[0]!.prompt).not.toContain(token);
    expect(items[0]!.prompt).toContain('[REDACTED]');
  });

  it('reads the default journal path under the runs dir', async () => {
    process.env.ASHLR_RUNS_DIR = path.join(home, 'runs');
    writeJournal(failedRows());
    const items = await landedCloseBacklogItems({ repo: REPO, now: NOW });
    expect(items).toHaveLength(1);
    expect(items[0]!.id).toMatch(/^landed-close-failed-/);
  });

  it('appends landed-close items through discovery and dedupes on refresh', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    try {
      process.env.ASHLR_RUNS_DIR = path.join(home, 'runs');
      writeJournal(failedRows());
      const greenGh = async (args: string[]) => {
        const p = args[4] ?? '';
        if (p === 'repos/ashlrai/phantom') return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n{"default_branch":"master"}', stderr: '' };
        return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n[]', stderr: '' };
      };
      const first = await discoverBacklog(REPO, { gh: greenGh });
      const landed = first.items.filter((i) => i.id.startsWith('landed-close-'));
      expect(landed).toHaveLength(1);
      expect(landed[0]!.id).toMatch(/^landed-close-failed-/);
      expect(first.items.every((i) => validBacklogItem(i) !== null)).toBe(true);
      expect(appendUserBacklogItems(landed)).toBe(landed.length);
      const second = await discoverBacklog(REPO, { gh: greenGh });
      expect(appendUserBacklogItems(second.items.filter((i) => i.id.startsWith('landed-close-')))).toBe(0);
      expect(readUserBacklogItems().filter((i) => i.id.startsWith('landed-close-'))).toHaveLength(landed.length);
    } finally {
      vi.useRealTimers();
    }
  });
});
