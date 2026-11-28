/**
 * outside-pr-diff-backlog — merged outside-PR merge-size outcomes folded
 * into self-improvement backlog items.
 *
 * Contract:
 *   - A repo cell emits only at OUTSIDE_PR_DIFF_RECURRING (3) outside
 *     merges inside the 30-day window whose newest journaled row carries
 *     a `diff` triple that is oversized (additions+deletions >=
 *     OUTSIDE_PR_DIFF_LINES or changedFiles >= OUTSIDE_PR_DIFF_FILES),
 *     AND only when oversized merges are at least half of the repo's
 *     diff-evidenced merges; `diff === null` (missing evidence), sized
 *     merges and merges outside the window never count toward the bar.
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
  foldOutsidePrDiffCells,
  OUTSIDE_PR_DIFF_FILES,
  OUTSIDE_PR_DIFF_LINES,
  OUTSIDE_PR_DIFF_MAX_ITEMS,
  OUTSIDE_PR_DIFF_RECURRING,
  outsidePrDiffBacklogItems,
} from '../src/core/improve/outside-pr-diff-backlog.js';
import { OUTSIDE_PR_WINDOW_HOURS } from '../src/core/improve/outside-pr-backlog.js';
import { discoverBacklog } from '../src/core/improve/discover.js';
import {
  OUTSIDE_PR_OUTCOME_JOURNAL_NAME,
  OUTSIDE_PR_OUTCOME_SCHEMA,
  OUTSIDE_PR_SCAN_SCHEMA,
  type OutsidePrOutcomeJournalRow,
} from '../src/core/fleet/outside-pr-outcome-ledger.js';
import type { OutsidePrDiffEvidence } from '../src/core/fleet/outside-pr-outcomes.js';

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const NOW = Date.now();
const AT = new Date(NOW).toISOString();
const daysAgo = (days: number): string => new Date(NOW - days * DAY).toISOString();

const JOURNAL = join('metrics', OUTSIDE_PR_OUTCOME_JOURNAL_NAME);

/** A diff triple over the changed-lines bound only (files within bounds). */
const bigLines = (): OutsidePrDiffEvidence => ({ additions: 1500, deletions: 600, changedFiles: 10 });
/** A diff triple over the changed-files bound only (lines within bounds). */
const bigFiles = (): OutsidePrDiffEvidence => ({ additions: 100, deletions: 50, changedFiles: 45 });
/** A diff triple over both bounds. */
const bigBoth = (): OutsidePrDiffEvidence => ({ additions: 1200, deletions: 900, changedFiles: 50 });
/** A diff triple within both bounds — a normally sized merge. */
const sized = (): OutsidePrDiffEvidence => ({ additions: 100, deletions: 50, changedFiles: 5 });

