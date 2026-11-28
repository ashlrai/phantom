/**
 * outside-pr-held-backlog — merged outside-PR outcomes folded per
 * journaled agent attribution into self-improvement backlog items on
 * the positive (held-clean) side of the verdict.
 *
 * Contract:
 *   - A merge is held-clean only when all three recorded legs stand:
 *     reverted 'no', ci 'success', and a reviews record with latest
 *     above zero. 'unknown' reverts, null ci/reviews records, empty
 *     latestReviews and kept-but-not-clean merges never count toward
 *     the bar.
 *   - An agent cell emits only at OUTSIDE_PR_HELD_RECURRING (3)
 *     held-clean merges inside the 30-day window; merges outside the
 *     window, unattributed rows and dependency-automation slugs
 *     (dependabot, renovate) never count or form a cell.
 *   - The per-repo spread and review/latency/diff evidence quote as
 *     context; evidence tallies cover held merges only.
 *   - Items emit only for the fleet's own repository; ids are stable
 *     per agent slug so a refresh re-adds nothing.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendUserBacklogItems, readUserBacklogItems, validBacklogItem } from '../src/core/cloud/backlog.js';
import {
  foldOutsidePrHeldCells,
  OUTSIDE_PR_HELD_EXCLUDED_AGENTS,
  OUTSIDE_PR_HELD_RECURRING,
  outsidePrHeldBacklogItems,
} from '../src/core/improve/outside-pr-held-backlog.js';
import { OUTSIDE_PR_WINDOW_HOURS } from '../src/core/improve/outside-pr-backlog.js';
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
const FLEET_REPO = 'ashlrai/phantom';

/** Journaled review/CI/diff evidence a held-clean row carries by default. */
const HELD = {
  ci: 'success',
  reviews: { decision: 'APPROVED', latest: 1 },
} as const;

const outcomeLine = (
  repo: string,
  number: number,
  verdict: 'yes' | 'no' | 'unknown',
  mergedDaysAgo: number,
  over: Record<string, unknown> = {},
): string => JSON.stringify({
  v: 1, kind: OUTSIDE_PR_OUTCOME_SCHEMA, at: AT,
  repo, number, title: `outside fix ${number}`, author: 'ext-dev', agent: 'devin', model: null,
  mergedAt: daysAgo(mergedDaysAgo), reverted: verdict,
  createdAt: null, diff: null,
  ...HELD, ...over,
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
  repo, number, title: `fix ${number}`, author: 'ext-dev', agent: 'devin', model: null,
  mergedAt, createdAt: null, diff: null, reverted: verdict,
  ...HELD, ...over,
});

