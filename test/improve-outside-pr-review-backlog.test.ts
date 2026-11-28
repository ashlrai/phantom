/**
 * outside-pr-review-backlog — merged outside-PR review-coverage outcomes
 * folded into self-improvement backlog items.
 *
 * Contract:
 *   - A repo cell emits only at OUTSIDE_PR_REVIEW_RECURRING (3) outside
 *     merges inside the 30-day window whose newest journaled row carries
 *     review evidence with `latest === 0` (gh returned an empty
 *     latestReviews array — a real "merged unreviewed" signal);
 *     `reviews === null` (missing evidence), `latest > 0` (reviewed)
 *     and merges outside the window never count toward the bar.
 *   - Items self-target the outside PRs' own repository (owner/name),
 *     unlike the sibling machinery feeds that gate on the fleet repo.
 *   - The newest journaled row per PR wins; counts quote recorded
 *     floors when the tail truncated or lines were ignored; degraded
 *     scan coverage is named in the prompt.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendUserBacklogItems, readUserBacklogItems, validBacklogItem } from '../src/core/cloud/backlog.js';
import {
  foldOutsidePrReviewCells,
  OUTSIDE_PR_REVIEW_MAX_ITEMS,
  OUTSIDE_PR_REVIEW_RECURRING,
  outsidePrReviewBacklogItems,
} from '../src/core/improve/outside-pr-review-backlog.js';
import { OUTSIDE_PR_WINDOW_HOURS } from '../src/core/improve/outside-pr-backlog.js';
import { discoverBacklog } from '../src/core/improve/discover.js';
import {
  OUTSIDE_PR_OUTCOME_JOURNAL_NAME,
  OUTSIDE_PR_OUTCOME_SCHEMA,
  OUTSIDE_PR_SCAN_SCHEMA,
  type OutsidePrOutcomeJournalRow,
} from '../src/core/fleet/outside-pr-outcome-ledger.js';
import type { OutsidePrReviewDecision, OutsidePrReviewEvidence } from '../src/core/fleet/outside-pr-outcomes.js';

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const NOW = Date.now();
const AT = new Date(NOW).toISOString();
const daysAgo = (days: number): string => new Date(NOW - days * DAY).toISOString();

const JOURNAL = join('metrics', OUTSIDE_PR_OUTCOME_JOURNAL_NAME);

const outcomeLine = (
  repo: string,
  number: number,
  reviews: OutsidePrReviewEvidence | null,
  mergedDaysAgo: number,
  over: Record<string, unknown> = {},
): string => JSON.stringify({
  v: 1, kind: OUTSIDE_PR_OUTCOME_SCHEMA, at: AT,
  repo, number, title: `outside fix ${number}`, author: 'ext-dev', agent: null, model: null,
  mergedAt: daysAgo(mergedDaysAgo), reverted: 'no', reviews, ...over,
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
  reviews: OutsidePrReviewEvidence | null,
  mergedAt: string,
  over: Partial<OutsidePrOutcomeJournalRow> = {},
): OutsidePrOutcomeJournalRow => ({
  v: 1, kind: OUTSIDE_PR_OUTCOME_SCHEMA, at: AT,
  repo, number, title: `fix ${number}`, author: 'ext-dev', agent: null, model: null,
  mergedAt, createdAt: null, reviews, ci: null, diff: null, reverted: 'no', ...over,
});

const unreviewed = (decision: OutsidePrReviewDecision | null = null): OutsidePrReviewEvidence => ({ decision, latest: 0 });
const reviewed = (decision: OutsidePrReviewDecision | null = 'APPROVED', latest = 1): OutsidePrReviewEvidence => ({ decision, latest });

describe('foldOutsidePrReviewCells', () => {
  const opts = { nowMs: NOW, windowHours: OUTSIDE_PR_WINDOW_HOURS };

  it('groups in-window merges per repo with review tallies and quoted evidence', () => {
    const cells = foldOutsidePrReviewCells([
      row('acme/widgets', 1, unreviewed(), daysAgo(2), { agent: 'devin' }),
      row('acme/widgets', 2, unreviewed('REVIEW_REQUIRED'), daysAgo(3), { agent: 'devin' }),
      row('acme/widgets', 3, unreviewed(), daysAgo(4)),
      row('acme/widgets', 4, reviewed(), daysAgo(5)),
      row('acme/widgets', 5, null, daysAgo(6)),
      row('acme/other', 6, unreviewed(), daysAgo(2)),
    ], opts);
    expect(cells).toHaveLength(1);
    const cell = cells[0]!;
    expect(cell.repo).toBe('acme/widgets');
    expect(cell).toMatchObject({
      merged: 5, unreviewed: 3, reviewed: 1,
      reviewsKnown: 4, reviewsUnknown: 1,
      approved: 1, changesRequested: 0, reviewRequired: 1, undecided: 2,
      unreviewedReverted: 0,
    });
    expect(cell.authors).toEqual([{ author: 'ext-dev', unreviewed: 3 }]);
    // Unreviewed merges tally by journaled agent attribution; unattributed is its own bucket.
    expect(cell.agents).toEqual([
      { agent: 'devin', unreviewed: 2 },
      { agent: null, unreviewed: 1 },
    ]);
    expect(cell.examples.map((e) => e.number)).toEqual([1, 2, 3]);
    expect(cell.examples.map((e) => e.decision)).toEqual([null, 'REVIEW_REQUIRED', null]);
    expect(cell.firstUnreviewed).toBe(daysAgo(4));
    expect(cell.lastUnreviewed).toBe(daysAgo(2));
  });

  it('drops cells below the recurring bar and merges outside the window', () => {
    expect(OUTSIDE_PR_REVIEW_RECURRING).toBe(3);
    const cells = foldOutsidePrReviewCells([
      row('acme/widgets', 1, unreviewed(), daysAgo(2)),
      row('acme/widgets', 2, unreviewed(), daysAgo(3)),
      row('acme/widgets', 3, unreviewed(), daysAgo(OUTSIDE_PR_WINDOW_HOURS / 24 + 1)), // outside 30d
      row('acme/quiet', 4, unreviewed(), daysAgo(2)),
      row('acme/quiet', 5, unreviewed(), daysAgo(3)),
      row('acme/quiet', 6, reviewed(), daysAgo(4)),
    ], opts);
    expect(cells).toEqual([]);
  });

  it('never counts reviewed or missing review evidence toward the bar', () => {
    const cells = foldOutsidePrReviewCells([
      row('acme/widgets', 1, unreviewed(), daysAgo(2)),
      row('acme/widgets', 2, unreviewed(), daysAgo(3)),
      row('acme/widgets', 3, reviewed('APPROVED'), daysAgo(4)),
      row('acme/widgets', 4, reviewed('CHANGES_REQUESTED'), daysAgo(5)),
      row('acme/widgets', 5, null, daysAgo(6)),
    ], opts);
    expect(cells).toEqual([]);
  });

  it('skips rows whose mergedAt does not parse', () => {
    const cells = foldOutsidePrReviewCells([
      row('acme/widgets', 1, unreviewed(), 'not a date'),
      row('acme/widgets', 2, unreviewed(), daysAgo(2)),
      row('acme/widgets', 3, unreviewed(), daysAgo(3)),
      row('acme/widgets', 4, unreviewed(), daysAgo(4)),
    ], opts);
    expect(cells).toHaveLength(1);
    expect(cells[0]!.merged).toBe(3);
    expect(cells[0]!.unreviewed).toBe(3);
  });

  it('tallies unreviewed merges\' standing revert verdicts as corroboration only', () => {
    const cells = foldOutsidePrReviewCells([
      row('acme/widgets', 1, unreviewed(), daysAgo(2), { reverted: 'yes' }),
      row('acme/widgets', 2, unreviewed(), daysAgo(3), { reverted: 'yes' }),
      row('acme/widgets', 3, unreviewed('REVIEW_REQUIRED'), daysAgo(4), { reverted: 'unknown' }),
      row('acme/widgets', 4, reviewed(), daysAgo(5), { reverted: 'yes' }),
    ], opts);
    expect(cells).toHaveLength(1);
    expect(cells[0]).toMatchObject({ unreviewed: 3, unreviewedReverted: 2 });
    // The reviewed row's revert never enters the unreviewed corroboration count.
    expect(cells[0]!.examples.map((e) => e.reverted)).toEqual(['yes', 'yes', 'unknown']);
  });

  it('never counts merges stamped past the evaluation-time future skew', () => {
    const future = new Date(NOW + 2 * 3_600_000).toISOString();
    // All three unreviewed merges carry a future mergedAt: corrupt or
    // replayed evidence, no cell.
    expect(foldOutsidePrReviewCells([
      row('acme/widgets', 1, unreviewed(), future),
      row('acme/widgets', 2, unreviewed(), future),
      row('acme/widgets', 3, unreviewed(), future),
    ], opts)).toEqual([]);
    // Inside the one-minute skew the stamp still counts as clock drift.
    const cells = foldOutsidePrReviewCells([
      row('acme/widgets', 4, unreviewed(), daysAgo(2)),
      row('acme/widgets', 5, unreviewed(), daysAgo(3)),
      row('acme/widgets', 6, unreviewed(), new Date(NOW + 30_000).toISOString()),
    ], opts);
    expect(cells).toHaveLength(1);
    expect(cells[0]!.unreviewed).toBe(3);
  });
});

describe('outsidePrReviewBacklogItems', () => {
  let home: string;
  let saved: { HOME?: string; ASHLR_HOME?: string; ASHLR_RUNS_DIR?: string };

  beforeEach(async () => {
    saved = { HOME: process.env.HOME, ASHLR_HOME: process.env.ASHLR_HOME, ASHLR_RUNS_DIR: process.env.ASHLR_RUNS_DIR };
    delete process.env.ASHLR_HOME;
    delete process.env.ASHLR_RUNS_DIR;
    home = await mkdtemp(join(tmpdir(), 'outside-pr-review-backlog-'));
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
    outcomeLine('acme/widgets', 11, unreviewed(), 2),
    outcomeLine('acme/widgets', 12, unreviewed('REVIEW_REQUIRED'), 4),
    outcomeLine('acme/widgets', 13, unreviewed(), 6),
    outcomeLine('acme/widgets', 14, reviewed('APPROVED'), 8),
    outcomeLine('acme/widgets', 15, null, 10),
  ];

  it('emits one self-targeted item per recurring repo and validates it', async () => {
    const dir = await runsDir('runs-hit', [
      outcomeLine('acme/widgets', 11, unreviewed(), 2, { agent: 'devin' }),
      outcomeLine('acme/widgets', 12, unreviewed('REVIEW_REQUIRED'), 4, { agent: 'cursor' }),
      outcomeLine('acme/widgets', 13, unreviewed(), 6),
      outcomeLine('acme/widgets', 14, reviewed('APPROVED'), 8),
      outcomeLine('acme/widgets', 15, null, 10),
      scanLine(),
    ]);
    const items = await outsidePrReviewBacklogItems({ runsDir: dir, now: new Date(NOW) });
    expect(items).toHaveLength(1);
    const [item] = items;
    expect(item).toMatchObject({ priority: 3, repo: 'acme/widgets', area: 'outside-prs' });
    expect(item!.id).toMatch(/^outside-pr-review-[0-9a-f]{16}$/);
    expect(item!.title).toContain('acme/widgets');
    expect(validBacklogItem(item)).not.toBeNull();
    expect(item!.prompt).toContain('3 of the recorded 5 outside merges');
    expect(item!.prompt).toContain('zero reviewers');
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
    // Review-evidence denominators, decision tallies and healthy coverage are context, not caveats.
    expect(item!.prompt).toContain('4 of the recorded merges carry journaled review evidence');
    expect(item!.prompt).toContain('1 APPROVED');
    expect(item!.prompt).toContain('1 REVIEW_REQUIRED');
    expect(item!.prompt).toContain('2 with no usable decision');
    expect(item!.prompt).toContain('1 with no journaled review evidence');
    expect(item!.prompt).not.toContain('Coverage:');
  });

  it('quotes unreviewed merges\' standing revert verdicts as corroboration', async () => {
    const dir = await runsDir('runs-reverted', [
      outcomeLine('acme/widgets', 11, unreviewed(), 2, { reverted: 'yes' }),
      outcomeLine('acme/widgets', 12, unreviewed(), 4, { reverted: 'yes' }),
      outcomeLine('acme/widgets', 13, unreviewed(), 6, { reverted: 'no' }),
      outcomeLine('acme/widgets', 14, reviewed(), 8, { reverted: 'yes' }),
      scanLine(),
    ]);
    const items = await outsidePrReviewBacklogItems({ runsDir: dir, now: new Date(NOW) });
    expect(items).toHaveLength(1);
    const prompt = items[0]!.prompt;
    expect(prompt).toContain('2 of the unreviewed merges now stand reverted');
    expect(prompt).toContain('now standing reverted');
    // The reviewed merge's revert is the sibling feeds' signal, not this one's.
    expect(prompt).not.toContain('3 of the unreviewed merges now stand reverted');
  });

  it('emits nothing below the bar, for a missing journal, or an unreadable one', async () => {
    expect(OUTSIDE_PR_REVIEW_RECURRING).toBe(3);
    const quiet = await runsDir('runs-quiet', [
      outcomeLine('acme/widgets', 21, unreviewed(), 2),
      outcomeLine('acme/widgets', 22, unreviewed(), 3),
      outcomeLine('acme/widgets', 23, reviewed(), 4),
      scanLine(),
    ]);
    expect(await outsidePrReviewBacklogItems({ runsDir: quiet, now: new Date(NOW) })).toEqual([]);

    const reviewedAll = await runsDir('runs-reviewed', [
      outcomeLine('acme/widgets', 24, reviewed('APPROVED'), 2),
      outcomeLine('acme/widgets', 25, reviewed('APPROVED'), 3),
      outcomeLine('acme/widgets', 26, reviewed('REVIEW_REQUIRED'), 4),
      outcomeLine('acme/widgets', 27, null, 5),
      scanLine(),
    ]);
    expect(await outsidePrReviewBacklogItems({ runsDir: reviewedAll, now: new Date(NOW) })).toEqual([]);

    const empty = await runsDir('runs-empty', null);
    expect(await outsidePrReviewBacklogItems({ runsDir: empty, now: new Date(NOW) })).toEqual([]);
    expect(await outsidePrReviewBacklogItems({ runsDir: join(home, 'no-such'), now: new Date(NOW) })).toEqual([]);

    const bad = join(home, 'runs-bad');
    await mkdir(join(bad, 'metrics', OUTSIDE_PR_OUTCOME_JOURNAL_NAME), { recursive: true });
    expect(await outsidePrReviewBacklogItems({ runsDir: bad, now: new Date(NOW) })).toEqual([]);
  });

  it('emits per-repo items that each carry their own repository target', async () => {
    const dir = await runsDir('runs-two', [
      ...RECURRING,
      outcomeLine('acme/other', 31, unreviewed(), 2),
      outcomeLine('acme/other', 32, unreviewed(), 3),
      outcomeLine('acme/other', 33, unreviewed(), 4),
      outcomeLine('acme/other', 34, reviewed(), 5),
      scanLine(),
    ]);
    const items = await outsidePrReviewBacklogItems({ runsDir: dir, now: new Date(NOW) });
    expect(items).toHaveLength(2);
    const repos = items.map((i) => i.repo).sort();
    expect(repos).toEqual(['acme/other', 'acme/widgets']);
    expect(items.every((i) => validBacklogItem(i) !== null)).toBe(true);
    const limited = await outsidePrReviewBacklogItems({ runsDir: dir, now: new Date(NOW), limit: 1 });
    expect(limited).toHaveLength(1);
    expect(OUTSIDE_PR_REVIEW_MAX_ITEMS).toBeGreaterThanOrEqual(2);
  });

  it('keeps the newest journaled row per PR', async () => {
    const dir = await runsDir('runs-flip', [
      outcomeLine('acme/widgets', 41, reviewed(), 2, { at: daysAgo(1) }),
      outcomeLine('acme/widgets', 41, unreviewed(), 2, { at: AT }),
      outcomeLine('acme/widgets', 42, unreviewed(), 3),
      outcomeLine('acme/widgets', 43, unreviewed(), 4),
      outcomeLine('acme/widgets', 44, unreviewed(), 5, { at: daysAgo(0.5) }),
      outcomeLine('acme/widgets', 44, reviewed(), 5, { at: AT }),
      scanLine(),
    ]);
    const items = await outsidePrReviewBacklogItems({ runsDir: dir, now: new Date(NOW) });
    expect(items).toHaveLength(1);
    // #41 newest=unreviewed, #44 newest=reviewed → unreviewed are 41,42,43 = 3 of 4.
    expect(items[0]!.prompt).toContain('3 of the recorded 4 outside merges');
    expect(items[0]!.prompt).toContain('3 of those gh returned zero reviewers, 1 at least one');
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
    const items = await outsidePrReviewBacklogItems({ runsDir: dir, now: new Date(NOW) });
    expect(items).toHaveLength(1);
    expect(items[0]!.prompt).toContain('at least 3 of the recorded 5 outside merges');
    expect(items[0]!.prompt).toContain("sourceState 'degraded'");
    expect(items[0]!.prompt).toContain("revert ledger read as 'unreadable'");
    expect(items[0]!.prompt).toContain('repo reads were partial: acme/widgets (degraded, gh result limit hit)');
    expect(items[0]!.prompt).toContain('recorded floor');
  });

  it('waits for future review evidence before surfacing a recurring failure', async () => {
    const later = new Date(NOW + 1);
    const dir = await runsDir('runs-future', [
      outcomeLine('acme/widgets', 41, reviewed(), 2),
      outcomeLine('acme/widgets', 42, unreviewed(), 3),
      outcomeLine('acme/widgets', 43, unreviewed(), 4),
      outcomeLine('acme/widgets', 44, reviewed(), 5),
      outcomeLine('acme/widgets', 41, unreviewed(), 2, { at: later.toISOString() }),
    ]);
    expect(await outsidePrReviewBacklogItems({ runsDir: dir, now: new Date(NOW) })).toEqual([]);
    const items = await outsidePrReviewBacklogItems({ runsDir: dir, now: later });
    expect(items).toHaveLength(1);
    expect(items[0]!.prompt).toContain('3 of the recorded 4 outside merges');
  });

  it('derives stable ids per repo so a refresh re-adds nothing', async () => {
    const dir = await runsDir('runs-stable', [...RECURRING, scanLine()]);
    const opts = { runsDir: dir, now: new Date(NOW) };
    const first = await outsidePrReviewBacklogItems(opts);
    const second = await outsidePrReviewBacklogItems(opts);
    expect(first.map((i) => i.id)).toEqual(second.map((i) => i.id));
    expect(first).toHaveLength(1);
  });

  it('appends outside-pr review items through discovery and dedupes on refresh', async () => {
    const runs = join(home, '.ashlr-runs');
    await mkdir(join(runs, 'metrics'), { recursive: true });
    await writeFile(join(runs, JOURNAL), [...RECURRING, scanLine()].join('\n') + '\n');
    const greenGh = async (args: string[]) => {
      const p = args[4] ?? '';
      if (p === 'repos/ashlrai/phantom') return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n{"default_branch":"master"}', stderr: '' };
      return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n[]', stderr: '' };
    };
    const first = await discoverBacklog('ashlrai/phantom', { gh: greenGh });
    const reviewItems = first.items.filter((i) => i.id.startsWith('outside-pr-review-'));
    expect(reviewItems).toHaveLength(1);
    expect(reviewItems[0]!.repo).toBe('acme/widgets');
    expect(first.items.every((i) => validBacklogItem(i) !== null)).toBe(true);
    expect(appendUserBacklogItems(reviewItems)).toBe(1);
    const second = await discoverBacklog('ashlrai/phantom', { gh: greenGh });
    expect(appendUserBacklogItems(second.items.filter((i) => i.id.startsWith('outside-pr-review-')))).toBe(0);
    expect(readUserBacklogItems().filter((i) => i.id.startsWith('outside-pr-review-'))).toHaveLength(1);
  });
});
