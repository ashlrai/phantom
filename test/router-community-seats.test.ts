import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { cmdFleetRouterWeights } from '../src/cli/fleet-router-weights.js';
import {
  COMMUNITY_SEATS_DEFAULT_WINDOW_DAYS,
  COMMUNITY_SEATS_JOURNAL_MAX_BYTES,
  foldCommunitySeats,
  readOutsidePrCommunitySeats,
} from '../src/core/router/community-seats.js';
import { readRouterOutcomes } from '../src/core/router/outcomes.js';
import { buildRouterWeightProposalReport } from '../src/core/router/weight-proposals.js';
import {
  OUTSIDE_PR_OUTCOME_JOURNAL_NAME,
  OUTSIDE_PR_OUTCOME_SCHEMA,
  OUTSIDE_PR_SCAN_SCHEMA,
  type OutsidePrOutcomeJournalRow,
} from '../src/core/fleet/outside-pr-outcome-ledger.js';

// Community-seat outcome evidence: the outside-PR journal
// (metrics/outside-pr-outcomes.jsonl) folded into per-attributed-agent
// tallies on the advisory router-weight report. Outside PRs carry no
// lane/work_class, so the tallies are advisory context only — they never
// enter a (work_class, lane) proposal group. Fixtures are synthetic;
// HOME/ASHLR_HOME are temp dirs so every read stays hermetic.

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const NOW = Date.now();
const AT = new Date(NOW).toISOString();
const daysAgo = (days: number): string => new Date(NOW - days * DAY).toISOString();

let root: string;
let runs: string;
let logged: string[];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'router-community-seats-'));
  runs = join(root, 'runs');
  mkdirSync(join(runs, 'metrics'), { recursive: true });
  vi.stubEnv('HOME', join(root, 'home'));
  vi.stubEnv('ASHLR_HOME', join(root, 'ashlr'));
  logged = [];
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { logged.push(a.map(String).join(' ')); });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

const journalPath = (): string => join(runs, 'metrics', OUTSIDE_PR_OUTCOME_JOURNAL_NAME);
const writeJournal = (lines: (string | object)[]): void =>
  writeFileSync(journalPath(), lines.map(l => typeof l === 'string' ? l : JSON.stringify(l)).join('\n') + '\n');
const ledgerPath = (): string => join(runs, 'metrics', 'jobs.jsonl');
const writeLedger = (rows: object[]): void =>
  writeFileSync(ledgerPath(), rows.map(r => JSON.stringify(r)).join('\n') + '\n');

/** A fleet.outside-pr-outcome.v1 row in the shape outside-outcome-sync.ts appends. */
const outcomeLine = (
  repo: string,
  number: number,
  verdict: 'yes' | 'no' | 'unknown',
  agent: string | null,
  mergedDaysAgo: number,
  over: Record<string, unknown> = {},
): object => ({
  v: 1, kind: OUTSIDE_PR_OUTCOME_SCHEMA, at: AT,
  repo, number, title: `outside fix ${number}`, author: 'ext-dev', agent, model: null,
  mergedAt: daysAgo(mergedDaysAgo), reverted: verdict, ...over,
});

/** A fleet.outside-pr-scan.v1 coverage receipt in the shape the sync appends. */
const scanLine = (over: Record<string, unknown> = {}): object => ({
  v: 1, kind: OUTSIDE_PR_SCAN_SCHEMA, at: AT,
  sourceState: 'healthy', windowDays: 30, since: daysAgo(30), revertLedger: 'read',
  repos: [{ repo: 'acme/widgets', state: 'healthy', listed: 5, hitLimit: false, prs: 5 }],
  ...over,
});

const row = (
  repo: string,
  number: number,
  verdict: 'yes' | 'no' | 'unknown',
  agent: string | null,
  mergedAt: string,
  over: Partial<OutsidePrOutcomeJournalRow> = {},
): OutsidePrOutcomeJournalRow => ({
  v: 1, kind: OUTSIDE_PR_OUTCOME_SCHEMA, at: AT,
  repo, number, title: `fix ${number}`, author: 'ext-dev', agent, model: null,
  mergedAt, createdAt: null, reviews: null, ci: null, diff: null, reverted: verdict, ...over,
});