describe('foldOutsidePrHeldCells', () => {
  const opts = { nowMs: NOW, windowHours: OUTSIDE_PR_WINDOW_HOURS };

  it('groups in-window merges per attributed agent with held and context tallies', () => {
    const cells = foldOutsidePrHeldCells([
      row('acme/widgets', 1, 'no', daysAgo(2)),
      row('acme/widgets', 2, 'no', daysAgo(3)),
      row('acme/other', 3, 'no', daysAgo(4)),
      row('acme/other', 4, 'yes', daysAgo(5)),
      row('acme/widgets', 5, 'unknown', daysAgo(6)),
      row('acme/other', 6, 'no', daysAgo(2), { agent: 'cursor' }),
    ], opts);
    expect(cells).toHaveLength(1);
    const cell = cells[0]!;
    expect(cell.agent).toBe('devin');
    expect(cell).toMatchObject({ merged: 5, held: 3, reverted: 1, revertUnknown: 1, keptOther: 0, repos_held: 2 });
    // Held merges span two repos — the cross-repo pattern.
    expect(cell.repos).toEqual([
      { repo: 'acme/widgets', merged: 3, held: 2 },
      { repo: 'acme/other', merged: 2, held: 1 },
    ]);
    expect(cell.authors).toEqual([{ author: 'ext-dev', held: 3 }]);
    expect(cell.examples.map((e) => e.number)).toEqual([1, 2, 3]);
    expect(cell.firstHeld).toBe(daysAgo(4));
    expect(cell.lastHeld).toBe(daysAgo(2));
  });

  it('requires all three legs: ci, reviews and revert verdict must each stand', () => {
    const cells = foldOutsidePrHeldCells([
      // Held-clean.
      row('acme/a', 1, 'no', daysAgo(2)),
      row('acme/b', 2, 'no', daysAgo(3)),
      row('acme/c', 3, 'no', daysAgo(4)),
      // reverted 'no' but ci failed — keptOther, ci leg missed.
      row('acme/d', 4, 'no', daysAgo(5), { ci: 'failure' }),
      // reverted 'no' but empty rollup — keptOther, ci leg missed.
      row('acme/e', 5, 'no', daysAgo(6), { ci: 'none' }),
      // reverted 'no' but null ci — keptOther, missing evidence.
      row('acme/f', 6, 'no', daysAgo(7), { ci: null }),
      // reverted 'no', green CI, but zero recorded reviewers — keptOther.
      row('acme/g', 7, 'no', daysAgo(8), { reviews: { decision: null, latest: 0 } }),
      // reverted 'no', green CI, but null reviews record — keptOther.
      row('acme/h', 8, 'no', daysAgo(9), { reviews: null }),
      // reverted 'yes' with perfect evidence — adverse sibling's signal.
      row('acme/i', 9, 'yes', daysAgo(10)),
      // reverted 'unknown' — never counts anywhere.
      row('acme/j', 10, 'unknown', daysAgo(11)),
    ], opts);
    expect(cells).toHaveLength(1);
    expect(cells[0]).toMatchObject({
      merged: 10, held: 3, reverted: 1, revertUnknown: 1,
      keptOther: 5, keptCiSuccess: 2, keptReviewsKnown: 4, keptReviewed: 3,
    });
  });

  it('drops cells below the recurring bar and merges outside the window', () => {
    const cells = foldOutsidePrHeldCells([
      row('acme/a', 1, 'no', daysAgo(2)),
      row('acme/b', 2, 'no', daysAgo(3)),
      row('acme/c', 3, 'no', daysAgo(OUTSIDE_PR_WINDOW_HOURS / 24 + 1)), // outside 30d
      row('acme/d', 4, 'no', daysAgo(2), { agent: 'cursor' }),
      row('acme/e', 5, 'no', daysAgo(3), { agent: 'cursor' }),
      row('acme/f', 6, 'yes', daysAgo(4), { agent: 'cursor' }),
    ], opts);
    expect(OUTSIDE_PR_HELD_RECURRING).toBe(3);
    expect(cells).toEqual([]);
  });

  it('never counts unknown revert verdicts toward the bar', () => {
    const cells = foldOutsidePrHeldCells([
      row('acme/a', 1, 'unknown', daysAgo(2)),
      row('acme/b', 2, 'unknown', daysAgo(3)),
      row('acme/c', 3, 'unknown', daysAgo(4)),
      row('acme/d', 4, 'unknown', daysAgo(5)),
    ], opts);
    expect(cells).toEqual([]);
  });

  it('forms no cell for unattributed or dependency-automation rows', () => {
    const cells = foldOutsidePrHeldCells([
      row('acme/a', 1, 'no', daysAgo(2), { agent: null }),
      row('acme/b', 2, 'no', daysAgo(3), { agent: null }),
      row('acme/c', 3, 'no', daysAgo(4), { agent: null }),
      row('acme/d', 4, 'no', daysAgo(5), { agent: null }),
      // dependabot/renovate held merges are version bumps — non-study subjects.
      row('acme/e', 5, 'no', daysAgo(6), { agent: 'dependabot' }),
      row('acme/f', 6, 'no', daysAgo(7), { agent: 'dependabot' }),
      row('acme/g', 7, 'no', daysAgo(8), { agent: 'renovate' }),
      row('acme/h', 8, 'no', daysAgo(9), { agent: 'renovate' }),
    ], opts);
    expect(cells).toEqual([]);
    expect(OUTSIDE_PR_HELD_EXCLUDED_AGENTS.has('dependabot')).toBe(true);
    expect(OUTSIDE_PR_HELD_EXCLUDED_AGENTS.has('renovate')).toBe(true);
  });

  it('skips rows whose mergedAt does not parse', () => {
    const cells = foldOutsidePrHeldCells([
      row('acme/a', 1, 'no', 'not a date'),
      row('acme/b', 2, 'no', daysAgo(2)),
      row('acme/c', 3, 'no', daysAgo(3)),
      row('acme/d', 4, 'no', daysAgo(4)),
    ], opts);
    expect(cells).toHaveLength(1);
    expect(cells[0]!.merged).toBe(3);
    expect(cells[0]!.held).toBe(3);
  });

  it('tallies held merges\' open→merge latency, decision and diff evidence only', () => {
    const cells = foldOutsidePrHeldCells([
      row('acme/a', 1, 'no', daysAgo(2), {
        createdAt: new Date(NOW - 2 * DAY - 120 * MIN).toISOString(),
        reviews: { decision: 'APPROVED', latest: 2 },
        diff: { additions: 100, deletions: 20, changedFiles: 5 },
      }),
      row('acme/b', 2, 'no', daysAgo(3), {
        createdAt: new Date(NOW - 3 * DAY - 60 * MIN).toISOString(),
        reviews: { decision: null, latest: 1 },
        diff: { additions: 40, deletions: 10, changedFiles: 3 },
      }),
      // Held but pre-fields: counts toward held, no evidence denominator.
      row('acme/c', 3, 'no', daysAgo(4), { createdAt: null, diff: null, reviews: { decision: 'REVIEW_REQUIRED', latest: 1 } }),
      // Kept-but-not-clean rows' evidence is denominator context only — never tallied here.
      row('acme/d', 4, 'no', daysAgo(5), {
        ci: 'failure',
        createdAt: new Date(NOW - 5 * DAY - 30 * MIN).toISOString(),
        reviews: { decision: 'CHANGES_REQUESTED', latest: 3 },
        diff: { additions: 999, deletions: 0, changedFiles: 9 },
      }),
    ], opts);
    expect(cells).toHaveLength(1);
    expect(cells[0]).toMatchObject({
      merged: 4, held: 3, keptOther: 1,
      ttm_known: 2, ttm_minutes_mean: 90,
      diff_known: 2, diff_lines_mean: 85, diff_files_mean: 4,
      approved: 1, changesRequested: 0, reviewRequired: 1, undecided: 1,
    });
  });

  it('never counts merges stamped past the evaluation-time future skew', () => {
    const future = new Date(NOW + 2 * 3_600_000).toISOString();
    expect(foldOutsidePrHeldCells([
      row('acme/a', 1, 'no', future),
      row('acme/b', 2, 'no', future),
      row('acme/c', 3, 'no', future),
    ], opts)).toEqual([]);
    // Inside the one-minute skew the stamp still counts as clock drift.
    const cells = foldOutsidePrHeldCells([
      row('acme/a', 4, 'no', daysAgo(2)),
      row('acme/b', 5, 'no', daysAgo(3)),
      row('acme/c', 6, 'no', new Date(NOW + 30_000).toISOString()),
    ], opts);
    expect(cells).toHaveLength(1);
    expect(cells[0]!.held).toBe(3);
  });
});

