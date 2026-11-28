/**
 * outside-pr-backlog — merged outside-PR revert outcomes folded into
 * self-improvement backlog items.
 *
 * Contract:
 *   - A repo cell emits only at OUTSIDE_PR_REVERTED_RECURRING (3)
 *     reverted outside merges inside the 30-day window; 'unknown'
 *     verdicts and merges outside the window never count toward the bar.
 *   - Items self-target the outside PRs' own repository (owner/name),
 *     unlike the sibling machinery feeds that gate on the fleet repo.
 *   - The newest journaled verdict per PR wins; counts quote recorded
 *     floors when the tail truncated or lines were ignored; degraded
 *     scan coverage is named in the prompt.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendUserBacklogItems, readUserBacklogItems, validBacklogItem } from '../src/core/cloud/backlog.js';
import {
  foldOutsidePrCells,
  OUTSIDE_PR_MAX_ITEMS,
  OUTSIDE_PR_REVERTED_RECURRING,
  OUTSIDE_PR_WINDOW_HOURS,
  outsidePrBacklogItems,
} from '../src/core/improve/outside-pr-backlog.js';
import { discoverBacklog } from '../src/core/improve/discover.js';
import {
  OUTSIDE_PR_OUTCOME_JOURNAL_NAME,
  OUTSIDE_PR_OUTCOME_SCHEMA,
  OUTSIDE_PR_SCAN_SCHEMA,
  type OutsidePrOutcomeJournalRow,
} from '../src/core/fleet/outside-pr-outcome-ledger.js';

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const NOW = Date.now();
const AT = new Date(NOW).toISOString();
const daysAgo = (days: number): string => new Date(NOW - days * DAY).toISOString();

const JOURNAL = join('metrics', OUTSIDE_PR_OUTCOME_JOURNAL_NAME);

const outcomeLine = (
  repo: string,
  number: number,
  verdict: 'yes' | 'no' | 'unknown',
  mergedDaysAgo: number,
  over: Record<string, unknown> = {},
): string => JSON.stringify({
  v: 1, kind: OUTSIDE_PR_OUTCOME_SCHEMA, at: AT,
  repo, number, title: `outside fix ${number}`, author: 'ext-dev', agent: null, model: null,
  mergedAt: daysAgo(mergedDaysAgo), reverted: verdict, ...over,
});

const scanLine = (over: Record<string, unknown> = {}): string => JSON.stringify({
  v: 1, kind: OUTSIDE_PR_SCAN_SCHEMA, at: AT,
  sourceState: 'healthy', windowDays: 30, since: daysAgo(30), revertLedger: 'read',
  repos: [{ repo: 'acme/widgets', state: 'healthy', listed: 5, hitLimit: false, prs: 5 }],
  ...over,
});

const row = (
  repo: string,
  number: number,
  verdict: 'yes' | 'no' | 'unknown',
  mergedAt: string,
  over: Partial<OutsidePrOutcomeJournalRow> = {},
): OutsidePrOutcomeJournalRow => ({
  v: 1, kind: OUTSIDE_PR_OUTCOME_SCHEMA, at: AT,
  repo, number, title: `fix ${number}`, author: 'ext-dev', agent: null, model: null,
  mergedAt, createdAt: null, reviews: null, ci: null, diff: null, reverted: verdict, ...over,
});

describe('foldOutsidePrCells', () => {
  const opts = { nowMs: NOW, windowHours: OUTSIDE_PR_WINDOW_HOURS };

  it('groups in-window merges per repo with verdict tallies and quoted evidence', () => {
    const cells = foldOutsidePrCells([
      row('acme/widgets', 1, 'yes', daysAgo(2), { agent: 'devin' }),
      row('acme/widgets', 2, 'yes', daysAgo(3), { agent: 'devin' }),
      row('acme/widgets', 3, 'yes', daysAgo(4)),
      row('acme/widgets', 4, 'no', daysAgo(5)),
      row('acme/widgets', 5, 'unknown', daysAgo(6)),
      row('acme/other', 6, 'yes', daysAgo(2)),
    ], opts);
    expect(cells).toHaveLength(1);
    const cell = cells[0]!;
    expect(cell.repo).toBe('acme/widgets');
    expect(cell).toMatchObject({ merged: 5, reverted: 3, unknown: 1, kept: 1 });
    expect(cell.authors).toEqual([{ author: 'ext-dev', reverted: 3 }]);
    // Reverted merges tally by journaled agent attribution; unattributed is its own bucket.
    expect(cell.agents).toEqual([
      { agent: 'devin', reverted: 2 },
      { agent: null, reverted: 1 },
    ]);
    expect(cell.examples.map((e) => e.number)).toEqual([1, 2, 3]);
    expect(cell.firstMerged).toBe(daysAgo(4));
    expect(cell.lastMerged).toBe(daysAgo(2));
  });

  it('drops cells below the recurring bar and merges outside the window', () => {
    expect(OUTSIDE_PR_REVERTED_RECURRING).toBe(3);
    const cells = foldOutsidePrCells([
      row('acme/widgets', 1, 'yes', daysAgo(2)),
      row('acme/widgets', 2, 'yes', daysAgo(3)),
      row('acme/widgets', 3, 'yes', daysAgo(OUTSIDE_PR_WINDOW_HOURS / 24 + 1)), // outside 30d
      row('acme/quiet', 4, 'yes', daysAgo(2)),
      row('acme/quiet', 5, 'yes', daysAgo(3)),
      row('acme/quiet', 6, 'no', daysAgo(4)),
    ], opts);
    expect(cells).toEqual([]);
  });

  it('never counts unknown verdicts toward the bar', () => {
    const cells = foldOutsidePrCells([
      row('acme/widgets', 1, 'yes', daysAgo(2)),
      row('acme/widgets', 2, 'yes', daysAgo(3)),
      row('acme/widgets', 3, 'unknown', daysAgo(4)),
      row('acme/widgets', 4, 'unknown', daysAgo(5)),
      row('acme/widgets', 5, 'unknown', daysAgo(6)),
    ], opts);
    expect(cells).toEqual([]);
  });

  it('skips rows whose mergedAt does not parse', () => {
    const cells = foldOutsidePrCells([
      row('acme/widgets', 1, 'yes', 'not a date'),
      row('acme/widgets', 2, 'yes', daysAgo(2)),
      row('acme/widgets', 3, 'yes', daysAgo(3)),
      row('acme/widgets', 4, 'yes', daysAgo(4)),
    ], opts);
    expect(cells).toHaveLength(1);
    expect(cells[0]!.merged).toBe(3);
  });

  it('tallies reverted merges\' open→merge latency and review evidence only', () => {
    const cells = foldOutsidePrCells([
      row('acme/widgets', 1, 'yes', daysAgo(2), {
        createdAt: new Date(NOW - 2 * DAY - 120 * MIN).toISOString(),
        reviews: { decision: 'APPROVED', latest: 2 },
      }),
      row('acme/widgets', 2, 'yes', daysAgo(3), {
        createdAt: new Date(NOW - 3 * DAY - 60 * MIN).toISOString(),
        reviews: { decision: null, latest: 0 },
      }),
      // Reverted but pre-fields: counts toward prs, neither evidence denominator.
      row('acme/widgets', 3, 'yes', daysAgo(4)),
      // Kept/unknown rows' evidence is denominator context only — never tallied here.
      row('acme/widgets', 4, 'no', daysAgo(5), {
        createdAt: new Date(NOW - 5 * DAY - 30 * MIN).toISOString(),
        reviews: { decision: 'CHANGES_REQUESTED', latest: 3 },
      }),
      row('acme/widgets', 5, 'unknown', daysAgo(6), {
        createdAt: new Date(NOW - 6 * DAY - 10 * MIN).toISOString(),
        reviews: { decision: 'REVIEW_REQUIRED', latest: 1 },
      }),
    ], opts);
    expect(cells).toHaveLength(1);
    expect(cells[0]).toMatchObject({
      merged: 5, reverted: 3, kept: 1, unknown: 1,
      ttm_known: 2, ttm_minutes_mean: 90,
      reviews_known: 2, unreviewed: 1, changes_requested: 0,
      diff_known: 0, diff_lines_mean: null, diff_files_mean: null,
    });
  });

  it('tallies reverted merges\' journaled diff size with an honest denominator', () => {
    const cells = foldOutsidePrCells([
      row('acme/widgets', 1, 'yes', daysAgo(2), {
        diff: { additions: 100, deletions: 20, changedFiles: 5 },
      }),
      row('acme/widgets', 2, 'yes', daysAgo(3), {
        diff: { additions: 40, deletions: 10, changedFiles: 3 },
      }),
      // Reverted but pre-fields: counts toward prs, not the diff denominator.
      row('acme/widgets', 3, 'yes', daysAgo(4)),
      // Kept rows' diff evidence is denominator context only — never tallied here.
      row('acme/widgets', 4, 'no', daysAgo(5), {
        diff: { additions: 999, deletions: 0, changedFiles: 9 },
      }),
    ], opts);
    expect(cells).toHaveLength(1);
    expect(cells[0]).toMatchObject({
      merged: 4, reverted: 3, kept: 1,
      diff_known: 2, diff_lines_mean: 85, diff_files_mean: 4,
    });
  });

  it('never counts merges stamped past the evaluation-time future skew', () => {
    const future = new Date(NOW + 2 * 3_600_000).toISOString();
    // All three reverted merges carry a future mergedAt: corrupt or
    // replayed evidence, no cell.
    expect(foldOutsidePrCells([
      row('acme/widgets', 1, 'yes', future),
      row('acme/widgets', 2, 'yes', future),
      row('acme/widgets', 3, 'yes', future),
    ], opts)).toEqual([]);
    // A future stamp cannot push a below-bar cell over it either.
    expect(foldOutsidePrCells([
      row('acme/widgets', 4, 'yes', daysAgo(2)),
      row('acme/widgets', 5, 'yes', daysAgo(3)),
      row('acme/widgets', 6, 'yes', future),
    ], opts)).toEqual([]);
    // Inside the one-minute skew the stamp still counts as clock drift.
    const cells = foldOutsidePrCells([
      row('acme/widgets', 7, 'yes', daysAgo(2)),
      row('acme/widgets', 8, 'yes', daysAgo(3)),
      row('acme/widgets', 9, 'yes', new Date(NOW + 30_000).toISOString()),
    ], opts);
    expect(cells).toHaveLength(1);
    expect(cells[0]!.reverted).toBe(3);
  });
});

describe('outsidePrBacklogItems', () => {
  let home: string;
  let saved: { HOME?: string; ASHLR_HOME?: string; ASHLR_RUNS_DIR?: string };

  beforeEach(async () => {
    saved = { HOME: process.env.HOME, ASHLR_HOME: process.env.ASHLR_HOME, ASHLR_RUNS_DIR: process.env.ASHLR_RUNS_DIR };
    delete process.env.ASHLR_HOME;
    delete process.env.ASHLR_RUNS_DIR;
    home = await mkdtemp(join(tmpdir(), 'outside-pr-backlog-'));
    process.env.HOME = home;
  });
  afterEach(async () => {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    await rm(home, { recursive: true, force: true });
  });

  /** A runs dir holding metrics/outside-pr-outcomes.jsonl. */
  async function runsDir(name: string, lines: string[] | null | undefined): Promise<string> {
    const dir = join(home, name);
    await mkdir(join(dir, 'metrics'), { recursive: true });
    if (lines !== undefined && lines !== null) {
      await writeFile(join(dir, JOURNAL), lines.join('\n') + '\n');
    }
    return dir;
  }

  const RECURRING = [
    outcomeLine('acme/widgets', 11, 'yes', 2),
    outcomeLine('acme/widgets', 12, 'yes', 4),
    outcomeLine('acme/widgets', 13, 'yes', 6),
    outcomeLine('acme/widgets', 14, 'no', 8),
    outcomeLine('acme/widgets', 15, 'unknown', 10),
  ];

  it('emits one self-targeted item per recurring repo and validates it', async () => {
    const dir = await runsDir('runs-hit', [
      outcomeLine('acme/widgets', 11, 'yes', 2, { agent: 'devin' }),
      outcomeLine('acme/widgets', 12, 'yes', 4, { agent: 'cursor' }),
      outcomeLine('acme/widgets', 13, 'yes', 6),
      outcomeLine('acme/widgets', 14, 'no', 8),
      outcomeLine('acme/widgets', 15, 'unknown', 10),
      scanLine(),
    ]);
    const items = await outsidePrBacklogItems({ runsDir: dir, now: new Date(NOW) });
    expect(items).toHaveLength(1);
    const [item] = items;
    expect(item).toMatchObject({ priority: 3, repo: 'acme/widgets', area: 'outside-prs' });
    expect(item!.id).toMatch(/^outside-pr-reverts-[0-9a-f]{16}$/);
    expect(item!.title).toContain('acme/widgets');
    expect(validBacklogItem(item)).not.toBeNull();
    expect(item!.prompt).toContain('3 of the recorded 5 outside merges');
    expect(item!.prompt).toContain('#11');
    expect(item!.prompt).toContain('agent');
    // Journaled agent attribution is quoted; the unattributed bucket is honest, model never claimed.
    expect(item!.prompt).toContain('devin (1)');
    expect(item!.prompt).toContain('cursor (1)');
    expect(item!.prompt).toContain('unattributed (1)');
    expect(item!.prompt).toContain('model is never recorded');
    expect(item!.prompt).toContain('outside-pr-outcomes.jsonl');
    expect(item!.prompt).toContain('phm fleet outside-outcomes');
    expect(item!.prompt).toContain('no-change');
    // 'unknown' and healthy coverage are context, not caveats.
    expect(item!.prompt).not.toContain('Coverage:');
  });

  it('quotes reverted merges\' review and merge-speed evidence in the prompt', async () => {
    const dir = await runsDir('runs-review', [
      outcomeLine('acme/widgets', 11, 'yes', 2, {
        createdAt: new Date(NOW - 2 * DAY - 120 * MIN).toISOString(),
        reviews: { decision: 'APPROVED', latest: 2 },
      }),
      outcomeLine('acme/widgets', 12, 'yes', 4, {
        createdAt: new Date(NOW - 4 * DAY - 60 * MIN).toISOString(),
        reviews: { decision: null, latest: 0 },
      }),
      // Reviews recorded but no usable open stamp — reviews_known only.
      outcomeLine('acme/widgets', 13, 'yes', 6, {
        reviews: { decision: 'CHANGES_REQUESTED', latest: 1 },
      }),
      outcomeLine('acme/widgets', 14, 'no', 8),
      scanLine(),
    ]);
    const items = await outsidePrBacklogItems({ runsDir: dir, now: new Date(NOW) });
    expect(items).toHaveLength(1);
    const prompt = items[0]!.prompt;
    expect(prompt).toContain('Review and merge-speed evidence');
    expect(prompt).toContain('2 of the reverted merges carry a usable open→merge time (mean 90 minutes)');
    expect(prompt).toContain('3 of the reverted merges carry journaled review evidence');
    expect(prompt).toContain('1 of those gh returned with zero reviewers — merged without a recorded review');
    expect(prompt).toContain('1 still stood CHANGES_REQUESTED when the sync read them');
    expect(prompt).toContain('rows written before these fields existed count in no denominator');
  });

  it('quotes reverted merges\' journaled diff size in the prompt', async () => {
    const dir = await runsDir('runs-diff', [
      outcomeLine('acme/widgets', 11, 'yes', 2, {
        diff: { additions: 100, deletions: 20, changedFiles: 5 },
      }),
      outcomeLine('acme/widgets', 12, 'yes', 4, {
        diff: { additions: 40, deletions: 10, changedFiles: 3 },
      }),
      // Pre-fields reverted row: counts toward prs, not the diff denominator.
      outcomeLine('acme/widgets', 13, 'yes', 6),
      outcomeLine('acme/widgets', 14, 'no', 8),
      scanLine(),
    ]);
    const items = await outsidePrBacklogItems({ runsDir: dir, now: new Date(NOW) });
    expect(items).toHaveLength(1);
    const prompt = items[0]!.prompt;
    expect(prompt).toContain('Diff-size evidence');
    expect(prompt).toContain('2 of the reverted merges carry journaled diff size (mean 85 lines changed across 4 files)');
    expect(prompt).toContain('rows written before the field existed count in no denominator');
  });

  it('emits nothing below the bar, for a missing journal, or an unreadable one', async () => {
    expect(OUTSIDE_PR_REVERTED_RECURRING).toBe(3);
    const quiet = await runsDir('runs-quiet', [
      outcomeLine('acme/widgets', 21, 'yes', 2),
      outcomeLine('acme/widgets', 22, 'yes', 3),
      outcomeLine('acme/widgets', 23, 'no', 4),
      scanLine(),
    ]);
    expect(await outsidePrBacklogItems({ runsDir: quiet, now: new Date(NOW) })).toEqual([]);

    const empty = await runsDir('runs-empty', null);
    expect(await outsidePrBacklogItems({ runsDir: empty, now: new Date(NOW) })).toEqual([]);
    expect(await outsidePrBacklogItems({ runsDir: join(home, 'no-such'), now: new Date(NOW) })).toEqual([]);

    const bad = join(home, 'runs-bad');
    await mkdir(join(bad, 'metrics', OUTSIDE_PR_OUTCOME_JOURNAL_NAME), { recursive: true });
    expect(await outsidePrBacklogItems({ runsDir: bad, now: new Date(NOW) })).toEqual([]);
  });

  it('emits per-repo items that each carry their own repository target', async () => {
    const dir = await runsDir('runs-two', [
      ...RECURRING,
      outcomeLine('acme/other', 31, 'yes', 2),
      outcomeLine('acme/other', 32, 'yes', 3),
      outcomeLine('acme/other', 33, 'yes', 4),
      outcomeLine('acme/other', 34, 'no', 5),
      scanLine(),
    ]);
    const items = await outsidePrBacklogItems({ runsDir: dir, now: new Date(NOW) });
    expect(items).toHaveLength(2);
    const repos = items.map((i) => i.repo).sort();
    expect(repos).toEqual(['acme/other', 'acme/widgets']);
    expect(items.every((i) => validBacklogItem(i) !== null)).toBe(true);
    const limited = await outsidePrBacklogItems({ runsDir: dir, now: new Date(NOW), limit: 1 });
    expect(limited).toHaveLength(1);
    expect(OUTSIDE_PR_MAX_ITEMS).toBeGreaterThanOrEqual(2);
  });

  it('keeps the newest journaled verdict per PR', async () => {
    const dir = await runsDir('runs-flip', [
      outcomeLine('acme/widgets', 41, 'no', 2, { at: daysAgo(1) }),
      outcomeLine('acme/widgets', 41, 'yes', 2, { at: AT }),
      outcomeLine('acme/widgets', 42, 'yes', 3),
      outcomeLine('acme/widgets', 43, 'yes', 4),
      outcomeLine('acme/widgets', 44, 'yes', 5, { at: daysAgo(0.5) }),
      outcomeLine('acme/widgets', 44, 'no', 5, { at: AT }),
      scanLine(),
    ]);
    const items = await outsidePrBacklogItems({ runsDir: dir, now: new Date(NOW) });
    expect(items).toHaveLength(1);
    // #41 newest=yes, #44 newest=no → reverted are 41,42,43 = 3 of 4.
    expect(items[0]!.prompt).toContain('3 of the recorded 4 outside merges');
  });

  it('states recorded floors and coverage when the journal is partial or degraded', async () => {
    const dir = await runsDir('runs-partial', [
      ...RECURRING,
      'not json at all',
      scanLine({
        sourceState: 'degraded', revertLedger: 'unreadable',
        repos: [{ repo: 'acme/widgets', state: 'degraded', listed: 9, hitLimit: true, prs: 0 }],
      }),
    ]);
    const items = await outsidePrBacklogItems({ runsDir: dir, now: new Date(NOW) });
    expect(items).toHaveLength(1);
    expect(items[0]!.prompt).toContain('at least 3 of the recorded 5 outside merges');
    expect(items[0]!.prompt).toContain("sourceState 'degraded'");
    expect(items[0]!.prompt).toContain("revert ledger read as 'unreadable'");
    expect(items[0]!.prompt).toContain('repo reads were partial: acme/widgets (degraded, gh result limit hit)');
    expect(items[0]!.prompt).toContain('recorded floor');
  });

  it('waits for future revert evidence before surfacing a recurring failure', async () => {
    const later = new Date(NOW + 1);
    const dir = await runsDir('runs-future', [
      outcomeLine('acme/widgets', 41, 'no', 2),
      outcomeLine('acme/widgets', 42, 'yes', 3),
      outcomeLine('acme/widgets', 43, 'yes', 4),
      outcomeLine('acme/widgets', 44, 'no', 5),
      outcomeLine('acme/widgets', 41, 'yes', 2, { at: later.toISOString() }),
    ]);
    expect(await outsidePrBacklogItems({ runsDir: dir, now: new Date(NOW) })).toEqual([]);
    const items = await outsidePrBacklogItems({ runsDir: dir, now: later });
    expect(items).toHaveLength(1);
    expect(items[0]!.prompt).toContain('3 of the recorded 4 outside merges');
  });

  it('derives stable ids per repo so a refresh re-adds nothing', async () => {
    const dir = await runsDir('runs-stable', [...RECURRING, scanLine()]);
    const opts = { runsDir: dir, now: new Date(NOW) };
    const first = await outsidePrBacklogItems(opts);
    const second = await outsidePrBacklogItems(opts);
    expect(first.map((i) => i.id)).toEqual(second.map((i) => i.id));
    expect(first).toHaveLength(1);
  });

  it('appends outside-pr items through discovery and dedupes on refresh', async () => {
    const runs = join(home, '.ashlr-runs');
    await mkdir(join(runs, 'metrics'), { recursive: true });
    await writeFile(join(runs, JOURNAL), [...RECURRING, scanLine()].join('\n') + '\n');
    const greenGh = async (args: string[]) => {
      const p = args[4] ?? '';
      if (p === 'repos/ashlrai/phantom') return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n{"default_branch":"master"}', stderr: '' };
      return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n[]', stderr: '' };
    };
    const first = await discoverBacklog('ashlrai/phantom', { gh: greenGh });
    const prItems = first.items.filter((i) => i.id.startsWith('outside-pr-reverts-'));
    expect(prItems).toHaveLength(1);
    expect(prItems[0]!.repo).toBe('acme/widgets');
    expect(first.items.every((i) => validBacklogItem(i) !== null)).toBe(true);
    expect(appendUserBacklogItems(prItems)).toBe(1);
    const second = await discoverBacklog('ashlrai/phantom', { gh: greenGh });
    expect(appendUserBacklogItems(second.items.filter((i) => i.id.startsWith('outside-pr-reverts-')))).toBe(0);
    expect(readUserBacklogItems().filter((i) => i.id.startsWith('outside-pr-reverts-'))).toHaveLength(1);
  });
});