/** The evidence tallies every seat reports when its journaled rows carry no createdAt/reviews/ci/diff. */
const NO_EVIDENCE = {
  ttm_known: 0, ttm_minutes_mean: null,
  reviews_known: 0, reviewed: 0, unreviewed: 0,
  approved: 0, changes_requested: 0, review_required: 0,
  ci_known: 0, ci_passed: 0, ci_failed: 0, ci_pending: 0, ci_none: 0,
  diff_known: 0, diff_lines_mean: null, diff_files_mean: null,
};

describe('foldCommunitySeats', () => {
  const opts = { nowMs: NOW, windowDays: COMMUNITY_SEATS_DEFAULT_WINDOW_DAYS };

  it('groups in-window merges per attributed agent with verdict tallies and repo counts', () => {
    const seats = foldCommunitySeats([
      row('acme/widgets', 1, 'yes', 'devin', daysAgo(2)),
      row('acme/widgets', 2, 'no', 'devin', daysAgo(3)),
      row('acme/other', 3, 'yes', 'devin', daysAgo(4)),
      row('acme/widgets', 4, 'yes', 'cursor', daysAgo(5)),
      row('acme/widgets', 5, 'unknown', null, daysAgo(6)),
      row('acme/widgets', 6, 'no', null, daysAgo(7)),
    ], opts);
    expect(seats).toEqual([
      { agent: 'devin', model: null, repos: 2, prs: 3, reverted: 2, kept: 1, unknown: 0, ...NO_EVIDENCE },
      { agent: null, model: null, repos: 1, prs: 2, reverted: 0, kept: 1, unknown: 1, ...NO_EVIDENCE },
      { agent: 'cursor', model: null, repos: 1, prs: 1, reverted: 1, kept: 0, unknown: 0, ...NO_EVIDENCE },
    ]);
  });

  it('tallies journaled open→merge latency and review evidence with honest denominators', () => {
    const seats = foldCommunitySeats([
      // devin #1: opened 2h before merge, two reviewers, APPROVED.
      row('acme/widgets', 1, 'yes', 'devin', daysAgo(2), {
        createdAt: new Date(NOW - 2 * DAY - 120 * MIN).toISOString(),
        reviews: { decision: 'APPROVED', latest: 2 },
      }),
      // devin #2: opened 1h before merge, gh returned zero reviewers — a real unreviewed signal.
      row('acme/widgets', 2, 'no', 'devin', daysAgo(4), {
        createdAt: new Date(NOW - 4 * DAY - 60 * MIN).toISOString(),
        reviews: { decision: null, latest: 0 },
      }),
      // devin #3: pre-fields row — counts toward prs but neither evidence denominator.
      row('acme/widgets', 3, 'yes', 'devin', daysAgo(6)),
      // cursor #4: createdAt parses after mergedAt (corrupt) → no ttm; CHANGES_REQUESTED stands.
      row('acme/widgets', 4, 'yes', 'cursor', daysAgo(8), {
        createdAt: new Date(NOW - 8 * DAY + 60 * MIN).toISOString(),
        reviews: { decision: 'CHANGES_REQUESTED', latest: 1 },
      }),
    ], opts);
    expect(seats).toEqual([
      {
        agent: 'devin', model: null, repos: 1, prs: 3, reverted: 2, kept: 1, unknown: 0,
        ttm_known: 2, ttm_minutes_mean: 90,
        reviews_known: 2, reviewed: 1, unreviewed: 1,
        approved: 1, changes_requested: 0, review_required: 0,
        ci_known: 0, ci_passed: 0, ci_failed: 0, ci_pending: 0, ci_none: 0,
        diff_known: 0, diff_lines_mean: null, diff_files_mean: null,
      },
      {
        agent: 'cursor', model: null, repos: 1, prs: 1, reverted: 1, kept: 0, unknown: 0,
        ttm_known: 0, ttm_minutes_mean: null,
        reviews_known: 1, reviewed: 1, unreviewed: 0,
        approved: 0, changes_requested: 1, review_required: 0,
        ci_known: 0, ci_passed: 0, ci_failed: 0, ci_pending: 0, ci_none: 0,
        diff_known: 0, diff_lines_mean: null, diff_files_mean: null,
      },
    ]);
  });

  it('tallies journaled CI verdicts per seat with an honest denominator', () => {
    const seats = foldCommunitySeats([
      // devin: one of each recorded verdict plus a null-ci pre-fields row.
      row('acme/widgets', 1, 'no', 'devin', daysAgo(2), { ci: 'success' }),
      row('acme/widgets', 2, 'yes', 'devin', daysAgo(3), { ci: 'failure' }),
      row('acme/widgets', 3, 'no', 'devin', daysAgo(4), { ci: 'pending' }),
      row('acme/widgets', 4, 'no', 'devin', daysAgo(5), { ci: 'none' }),
      row('acme/widgets', 5, 'no', 'devin', daysAgo(6)),
      // cursor: only null-ci rows — the denominator stays empty, never a guessed zero.
      row('acme/widgets', 6, 'no', 'cursor', daysAgo(7)),
      row('acme/widgets', 7, 'no', 'cursor', daysAgo(8), { ci: null }),
    ], opts);
    expect(seats).toEqual([
      {
        agent: 'devin', model: null, repos: 1, prs: 5, reverted: 1, kept: 4, unknown: 0,
        ...NO_EVIDENCE,
        ci_known: 4, ci_passed: 1, ci_failed: 1, ci_pending: 1, ci_none: 1,
      },
      {
        agent: 'cursor', model: null, repos: 1, prs: 2, reverted: 0, kept: 2, unknown: 0,
        ...NO_EVIDENCE,
      },
    ]);
  });

  it('tallies journaled diff size per seat with an honest denominator', () => {
    const seats = foldCommunitySeats([
      // devin: two recorded diffs (10+4 lines over 2 files; 30+6 lines over
      // 3 files → means 25 lines / 2.5 files) plus a pre-fields null row.
      row('acme/widgets', 1, 'no', 'devin', daysAgo(2), { diff: { additions: 10, deletions: 4, changedFiles: 2 } }),
      row('acme/widgets', 2, 'yes', 'devin', daysAgo(3), { diff: { additions: 30, deletions: 6, changedFiles: 3 } }),
      row('acme/widgets', 3, 'no', 'devin', daysAgo(4)),
      // cursor: only null-diff rows — the denominator stays empty, never a guessed zero.
      row('acme/widgets', 4, 'no', 'cursor', daysAgo(5)),
      row('acme/widgets', 5, 'no', 'cursor', daysAgo(6), { diff: null }),
    ], opts);
    expect(seats).toEqual([
      {
        agent: 'devin', model: null, repos: 1, prs: 3, reverted: 1, kept: 2, unknown: 0,
        ...NO_EVIDENCE,
        diff_known: 2, diff_lines_mean: 25, diff_files_mean: 2.5,
      },
      {
        agent: 'cursor', model: null, repos: 1, prs: 2, reverted: 0, kept: 2, unknown: 0,
        ...NO_EVIDENCE,
      },
    ]);
  });

  it('windows on mergedAt and never counts merges stamped past the future skew', () => {
    const seats = foldCommunitySeats([
      row('acme/widgets', 1, 'yes', 'devin', daysAgo(COMMUNITY_SEATS_DEFAULT_WINDOW_DAYS + 1)),
      row('acme/widgets', 2, 'yes', 'devin', daysAgo(2)),
      row('acme/widgets', 3, 'yes', 'devin', new Date(NOW + 2 * 3_600_000).toISOString()),
      row('acme/widgets', 4, 'yes', 'devin', 'not a date'),
      row('acme/widgets', 5, 'yes', 'devin', new Date(NOW + 30_000).toISOString()),
    ], opts);
    // Only #2 (in window) and #5 (inside the one-minute skew) count.
    expect(seats).toEqual([
      { agent: 'devin', model: null, repos: 1, prs: 2, reverted: 2, kept: 0, unknown: 0, ...NO_EVIDENCE },
    ]);
  });

  it('honors a wider evidence window', () => {
    const seats = foldCommunitySeats([
      row('acme/widgets', 1, 'yes', 'devin', daysAgo(45)),
      row('acme/widgets', 2, 'yes', 'devin', daysAgo(2)),
    ], { nowMs: NOW, windowDays: 60 });
    expect(seats[0]).toMatchObject({ agent: 'devin', prs: 2, reverted: 2 });
  });
});