describe('outsidePrHeldBacklogItems', () => {
  let home: string;
  let saved: { HOME?: string; ASHLR_HOME?: string; ASHLR_RUNS_DIR?: string };

  beforeEach(async () => {
    saved = { HOME: process.env.HOME, ASHLR_HOME: process.env.ASHLR_HOME, ASHLR_RUNS_DIR: process.env.ASHLR_RUNS_DIR };
    delete process.env.ASHLR_HOME;
    delete process.env.ASHLR_RUNS_DIR;
    home = await mkdtemp(join(tmpdir(), 'outside-pr-held-backlog-'));
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
    outcomeLine('acme/widgets', 11, 'no', 2),
    outcomeLine('acme/other', 12, 'no', 4),
    outcomeLine('acme/third', 13, 'no', 6),
    outcomeLine('acme/widgets', 14, 'yes', 8),
    outcomeLine('acme/other', 15, 'unknown', 10),
  ];

  it('emits one fleet-repo item per recurring held agent and validates it', async () => {
    const dir = await runsDir('runs-hit', [
      ...RECURRING,
      outcomeLine('acme/misc', 16, 'no', 3, { agent: 'cursor' }),
      outcomeLine('acme/misc', 17, 'no', 5, { agent: 'cursor' }),
      scanLine(),
    ]);
    const items = await outsidePrHeldBacklogItems({ repo: FLEET_REPO, runsDir: dir, now: new Date(NOW) });
    expect(items).toHaveLength(1);
    const [item] = items;
    expect(item).toMatchObject({ priority: 3, repo: FLEET_REPO, area: 'outside-prs' });
    expect(item!.id).toMatch(/^outside-pr-agent-held-[0-9a-f]{16}$/);
    expect(item!.title).toContain("'devin'");
    expect(validBacklogItem(item)).not.toBeNull();
    expect(item!.prompt).toContain("3 of the recorded 5 outside merges inside the 720-hour window meet the held-clean bar");
    expect(item!.prompt).toContain("5 outside merges attributed to 'devin'");
    expect(item!.prompt).toContain('1 carrying a standing revert verdict');
    expect(item!.prompt).toContain("1 with an 'unknown' revert verdict");
    expect(item!.prompt).toContain('acme/widgets (1 held of 2)');
    expect(item!.prompt).toContain('acme/other (1 held of 2)');
    expect(item!.prompt).toContain('acme/third (1 held of 1)');
    expect(item!.prompt).toContain('the held merges span 3 repositories');
    expect(item!.prompt).toContain('unattributed');
    expect(item!.prompt).toContain('model is never recorded');
    expect(item!.prompt).toContain('outside-pr-outcomes.jsonl');
    expect(item!.prompt).toContain('phm fleet outside-outcomes');
    expect(item!.prompt).toContain('no-change');
    // 'unknown' and healthy coverage are context, not caveats.
    expect(item!.prompt).not.toContain('Coverage:');
  });

  it('emits nothing for a non-fleet repository', async () => {
    const dir = await runsDir('runs-elsewhere', [...RECURRING, scanLine()]);
    expect(await outsidePrHeldBacklogItems({ repo: 'acme/widgets', runsDir: dir, now: new Date(NOW) })).toEqual([]);
    expect(await outsidePrHeldBacklogItems({ repo: '', runsDir: dir, now: new Date(NOW) })).toEqual([]);
  });

  it('emits nothing below the bar, for a missing journal, or an unreadable one', async () => {
    const quiet = await runsDir('runs-quiet', [
      outcomeLine('acme/a', 21, 'no', 2),
      outcomeLine('acme/b', 22, 'no', 3),
      outcomeLine('acme/c', 23, 'yes', 4),
      outcomeLine('acme/d', 24, 'no', 5, { ci: 'failure' }),
      scanLine(),
    ]);
    expect(await outsidePrHeldBacklogItems({ repo: FLEET_REPO, runsDir: quiet, now: new Date(NOW) })).toEqual([]);

    const empty = await runsDir('runs-empty', null);
    expect(await outsidePrHeldBacklogItems({ repo: FLEET_REPO, runsDir: empty, now: new Date(NOW) })).toEqual([]);
    expect(await outsidePrHeldBacklogItems({ repo: FLEET_REPO, runsDir: join(home, 'no-such'), now: new Date(NOW) })).toEqual([]);

    const bad = join(home, 'runs-bad');
    await mkdir(join(bad, 'metrics', OUTSIDE_PR_OUTCOME_JOURNAL_NAME), { recursive: true });
    expect(await outsidePrHeldBacklogItems({ repo: FLEET_REPO, runsDir: bad, now: new Date(NOW) })).toEqual([]);
  });

  it('keeps the newest journaled verdict per PR', async () => {
    const dir = await runsDir('runs-flip', [
      outcomeLine('acme/a', 41, 'no', 2, { at: daysAgo(1) }),
      outcomeLine('acme/a', 41, 'yes', 2, { at: AT }),
      outcomeLine('acme/b', 42, 'no', 3),
      outcomeLine('acme/c', 43, 'no', 4),
      outcomeLine('acme/d', 44, 'no', 5, { at: daysAgo(0.5), ci: 'failure' }),
      outcomeLine('acme/d', 44, 'no', 5, { at: AT }),
      scanLine(),
    ]);
    const items = await outsidePrHeldBacklogItems({ repo: FLEET_REPO, runsDir: dir, now: new Date(NOW) });
    expect(items).toHaveLength(1);
    // #41 newest=yes (reverted), #44 newest=no+green (held) → held are 42,43,44 = 3 of 4.
    expect(items[0]!.prompt).toContain('3 of the recorded 4 outside merges');
    expect(items[0]!.prompt).toContain('1 carrying a standing revert verdict');
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
    const items = await outsidePrHeldBacklogItems({ repo: FLEET_REPO, runsDir: dir, now: new Date(NOW) });
    expect(items).toHaveLength(1);
    expect(items[0]!.prompt).toContain("at least 3 of the recorded 5 outside merges");
    expect(items[0]!.prompt).toContain("sourceState 'degraded'");
    expect(items[0]!.prompt).toContain("revert ledger read as 'unreadable'");
    expect(items[0]!.prompt).toContain('repo reads were partial: acme/widgets (degraded, gh result limit hit)');
    expect(items[0]!.prompt).toContain('recorded floor');
  });

  it('quotes single-repo concentration as the sibling-covered reading', async () => {
    const dir = await runsDir('runs-single', [
      outcomeLine('acme/widgets', 51, 'no', 2),
      outcomeLine('acme/widgets', 52, 'no', 3),
      outcomeLine('acme/widgets', 53, 'no', 4),
      outcomeLine('acme/widgets', 54, 'yes', 5),
      scanLine(),
    ]);
    const items = await outsidePrHeldBacklogItems({ repo: FLEET_REPO, runsDir: dir, now: new Date(NOW) });
    expect(items).toHaveLength(1);
    expect(items[0]!.prompt).toContain('acme/widgets (3 held of 4)');
    expect(items[0]!.prompt).toContain('every held merge landed on that one repository');
    expect(items[0]!.prompt).toContain('the sibling per-repo feeds');
  });

  it('quotes kept-but-not-clean merges with their evidence legs', async () => {
    const dir = await runsDir('runs-kept', [
      outcomeLine('acme/a', 61, 'no', 2),
      outcomeLine('acme/b', 62, 'no', 3),
      outcomeLine('acme/c', 63, 'no', 4),
      // Kept but CI red — missing a held leg.
      outcomeLine('acme/d', 64, 'no', 5, { ci: 'failure', reviews: { decision: 'APPROVED', latest: 2 } }),
      // Kept but zero recorded reviewers.
      outcomeLine('acme/e', 65, 'no', 6, { reviews: { decision: null, latest: 0 } }),
      // Kept but no review record at all.
      outcomeLine('acme/f', 66, 'no', 7, { reviews: null }),
      scanLine(),
    ]);
    const items = await outsidePrHeldBacklogItems({ repo: FLEET_REPO, runsDir: dir, now: new Date(NOW) });
    expect(items).toHaveLength(1);
    expect(items[0]!.prompt).toContain('3 of the recorded 6 outside merges');
    expect(items[0]!.prompt).toContain('3 standing without a revert but missing a held leg');
    expect(items[0]!.prompt).toContain('2 of those with a green CI verdict');
    expect(items[0]!.prompt).toContain('2 carrying review evidence (1 with at least one recorded reviewer)');
  });

  it('derives stable ids per agent so a refresh re-adds nothing', async () => {
    const dir = await runsDir('runs-stable', [...RECURRING, scanLine()]);
    const opts = { repo: FLEET_REPO, runsDir: dir, now: new Date(NOW) };
    const first = await outsidePrHeldBacklogItems(opts);
    const second = await outsidePrHeldBacklogItems(opts);
    expect(first.map((i) => i.id)).toEqual(second.map((i) => i.id));
    expect(first).toHaveLength(1);
  });

  it('appends held items through discovery and dedupes on refresh', async () => {
    const runs = join(home, '.ashlr-runs');
    await mkdir(join(runs, 'metrics'), { recursive: true });
    await writeFile(join(runs, JOURNAL), [...RECURRING, scanLine()].join('\n') + '\n');
    const greenGh = async (args: string[]) => {
      const p = args[4] ?? '';
      if (p === 'repos/ashlrai/phantom') return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n{"default_branch":"master"}', stderr: '' };
      return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n[]', stderr: '' };
    };
    const first = await discoverBacklog(FLEET_REPO, { gh: greenGh });
    const heldItems = first.items.filter((i) => i.id.startsWith('outside-pr-agent-held-'));
    expect(heldItems).toHaveLength(1);
    expect(heldItems[0]!.repo).toBe(FLEET_REPO);
    expect(first.items.every((i) => validBacklogItem(i) !== null)).toBe(true);
    expect(appendUserBacklogItems(heldItems)).toBe(1);
    const second = await discoverBacklog(FLEET_REPO, { gh: greenGh });
    expect(appendUserBacklogItems(second.items.filter((i) => i.id.startsWith('outside-pr-agent-held-')))).toBe(0);
    expect(readUserBacklogItems().filter((i) => i.id.startsWith('outside-pr-agent-held-'))).toHaveLength(1);
  });
});