const outcomeLine = (
  repo: string,
  number: number,
  diff: OutsidePrDiffEvidence | null,
  mergedDaysAgo: number,
  over: Record<string, unknown> = {},
): string => JSON.stringify({
  v: 1, kind: OUTSIDE_PR_OUTCOME_SCHEMA, at: AT,
  repo, number, title: `outside fix ${number}`, author: 'ext-dev', agent: null, model: null,
  mergedAt: daysAgo(mergedDaysAgo), reverted: 'no', diff, ...over,
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
  diff: OutsidePrDiffEvidence | null,
  mergedAt: string,
  over: Partial<OutsidePrOutcomeJournalRow> = {},
): OutsidePrOutcomeJournalRow => ({
  v: 1, kind: OUTSIDE_PR_OUTCOME_SCHEMA, at: AT,
  repo, number, title: `fix ${number}`, author: 'ext-dev', agent: null, model: null,
  mergedAt, createdAt: null, reviews: null, ci: null, diff, reverted: 'no', ...over,
});

describe('foldOutsidePrDiffCells', () => {
  const opts = { nowMs: NOW, windowHours: OUTSIDE_PR_WINDOW_HOURS };

  it('groups in-window merges per repo with diff tallies and quoted evidence', () => {
    const cells = foldOutsidePrDiffCells([
      row('acme/widgets', 1, bigLines(), daysAgo(2), { agent: 'devin' }),
      row('acme/widgets', 2, bigFiles(), daysAgo(3), { agent: 'devin' }),
      row('acme/widgets', 3, bigBoth(), daysAgo(4)),
      row('acme/widgets', 4, sized(), daysAgo(5)),
      row('acme/widgets', 5, null, daysAgo(6)),
      row('acme/other', 6, bigLines(), daysAgo(2)),
    ], opts);
    // acme/widgets: 3 oversized of 4 diff-known (share 3/4 >= half) emits;
    // acme/other has a single oversized merge — below the recurring bar.
    expect(cells).toHaveLength(1);
    const cell = cells[0]!;
    expect(cell.repo).toBe('acme/widgets');
    expect(cell).toMatchObject({
      merged: 5, oversized: 3, diffKnown: 4, diffUnknown: 1, sized: 1,
      // bigLines over lines only, bigFiles over files only, bigBoth over both.
      overLines: 2, overFiles: 2, oversizedReverted: 0,
    });
    expect(cell.authors).toEqual([{ author: 'ext-dev', oversized: 3 }]);
    // Oversized merges tally by journaled agent attribution; unattributed is its own bucket.
    expect(cell.agents).toEqual([
      { agent: 'devin', oversized: 2 },
      { agent: null, oversized: 1 },
    ]);
    expect(cell.examples.map((e) => e.number)).toEqual([1, 2, 3]);
    // The examples quote the recorded line/file counts.
    expect(cell.examples[0]).toMatchObject({ number: 1, lines: 2100, files: 10 });
    expect(cell.examples[1]).toMatchObject({ number: 2, lines: 150, files: 45 });
    expect(cell.examples[2]).toMatchObject({ number: 3, lines: 2100, files: 50 });
    expect(cell.firstOversized).toBe(daysAgo(4));
    expect(cell.lastOversized).toBe(daysAgo(2));
  });

  it('drops cells below the recurring bar', () => {
    expect(OUTSIDE_PR_DIFF_RECURRING).toBe(3);
    const cells = foldOutsidePrDiffCells([
      row('acme/widgets', 1, bigLines(), daysAgo(2)),
      row('acme/widgets', 2, bigFiles(), daysAgo(3)),
      row('acme/widgets', 3, sized(), daysAgo(4)),
      row('acme/widgets', 4, sized(), daysAgo(5)),
      row('acme/quiet', 5, bigLines(), daysAgo(2)),
      row('acme/quiet', 6, bigLines(), daysAgo(3)),
      row('acme/quiet', 7, sized(), daysAgo(4)),
    ], opts);
    // widgets has only 2 oversized (below 3); quiet has 2 oversized too.
    expect(cells).toEqual([]);
  });

  it('drops cells where oversized merges are less than half of diff-evidenced merges', () => {
    // Three oversized but four sized: oversized*2 = 6 < diffKnown 7 —
    // a few large changes among many small ones is not a repo pattern.
    const cells = foldOutsidePrDiffCells([
      row('acme/widgets', 1, bigLines(), daysAgo(2)),
      row('acme/widgets', 2, bigFiles(), daysAgo(3)),
      row('acme/widgets', 3, bigBoth(), daysAgo(4)),
      row('acme/widgets', 4, sized(), daysAgo(5)),
      row('acme/widgets', 5, sized(), daysAgo(6)),
      row('acme/widgets', 6, sized(), daysAgo(7)),
      row('acme/widgets', 7, sized(), daysAgo(8)),
    ], opts);
    expect(cells).toEqual([]);
    // At exactly half it emits: 4 oversized of 8 diff-known.
    const half = foldOutsidePrDiffCells([
      row('acme/widgets', 1, bigLines(), daysAgo(2)),
      row('acme/widgets', 2, bigFiles(), daysAgo(3)),
      row('acme/widgets', 3, bigBoth(), daysAgo(4)),
      row('acme/widgets', 8, bigLines(), daysAgo(5)),
      row('acme/widgets', 4, sized(), daysAgo(6)),
      row('acme/widgets', 5, sized(), daysAgo(7)),
      row('acme/widgets', 6, sized(), daysAgo(8)),
      row('acme/widgets', 7, sized(), daysAgo(9)),
    ], opts);
    expect(half).toHaveLength(1);
    expect(half[0]).toMatchObject({ oversized: 4, diffKnown: 8, sized: 4 });
  });

  it('never counts missing diff evidence toward the bar', () => {
    const cells = foldOutsidePrDiffCells([
      row('acme/widgets', 1, bigLines(), daysAgo(2)),
      row('acme/widgets', 2, bigFiles(), daysAgo(3)),
      row('acme/widgets', 3, bigBoth(), daysAgo(4)),
      row('acme/widgets', 4, null, daysAgo(5)),
      row('acme/widgets', 5, null, daysAgo(6)),
      row('acme/widgets', 6, null, daysAgo(7)),
    ], opts);
    expect(cells).toHaveLength(1);
    // Three oversized of three diff-known (all oversized) emits; the
    // three null-diff rows are context and never enter either side.
    expect(cells[0]).toMatchObject({ oversized: 3, diffKnown: 3, diffUnknown: 3, sized: 0 });
  });

  it('counts a merge at either size bound as oversized and just below as sized', () => {
    // Exactly at the changed-lines bound, files below: oversized via lines.
    const atLines: OutsidePrDiffEvidence = { additions: OUTSIDE_PR_DIFF_LINES - 100, deletions: 100, changedFiles: 1 };
    // Exactly at the changed-files bound, lines below: oversized via files.
    const atFiles: OutsidePrDiffEvidence = { additions: 10, deletions: 5, changedFiles: OUTSIDE_PR_DIFF_FILES };
    // Just below both bounds: sized.
    const below: OutsidePrDiffEvidence = { additions: OUTSIDE_PR_DIFF_LINES - 101, deletions: 100, changedFiles: OUTSIDE_PR_DIFF_FILES - 1 };
    const cells = foldOutsidePrDiffCells([
      row('acme/widgets', 1, atLines, daysAgo(2)),
      row('acme/widgets', 2, atFiles, daysAgo(3)),
      row('acme/widgets', 3, bigBoth(), daysAgo(4)),
      row('acme/widgets', 4, below, daysAgo(5)),
    ], opts);
    expect(cells).toHaveLength(1);
    expect(cells[0]).toMatchObject({ oversized: 3, sized: 1, overLines: 2, overFiles: 2 });
  });

  it('skips rows whose mergedAt does not parse', () => {
    const cells = foldOutsidePrDiffCells([
      row('acme/widgets', 1, bigLines(), 'not a date'),
      row('acme/widgets', 2, bigLines(), daysAgo(2)),
      row('acme/widgets', 3, bigFiles(), daysAgo(3)),
      row('acme/widgets', 4, bigBoth(), daysAgo(4)),
    ], opts);
    expect(cells).toHaveLength(1);
    expect(cells[0]!.merged).toBe(3);
    expect(cells[0]!.oversized).toBe(3);
  });

  it('tallies oversized merges\' standing revert verdicts as corroboration only', () => {
    const cells = foldOutsidePrDiffCells([
      row('acme/widgets', 1, bigLines(), daysAgo(2), { reverted: 'yes' }),
      row('acme/widgets', 2, bigFiles(), daysAgo(3), { reverted: 'yes' }),
      row('acme/widgets', 3, bigBoth(), daysAgo(4), { reverted: 'unknown' }),
      row('acme/widgets', 4, sized(), daysAgo(5), { reverted: 'yes' }),
    ], opts);
    expect(cells).toHaveLength(1);
    expect(cells[0]).toMatchObject({ oversized: 3, oversizedReverted: 2 });
    // The sized row's revert never enters the oversized corroboration count.
    expect(cells[0]!.examples.map((e) => e.reverted)).toEqual(['yes', 'yes', 'unknown']);
  });

  it('never counts merges stamped past the evaluation-time future skew', () => {
    const future = new Date(NOW + 2 * 3_600_000).toISOString();
    // All three oversized merges carry a future mergedAt: corrupt or
    // replayed evidence, no cell.
    expect(foldOutsidePrDiffCells([
      row('acme/widgets', 1, bigLines(), future),
      row('acme/widgets', 2, bigFiles(), future),
      row('acme/widgets', 3, bigBoth(), future),
    ], opts)).toEqual([]);
    // Inside the one-minute skew the stamp still counts as clock drift.
    const cells = foldOutsidePrDiffCells([
      row('acme/widgets', 4, bigLines(), daysAgo(2)),
      row('acme/widgets', 5, bigFiles(), daysAgo(3)),
      row('acme/widgets', 6, bigBoth(), new Date(NOW + 30_000).toISOString()),
    ], opts);
    expect(cells).toHaveLength(1);
    expect(cells[0]!.oversized).toBe(3);
  });
});

describe('outsidePrDiffBacklogItems', () => {
  let home: string;
  let saved: { HOME?: string; ASHLR_HOME?: string; ASHLR_RUNS_DIR?: string };

  beforeEach(async () => {
    saved = { HOME: process.env.HOME, ASHLR_HOME: process.env.ASHLR_HOME, ASHLR_RUNS_DIR: process.env.ASHLR_RUNS_DIR };
    delete process.env.ASHLR_HOME;
    delete process.env.ASHLR_RUNS_DIR;
    home = await mkdtemp(join(tmpdir(), 'outside-pr-diff-backlog-'));
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

  // 3 oversized of 4 diff-known (one sized, one diff-unknown) → emits.
  const RECURRING = [
    outcomeLine('acme/widgets', 11, bigLines(), 2, { agent: 'devin' }),
    outcomeLine('acme/widgets', 12, bigFiles(), 4, { agent: 'cursor' }),
    outcomeLine('acme/widgets', 13, bigBoth(), 6),
    outcomeLine('acme/widgets', 14, sized(), 8),
    outcomeLine('acme/widgets', 15, null, 10),
  ];

  it('emits one self-targeted item per recurring repo and validates it', async () => {
    const dir = await runsDir('runs-hit', [...RECURRING, scanLine()]);
    const items = await outsidePrDiffBacklogItems({ runsDir: dir, now: new Date(NOW) });
    expect(items).toHaveLength(1);
    const [item] = items;
    expect(item).toMatchObject({ priority: 3, repo: 'acme/widgets', area: 'outside-prs' });
    expect(item!.id).toMatch(/^outside-pr-diff-[0-9a-f]{16}$/);
    expect(item!.title).toContain('acme/widgets');
    expect(validBacklogItem(item)).not.toBeNull();
    expect(item!.prompt).toContain('3 of the recorded 5 outside merges');
    expect(item!.prompt).toContain('oversized');
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
    // Size-evidence denominators and healthy coverage are context, not caveats.
    expect(item!.prompt).toContain('4 of the recorded merges carry journaled diff size');
    expect(item!.prompt).toContain('3 of those oversized');
    expect(item!.prompt).toContain('1 sized within bounds');
    expect(item!.prompt).toContain('1 with no journaled diff evidence');
    expect(item!.prompt).not.toContain('Coverage:');
  });

  it('quotes oversized merges\' standing revert verdicts as corroboration', async () => {
    const dir = await runsDir('runs-reverted', [
      outcomeLine('acme/widgets', 11, bigLines(), 2, { reverted: 'yes' }),
      outcomeLine('acme/widgets', 12, bigFiles(), 4, { reverted: 'yes' }),
      outcomeLine('acme/widgets', 13, bigBoth(), 6, { reverted: 'no' }),
      outcomeLine('acme/widgets', 14, sized(), 8, { reverted: 'yes' }),
      scanLine(),
    ]);
    const items = await outsidePrDiffBacklogItems({ runsDir: dir, now: new Date(NOW) });
    expect(items).toHaveLength(1);
    const prompt = items[0]!.prompt;
    expect(prompt).toContain('2 of the oversized merges now stand reverted');
    expect(prompt).toContain('now standing reverted');
    // The sized merge's revert is the sibling feeds' signal, not this one's.
    expect(prompt).not.toContain('3 of the oversized merges now stand reverted');
  });

  it('emits nothing below the bar, below the share bar, for a missing journal, or an unreadable one', async () => {
    expect(OUTSIDE_PR_DIFF_RECURRING).toBe(3);
    // Only two oversized merges — below the recurring bar.
    const quiet = await runsDir('runs-quiet', [
      outcomeLine('acme/widgets', 21, bigLines(), 2),
      outcomeLine('acme/widgets', 22, bigFiles(), 3),
      outcomeLine('acme/widgets', 23, sized(), 4),
      scanLine(),
    ]);
    expect(await outsidePrDiffBacklogItems({ runsDir: quiet, now: new Date(NOW) })).toEqual([]);

    // Three oversized but a majority of sized merges — below the share bar.
    const minority = await runsDir('runs-minority', [
      outcomeLine('acme/widgets', 24, bigLines(), 2),
      outcomeLine('acme/widgets', 25, bigFiles(), 3),
      outcomeLine('acme/widgets', 26, bigBoth(), 4),
      outcomeLine('acme/widgets', 27, sized(), 5),
      outcomeLine('acme/widgets', 28, sized(), 6),
      outcomeLine('acme/widgets', 29, sized(), 7),
      outcomeLine('acme/widgets', 30, sized(), 8),
      scanLine(),
    ]);
    expect(await outsidePrDiffBacklogItems({ runsDir: minority, now: new Date(NOW) })).toEqual([]);

    const empty = await runsDir('runs-empty', null);
    expect(await outsidePrDiffBacklogItems({ runsDir: empty, now: new Date(NOW) })).toEqual([]);
    expect(await outsidePrDiffBacklogItems({ runsDir: join(home, 'no-such'), now: new Date(NOW) })).toEqual([]);

    const bad = join(home, 'runs-bad');
    await mkdir(join(bad, 'metrics', OUTSIDE_PR_OUTCOME_JOURNAL_NAME), { recursive: true });
    expect(await outsidePrDiffBacklogItems({ runsDir: bad, now: new Date(NOW) })).toEqual([]);
  });

  it('emits per-repo items that each carry their own repository target', async () => {
    const dir = await runsDir('runs-two', [
      ...RECURRING,
      outcomeLine('acme/other', 31, bigLines(), 2),
      outcomeLine('acme/other', 32, bigFiles(), 3),
      outcomeLine('acme/other', 33, bigBoth(), 4),
      outcomeLine('acme/other', 34, sized(), 5),
      scanLine(),
    ]);
    const items = await outsidePrDiffBacklogItems({ runsDir: dir, now: new Date(NOW) });
    expect(items).toHaveLength(2);
    const repos = items.map((i) => i.repo).sort();
    expect(repos).toEqual(['acme/other', 'acme/widgets']);
    expect(items.every((i) => validBacklogItem(i) !== null)).toBe(true);
    const limited = await outsidePrDiffBacklogItems({ runsDir: dir, now: new Date(NOW), limit: 1 });
    expect(limited).toHaveLength(1);
    expect(OUTSIDE_PR_DIFF_MAX_ITEMS).toBeGreaterThanOrEqual(2);
  });

  it('keeps the newest journaled row per PR', async () => {
    const dir = await runsDir('runs-flip', [
      outcomeLine('acme/widgets', 41, sized(), 2, { at: daysAgo(1) }),
      outcomeLine('acme/widgets', 41, bigLines(), 2, { at: AT }),
      outcomeLine('acme/widgets', 42, bigFiles(), 3),
      outcomeLine('acme/widgets', 43, bigBoth(), 4),
      outcomeLine('acme/widgets', 44, bigLines(), 5, { at: daysAgo(0.5) }),
      outcomeLine('acme/widgets', 44, sized(), 5, { at: AT }),
      scanLine(),
    ]);
    const items = await outsidePrDiffBacklogItems({ runsDir: dir, now: new Date(NOW) });
    expect(items).toHaveLength(1);
    // #41 newest=oversized, #44 newest=sized → oversized are 41,42,43 = 3 of 4 diff-known.
    expect(items[0]!.prompt).toContain('3 of the recorded 4 outside merges');
    expect(items[0]!.prompt).toContain('3 of those oversized');
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
    const items = await outsidePrDiffBacklogItems({ runsDir: dir, now: new Date(NOW) });
    expect(items).toHaveLength(1);
    expect(items[0]!.prompt).toContain('at least 3 of the recorded 5 outside merges');
    expect(items[0]!.prompt).toContain("sourceState 'degraded'");
    expect(items[0]!.prompt).toContain("revert ledger read as 'unreadable'");
    expect(items[0]!.prompt).toContain('repo reads were partial: acme/widgets (degraded, gh result limit hit)');
    expect(items[0]!.prompt).toContain('recorded floor');
  });

  it('waits for future diff evidence before surfacing a recurring pattern', async () => {
    const later = new Date(NOW + 1);
    const dir = await runsDir('runs-future', [
      outcomeLine('acme/widgets', 41, sized(), 2),
      outcomeLine('acme/widgets', 42, bigLines(), 3),
      outcomeLine('acme/widgets', 43, bigFiles(), 4),
      outcomeLine('acme/widgets', 44, sized(), 5),
      outcomeLine('acme/widgets', 41, bigLines(), 2, { at: later.toISOString() }),
    ]);
    // At NOW the newest row for #41 is still the sized one (the oversized
    // row's `at` is in the future and parseOutsidePrOutcomeJournal drops
    // it), leaving only 2 oversized of 4 — below the bar.
    expect(await outsidePrDiffBacklogItems({ runsDir: dir, now: new Date(NOW) })).toEqual([]);
    const items = await outsidePrDiffBacklogItems({ runsDir: dir, now: later });
    expect(items).toHaveLength(1);
    expect(items[0]!.prompt).toContain('3 of the recorded 4 outside merges');
  });

  it('derives stable ids per repo so a refresh re-adds nothing', async () => {
    const dir = await runsDir('runs-stable', [...RECURRING, scanLine()]);
    const opts = { runsDir: dir, now: new Date(NOW) };
    const first = await outsidePrDiffBacklogItems(opts);
    const second = await outsidePrDiffBacklogItems(opts);
    expect(first.map((i) => i.id)).toEqual(second.map((i) => i.id));
    expect(first).toHaveLength(1);
  });

  it('appends outside-pr diff items through discovery and dedupes on refresh', async () => {
    const runs = join(home, '.ashlr-runs');
    await mkdir(join(runs, 'metrics'), { recursive: true });
    await writeFile(join(runs, JOURNAL), [...RECURRING, scanLine()].join('\n') + '\n');
    const greenGh = async (args: string[]) => {
      const p = args[4] ?? '';
      if (p === 'repos/ashlrai/phantom') return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n{"default_branch":"master"}', stderr: '' };
      return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n[]', stderr: '' };
    };
    const first = await discoverBacklog('ashlrai/phantom', { gh: greenGh });
    const diffItems = first.items.filter((i) => i.id.startsWith('outside-pr-diff-'));
    expect(diffItems).toHaveLength(1);
    expect(diffItems[0]!.repo).toBe('acme/widgets');
    expect(first.items.every((i) => validBacklogItem(i) !== null)).toBe(true);
    expect(appendUserBacklogItems(diffItems)).toBe(1);
    const second = await discoverBacklog('ashlrai/phantom', { gh: greenGh });
    expect(appendUserBacklogItems(second.items.filter((i) => i.id.startsWith('outside-pr-diff-')))).toBe(0);
    expect(readUserBacklogItems().filter((i) => i.id.startsWith('outside-pr-diff-'))).toHaveLength(1);
  });
});