describe('readOutsidePrCommunitySeats', () => {
  it('reports a missing journal as state missing with no seats', async () => {
    const read = await readOutsidePrCommunitySeats({ runsDir: runs, now: new Date(NOW) });
    expect(read).toMatchObject({
      state: 'missing', truncated: false, ignored_rows: null,
      window_days: COMMUNITY_SEATS_DEFAULT_WINDOW_DAYS, seats: [], coverage: null,
    });
    expect(read.path).toBe(journalPath());
    expect(Date.parse(read.since)).toBe(NOW - COMMUNITY_SEATS_DEFAULT_WINDOW_DAYS * DAY);
  });

  it('folds journaled outcome rows into per-agent seats and carries scan coverage', async () => {
    writeJournal([
      outcomeLine('acme/widgets', 11, 'yes', 'devin', 2),
      outcomeLine('acme/widgets', 12, 'no', 'devin', 4),
      outcomeLine('acme/other', 13, 'yes', 'cursor', 6),
      outcomeLine('acme/widgets', 14, 'unknown', null, 8),
      'not json at all',
      scanLine({
        sourceState: 'degraded', revertLedger: 'unreadable',
        repos: [
          { repo: 'acme/widgets', state: 'degraded', listed: 9, hitLimit: true, prs: 0 },
          { repo: 'acme/other', state: 'healthy', listed: 3, hitLimit: false, prs: 3 },
        ],
      }),
    ]);
    const read = await readOutsidePrCommunitySeats({ runsDir: runs, now: new Date(NOW) });
    expect(read.state).toBe('read');
    expect(read.truncated).toBe(false);
    expect(read.ignored_rows).toBe(1);
    expect(read.seats).toEqual([
      { agent: 'devin', model: null, repos: 1, prs: 2, reverted: 1, kept: 1, unknown: 0, ...NO_EVIDENCE },
      { agent: null, model: null, repos: 1, prs: 1, reverted: 0, kept: 0, unknown: 1, ...NO_EVIDENCE },
      { agent: 'cursor', model: null, repos: 1, prs: 1, reverted: 1, kept: 0, unknown: 0, ...NO_EVIDENCE },
    ]);
    expect(read.coverage).toEqual({
      source_state: 'degraded', revert_ledger: 'unreadable', degraded_repos: ['acme/widgets'],
    });
  });

  it('reports null coverage when no scan row parsed', async () => {
    writeJournal([outcomeLine('acme/widgets', 11, 'yes', 'devin', 2)]);
    const read = await readOutsidePrCommunitySeats({ runsDir: runs, now: new Date(NOW) });
    expect(read.state).toBe('read');
    expect(read.coverage).toBeNull();
  });

  it('selects verdicts and coverage from receipts visible at report time', async () => {
    const later = new Date(NOW + 1);
    writeJournal([
      outcomeLine('acme/widgets', 11, 'no', 'devin', 2),
      scanLine(),
      outcomeLine('acme/widgets', 11, 'yes', 'devin', 2, { at: later.toISOString() }),
      scanLine({ at: later.toISOString(), sourceState: 'degraded' }),
      outcomeLine('acme/widgets', 11, 'unknown', 'devin', 2, { at: 'invalid' }),
      scanLine({ at: 'invalid' }),
    ]);
    const before = await readOutsidePrCommunitySeats({ runsDir: runs, now: new Date(NOW) });
    expect(before.seats).toMatchObject([{ prs: 1, kept: 1, reverted: 0 }]);
    expect(before.coverage?.source_state).toBe('healthy');
    expect(before.ignored_rows).toBe(2);

    const after = await readOutsidePrCommunitySeats({ runsDir: runs, now: later });
    expect(after.seats).toMatchObject([{ prs: 1, kept: 0, reverted: 1 }]);
    expect(after.coverage?.source_state).toBe('degraded');
  });

  it('marks a cut tail truncated while still folding the retained rows', async () => {
    // A padding line larger than the tail bound pushes the window into it;
    // the valid rows written after it stay inside the retained bytes.
    writeJournal([
      'x'.repeat(COMMUNITY_SEATS_JOURNAL_MAX_BYTES + 1024),
      outcomeLine('acme/widgets', 11, 'yes', 'devin', 2),
      outcomeLine('acme/widgets', 12, 'no', 'devin', 4),
      scanLine(),
    ]);
    const read = await readOutsidePrCommunitySeats({ runsDir: runs, now: new Date(NOW) });
    expect(read.state).toBe('read');
    expect(read.truncated).toBe(true);
    expect(read.seats).toEqual([
      { agent: 'devin', model: null, repos: 1, prs: 2, reverted: 1, kept: 1, unknown: 0, ...NO_EVIDENCE },
    ]);
  });

  it('rejects a non-absolute runsDir', async () => {
    await expect(readOutsidePrCommunitySeats({ runsDir: 'relative/dir' })).rejects.toThrow(RangeError);
  });
});

