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
): OutsidePrOutcomeJournalRow => ({
  v: 1, kind: OUTSIDE_PR_OUTCOME_SCHEMA, at: AT,
  repo, number, title: `fix ${number}`, author: 'ext-dev', agent, model: null,
  mergedAt, reverted: verdict,
});

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
      { agent: 'devin', model: null, repos: 2, prs: 3, reverted: 2, kept: 1, unknown: 0 },
      { agent: null, model: null, repos: 1, prs: 2, reverted: 0, kept: 1, unknown: 1 },
      { agent: 'cursor', model: null, repos: 1, prs: 1, reverted: 1, kept: 0, unknown: 0 },
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
      { agent: 'devin', model: null, repos: 1, prs: 2, reverted: 2, kept: 0, unknown: 0 },
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
      { agent: 'devin', model: null, repos: 1, prs: 2, reverted: 1, kept: 1, unknown: 0 },
      { agent: null, model: null, repos: 1, prs: 1, reverted: 0, kept: 0, unknown: 1 },
      { agent: 'cursor', model: null, repos: 1, prs: 1, reverted: 1, kept: 0, unknown: 0 },
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
      { agent: 'devin', model: null, repos: 1, prs: 2, reverted: 1, kept: 1, unknown: 0 },
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
      { agent: 'devin', model: null, repos: 1, prs: 2, reverted: 1, kept: 1, unknown: 0 },
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
      outcomeLine('acme/widgets', 11, 'yes', 'devin', 2),
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
      { agent: 'devin', model: null, repos: 1, prs: 2, reverted: 1, kept: 1, unknown: 0 },
      { agent: null, model: null, repos: 1, prs: 1, reverted: 0, kept: 0, unknown: 1 },
    ]);

    logged = [];
    const textCode = await cmdFleetRouterWeights(['--runs-dir', runs]);
    expect(textCode).toBe(0);
    const out = logged.join('\n');
    expect(out).toContain('community_seats=read');
    expect(out).toContain('community seats (outside-pr-outcomes.jsonl');
    expect(out).toContain('devin: prs=2 reverted=1 kept=1 unknown=0 repos=1');
    expect(out).toContain('unattributed: prs=1 reverted=0 kept=0 unknown=1 repos=1');
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