describe('router weight proposal report', () => {
  const asOf = '2026-02-01T00:00:00.000Z';

  it('carries community-seat state and tallies when supplied', async () => {
    writeLedger([{ job: 'j1', lane: 'alpha', phase: 'MERGED' }]);
    writeJournal([
      outcomeLine('acme/widgets', 11, 'yes', 'devin', 2),
      outcomeLine('acme/widgets', 12, 'no', 'devin', 4),
      scanLine(),
    ]);
    const read = await readRouterOutcomes({ runsDir: runs });
    const seats = await readOutsidePrCommunitySeats({ runsDir: runs, now: new Date(NOW) });
    const report = buildRouterWeightProposalReport(read, asOf, { communitySeats: seats });
    expect(report.community_seats_state).toBe('read');
    expect(report.community_seats_truncated).toBe(false);
    expect(report.community_seats_ignored).toBe(0);
    expect(report.community_seats_window_days).toBe(COMMUNITY_SEATS_DEFAULT_WINDOW_DAYS);
    expect(report.community_seats).toEqual([
      { agent: 'devin', model: null, repos: 1, prs: 2, reverted: 1, kept: 1, unknown: 0, ...NO_EVIDENCE },
    ]);
    expect(report.community_seats_coverage).toMatchObject({ source_state: 'healthy', revert_ledger: 'read' });
  });

  it('reports unreported when no community-seat read is supplied, and null tallies on degraded states', async () => {
    writeLedger([{ job: 'j1', lane: 'alpha', phase: 'MERGED' }]);
    const read = await readRouterOutcomes({ runsDir: runs });
    const bare = buildRouterWeightProposalReport(read, asOf);
    expect(bare).toMatchObject({
      community_seats_state: 'unreported', community_seats: null,
      community_seats_coverage: null, community_seats_truncated: false,
      community_seats_ignored: null, community_seats_window_days: null,
    });
    const missing = buildRouterWeightProposalReport(read, asOf, {
      communitySeats: await readOutsidePrCommunitySeats({ runsDir: runs, now: new Date(NOW) }),
    });
    expect(missing).toMatchObject({ community_seats_state: 'missing', community_seats: null });
  });

  it('still reports community seats when the jobs ledger itself is unavailable', async () => {
    writeJournal([outcomeLine('acme/widgets', 11, 'yes', 'devin', 2), scanLine()]);
    const read = await readRouterOutcomes({ runsDir: join(root, 'empty-runs') });
    expect(read.state).not.toBe('read');
    const report = buildRouterWeightProposalReport(read, asOf, {
      communitySeats: await readOutsidePrCommunitySeats({ runsDir: runs, now: new Date(NOW) }),
    });
    expect(report.status).toBe('unavailable');
    expect(report.community_seats_state).toBe('read');
    expect(report.community_seats).toHaveLength(1);
  });
});

describe('phm fleet router-weights', () => {
  it('joins community-seat tallies into the JSON report and renders them in text', async () => {
    writeLedger([{ job: 'j1', lane: 'alpha', work_class: 'code', phase: 'MERGED' }]);
    writeJournal([
      // devin #11 carries recorded open/review/CI/diff evidence; #12 and
      // the unattributed #13 are pre-fields rows — honest unknown
      // denominators.
      outcomeLine('acme/widgets', 11, 'yes', 'devin', 2, {
        createdAt: new Date(NOW - 2 * DAY - 90 * MIN).toISOString(),
        reviews: { decision: 'APPROVED', latest: 1 },
        ci: 'success',
        diff: { additions: 40, deletions: 10, changedFiles: 4 },
      }),
      outcomeLine('acme/widgets', 12, 'no', 'devin', 4),
      outcomeLine('acme/widgets', 13, 'unknown', null, 6),
      scanLine(),
    ]);
    logged = [];
    const code = await cmdFleetRouterWeights(['--runs-dir', runs, '--json']);
    expect(code).toBe(0);
    const report = JSON.parse(logged.join('\n'));
    expect(report.community_seats_state).toBe('read');
    expect(report.community_seats).toEqual([
      {
        agent: 'devin', model: null, repos: 1, prs: 2, reverted: 1, kept: 1, unknown: 0,
        ttm_known: 1, ttm_minutes_mean: 90,
        reviews_known: 1, reviewed: 1, unreviewed: 0,
        approved: 1, changes_requested: 0, review_required: 0,
        ci_known: 1, ci_passed: 1, ci_failed: 0, ci_pending: 0, ci_none: 0,
        diff_known: 1, diff_lines_mean: 50, diff_files_mean: 4,
      },
      { agent: null, model: null, repos: 1, prs: 1, reverted: 0, kept: 0, unknown: 1, ...NO_EVIDENCE },
    ]);

    logged = [];
    const textCode = await cmdFleetRouterWeights(['--runs-dir', runs]);
    expect(textCode).toBe(0);
    const out = logged.join('\n');
    expect(out).toContain('community_seats=read');
    expect(out).toContain('community seats (outside-pr-outcomes.jsonl');
    expect(out).toContain('devin: prs=2 reverted=1 kept=1 unknown=0 repos=1 ttm=90m mean over 1 merges reviews=1 reviewed/0 unreviewed/1 approved/0 changes-requested/0 review-required over 1 merges ci=1 green/0 red/0 pending/0 no-checks over 1 merges diff=50 lines/4 files mean over 1 merges');
    expect(out).toContain('unattributed: prs=1 reverted=0 kept=0 unknown=1 repos=1 ttm=unknown reviews=unknown ci=unknown diff=unknown');
    expect(out).toContain('model is never recorded');
  });

  it('reports a missing community journal as coverage, never as zero seats', async () => {
    writeLedger([{ job: 'j1', lane: 'alpha', phase: 'MERGED' }]);
    logged = [];
    const code = await cmdFleetRouterWeights(['--runs-dir', runs]);
    expect(code).toBe(0);
    const out = logged.join('\n');
    expect(out).toContain('community_seats=missing');
    expect(out).toContain('community-seat coverage: outside-pr-outcomes.jsonl missing');
    expect(out).not.toContain('no outside merges journaled inside the window');
  });
});
