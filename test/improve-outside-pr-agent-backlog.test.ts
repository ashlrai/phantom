/**
 * outside-pr-agent-backlog — merged outside-PR outcomes folded per
 * journaled agent attribution into self-improvement backlog items.
 *
 * Contract:
 *   - An agent cell emits only at OUTSIDE_PR_REVERTED_RECURRING (3)
 *     reverted outside merges inside the 30-day window; 'unknown'
 *     verdicts, merges outside the window and unattributed rows never
 *     count toward the bar or form a cell.
 *   - The per-repo spread is quoted so cross-repo recurrence — the
 *     signal the per-repo sibling cannot see — reads differently from
 *     single-repo concentration.
 *   - Items emit only for the fleet's own repository; ids are stable
 *     per agent slug so a refresh re-adds nothing.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendUserBacklogItems, readUserBacklogItems, validBacklogItem } from '../src/core/cloud/backlog.js';
import {
  foldOutsidePrAgentCells,
  OUTSIDE_PR_AGENT_FUTURE_SKEW_MS,
  outsidePrAgentBacklogItems,
} from '../src/core/improve/outside-pr-agent-backlog.js';
import { OUTSIDE_PR_REVERTED_RECURRING, OUTSIDE_PR_WINDOW_HOURS } from '../src/core/improve/outside-pr-backlog.js';
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

const outcomeLine = (
  repo: string,
  number: number,
  verdict: 'yes' | 'no' | 'unknown',
  mergedDaysAgo: number,
  over: Record<string, unknown> = {},
): string => JSON.stringify({
  v: 1, kind: OUTSIDE_PR_OUTCOME_SCHEMA, at: AT,
  repo, number, title: `outside fix ${number}`, author: 'ext-dev', agent: 'devin', model: null,
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
  repo, number, title: `fix ${number}`, author: 'ext-dev', agent: 'devin', model: null,
  mergedAt, createdAt: null, reviews: null, ci: null, diff: null, reverted: verdict, ...over,
});

describe('foldOutsidePrAgentCells', () => {
  const opts = { nowMs: NOW, windowHours: OUTSIDE_PR_WINDOW_HOURS };

  it('groups in-window merges per attributed agent with verdict tallies and repo spread', () => {
    const cells = foldOutsidePrAgentCells([
      row('acme/widgets', 1, 'yes', daysAgo(2)),
      row('acme/widgets', 2, 'yes', daysAgo(3)),
      row('acme/other', 3, 'yes', daysAgo(4)),
      row('acme/other', 4, 'no', daysAgo(5)),
      row('acme/widgets', 5, 'unknown', daysAgo(6)),
      row('acme/other', 6, 'yes', daysAgo(2), { agent: 'cursor' }),
    ], opts);
    expect(cells).toHaveLength(1);
    const cell = cells[0]!;
    expect(cell.agent).toBe('devin');
    expect(cell).toMatchObject({ merged: 5, reverted: 3, unknown: 1, kept: 1, repos_reverted: 2 });
    // Reverted merges span two repos — the cross-repo pattern the per-repo fold cannot see.
    expect(cell.repos).toEqual([
      { repo: 'acme/widgets', merged: 3, reverted: 2 },
      { repo: 'acme/other', merged: 2, reverted: 1 },
    ]);
    expect(cell.authors).toEqual([{ author: 'ext-dev', reverted: 3 }]);
    expect(cell.examples.map((e) => e.number)).toEqual([1, 2, 3]);
    expect(cell.examples[0]).toMatchObject({ repo: 'acme/widgets' });
    expect(cell.firstMerged).toBe(daysAgo(4));
    expect(cell.lastMerged).toBe(daysAgo(2));
  });

  it('emits the cross-repo cell the per-repo bar cannot reach', () => {
    // Two reverted merges on each of two repos: no repo cell reaches 3,
    // but the agent cell does — this is the gap the feed exists for.
    const cells = foldOutsidePrAgentCells([
      row('acme/a', 1, 'yes', daysAgo(2)),
      row('acme/a', 2, 'yes', daysAgo(3)),
      row('acme/a', 3, 'no', daysAgo(4)),
      row('acme/b', 4, 'yes', daysAgo(5)),
      row('acme/b', 5, 'yes', daysAgo(6)),
      row('acme/b', 6, 'no', daysAgo(7)),
    ], opts);
    expect(OUTSIDE_PR_REVERTED_RECURRING).toBe(3);
    expect(cells).toHaveLength(1);
    expect(cells[0]).toMatchObject({ agent: 'devin', merged: 6, reverted: 4, repos_reverted: 2 });
  });

  it('drops cells below the recurring bar and merges outside the window', () => {
    const cells = foldOutsidePrAgentCells([
      row('acme/a', 1, 'yes', daysAgo(2)),
      row('acme/b', 2, 'yes', daysAgo(3)),
      row('acme/c', 3, 'yes', daysAgo(OUTSIDE_PR_WINDOW_HOURS / 24 + 1)), // outside 30d
      row('acme/d', 4, 'yes', daysAgo(2), { agent: 'cursor' }),
      row('acme/e', 5, 'yes', daysAgo(3), { agent: 'cursor' }),
      row('acme/f', 6, 'no', daysAgo(4), { agent: 'cursor' }),
    ], opts);
    expect(cells).toEqual([]);
  });

  it('never counts unknown verdicts toward the bar', () => {
    const cells = foldOutsidePrAgentCells([
      row('acme/a', 1, 'yes', daysAgo(2)),
      row('acme/b', 2, 'yes', daysAgo(3)),
      row('acme/c', 3, 'unknown', daysAgo(4)),
      row('acme/d', 4, 'unknown', daysAgo(5)),
      row('acme/e', 5, 'unknown', daysAgo(6)),
    ], opts);
    expect(cells).toEqual([]);
  });

  it('forms no cell for unattributed rows', () => {
    const cells = foldOutsidePrAgentCells([
      row('acme/a', 1, 'yes', daysAgo(2), { agent: null }),
      row('acme/b', 2, 'yes', daysAgo(3), { agent: null }),
      row('acme/c', 3, 'yes', daysAgo(4), { agent: null }),
      row('acme/d', 4, 'yes', daysAgo(5), { agent: null }),
    ], opts);
    expect(cells).toEqual([]);
  });

  it('skips rows whose mergedAt does not parse', () => {
    const cells = foldOutsidePrAgentCells([
      row('acme/a', 1, 'yes', 'not a date'),
      row('acme/b', 2, 'yes', daysAgo(2)),
      row('acme/c', 3, 'yes', daysAgo(3)),
      row('acme/d', 4, 'yes', daysAgo(4)),
    ], opts);
    expect(cells).toHaveLength(1);
    expect(cells[0]!.merged).toBe(3);
  });

  it('tallies reverted merges\' open→merge latency, review and diff evidence only', () => {
    const cells = foldOutsidePrAgentCells([
      row('acme/a', 1, 'yes', daysAgo(2), {
        createdAt: new Date(NOW - 2 * DAY - 120 * MIN).toISOString(),
        reviews: { decision: 'APPROVED', latest: 2 },
        diff: { additions: 100, deletions: 20, changedFiles: 5 },
      }),
      row('acme/b', 2, 'yes', daysAgo(3), {
        createdAt: new Date(NOW - 3 * DAY - 60 * MIN).toISOString(),
        reviews: { decision: null, latest: 0 },
        diff: { additions: 40, deletions: 10, changedFiles: 3 },
      }),
      // Reverted but pre-fields: counts toward prs, no evidence denominator.
      row('acme/c', 3, 'yes', daysAgo(4)),
      // Kept/unknown rows' evidence is denominator context only — never tallied here.
      row('acme/d', 4, 'no', daysAgo(5), {
        createdAt: new Date(NOW - 5 * DAY - 30 * MIN).toISOString(),
        reviews: { decision: 'CHANGES_REQUESTED', latest: 3 },
        diff: { additions: 999, deletions: 0, changedFiles: 9 },
      }),
    ], opts);
    expect(cells).toHaveLength(1);
    expect(cells[0]).toMatchObject({
      merged: 4, reverted: 3, kept: 1,
      ttm_known: 2, ttm_minutes_mean: 90,
      reviews_known: 2, unreviewed: 1, changes_requested: 0,
      diff_known: 2, diff_lines_mean: 85, diff_files_mean: 4,
    });
  });

  it('never counts merges stamped past the evaluation-time future skew', () => {
    const future = new Date(NOW + 2 * 3_600_000).toISOString();
    expect(foldOutsidePrAgentCells([
      row('acme/a', 1, 'yes', future),
      row('acme/b', 2, 'yes', future),
      row('acme/c', 3, 'yes', future),
    ], opts)).toEqual([]);
    expect(OUTSIDE_PR_AGENT_FUTURE_SKEW_MS).toBe(60_000);
    // Inside the one-minute skew the stamp still counts as clock drift.
    const cells = foldOutsidePrAgentCells([
      row('acme/a', 4, 'yes', daysAgo(2)),
      row('acme/b', 5, 'yes', daysAgo(3)),
      row('acme/c', 6, 'yes', new Date(NOW + 30_000).toISOString()),
    ], opts);
    expect(cells).toHaveLength(1);
    expect(cells[0]!.reverted).toBe(3);
  });
});

describe('outsidePrAgentBacklogItems', () => {
  let home: string;
  let saved: { HOME?: string; ASHLR_HOME?: string; ASHLR_RUNS_DIR?: string };

  beforeEach(async () => {
    saved = { HOME: process.env.HOME, ASHLR_HOME: process.env.ASHLR_HOME, ASHLR_RUNS_DIR: process.env.ASHLR_RUNS_DIR };
    delete process.env.ASHLR_HOME;
    delete process.env.ASHLR_RUNS_DIR;
    home = await mkdtemp(join(tmpdir(), 'outside-pr-agent-backlog-'));
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
    outcomeLine('acme/other', 12, 'yes', 4),
    outcomeLine('acme/third', 13, 'yes', 6),
    outcomeLine('acme/widgets', 14, 'no', 8),
    outcomeLine('acme/other', 15, 'unknown', 10),
  ];

  it('emits one fleet-repo item per recurring agent and validates it', async () => {
    const dir = await runsDir('runs-hit', [
      ...RECURRING,
      outcomeLine('acme/misc', 16, 'yes', 3, { agent: 'cursor' }),
      outcomeLine('acme/misc', 17, 'yes', 5, { agent: 'cursor' }),
      scanLine(),
    ]);
    const items = await outsidePrAgentBacklogItems({ repo: FLEET_REPO, runsDir: dir, now: new Date(NOW) });
    expect(items).toHaveLength(1);
    const [item] = items;
    expect(item).toMatchObject({ priority: 3, repo: FLEET_REPO, area: 'outside-prs' });
    expect(item!.id).toMatch(/^outside-pr-agent-reverts-[0-9a-f]{16}$/);
    expect(item!.title).toContain("'devin'");
    expect(validBacklogItem(item)).not.toBeNull();
    expect(item!.prompt).toContain("3 of the recorded 5 outside merges inside the 720-hour window");
    expect(item!.prompt).toContain("5 outside merges attributed to 'devin'");
    expect(item!.prompt).toContain('acme/widgets (1 reverted of 2)');
    expect(item!.prompt).toContain('acme/other (1 reverted of 2)');
    expect(item!.prompt).toContain('acme/third (1 reverted of 1)');
    expect(item!.prompt).toContain('the reverted merges span 3 repositories');
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
    expect(await outsidePrAgentBacklogItems({ repo: 'acme/widgets', runsDir: dir, now: new Date(NOW) })).toEqual([]);
    expect(await outsidePrAgentBacklogItems({ repo: '', runsDir: dir, now: new Date(NOW) })).toEqual([]);
  });

  it('emits nothing below the bar, for a missing journal, or an unreadable one', async () => {
    const quiet = await runsDir('runs-quiet', [
      outcomeLine('acme/a', 21, 'yes', 2),
      outcomeLine('acme/b', 22, 'yes', 3),
      outcomeLine('acme/c', 23, 'no', 4),
      scanLine(),
    ]);
    expect(await outsidePrAgentBacklogItems({ repo: FLEET_REPO, runsDir: quiet, now: new Date(NOW) })).toEqual([]);

    const empty = await runsDir('runs-empty', null);
    expect(await outsidePrAgentBacklogItems({ repo: FLEET_REPO, runsDir: empty, now: new Date(NOW) })).toEqual([]);
    expect(await outsidePrAgentBacklogItems({ repo: FLEET_REPO, runsDir: join(home, 'no-such'), now: new Date(NOW) })).toEqual([]);

    const bad = join(home, 'runs-bad');
    await mkdir(join(bad, 'metrics', OUTSIDE_PR_OUTCOME_JOURNAL_NAME), { recursive: true });
    expect(await outsidePrAgentBacklogItems({ repo: FLEET_REPO, runsDir: bad, now: new Date(NOW) })).toEqual([]);
  });

  it('keeps the newest journaled verdict per PR', async () => {
    const dir = await runsDir('runs-flip', [
      outcomeLine('acme/a', 41, 'no', 2, { at: daysAgo(1) }),
      outcomeLine('acme/a', 41, 'yes', 2, { at: AT }),
      outcomeLine('acme/b', 42, 'yes', 3),
      outcomeLine('acme/c', 43, 'yes', 4),
      outcomeLine('acme/d', 44, 'yes', 5, { at: daysAgo(0.5) }),
      outcomeLine('acme/d', 44, 'no', 5, { at: AT }),
      scanLine(),
    ]);
    const items = await outsidePrAgentBacklogItems({ repo: FLEET_REPO, runsDir: dir, now: new Date(NOW) });
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
    const items = await outsidePrAgentBacklogItems({ repo: FLEET_REPO, runsDir: dir, now: new Date(NOW) });
    expect(items).toHaveLength(1);
    expect(items[0]!.prompt).toContain("at least 3 of the recorded 5 outside merges");
    expect(items[0]!.prompt).toContain("sourceState 'degraded'");
    expect(items[0]!.prompt).toContain("revert ledger read as 'unreadable'");
    expect(items[0]!.prompt).toContain('repo reads were partial: acme/widgets (degraded, gh result limit hit)');
    expect(items[0]!.prompt).toContain('recorded floor');
  });

  it('quotes single-repo concentration as the sibling-owned reading', async () => {
    const dir = await runsDir('runs-single', [
      outcomeLine('acme/widgets', 51, 'yes', 2),
      outcomeLine('acme/widgets', 52, 'yes', 3),
      outcomeLine('acme/widgets', 53, 'yes', 4),
      outcomeLine('acme/widgets', 54, 'no', 5),
      scanLine(),
    ]);
    const items = await outsidePrAgentBacklogItems({ repo: FLEET_REPO, runsDir: dir, now: new Date(NOW) });
    expect(items).toHaveLength(1);
    expect(items[0]!.prompt).toContain('acme/widgets (3 reverted of 4)');
    expect(items[0]!.prompt).toContain('every reverted merge landed on that one repository');
    expect(items[0]!.prompt).toContain('the per-repository causes the sibling per-repo backlog items already own');
  });

  it('derives stable ids per agent so a refresh re-adds nothing', async () => {
    const dir = await runsDir('runs-stable', [...RECURRING, scanLine()]);
    const opts = { repo: FLEET_REPO, runsDir: dir, now: new Date(NOW) };
    const first = await outsidePrAgentBacklogItems(opts);
    const second = await outsidePrAgentBacklogItems(opts);
    expect(first.map((i) => i.id)).toEqual(second.map((i) => i.id));
    expect(first).toHaveLength(1);
  });

  it('appends agent items through discovery and dedupes on refresh', async () => {
    const runs = join(home, '.ashlr-runs');
    await mkdir(join(runs, 'metrics'), { recursive: true });
    await writeFile(join(runs, JOURNAL), [...RECURRING, scanLine()].join('\n') + '\n');
    const greenGh = async (args: string[]) => {
      const p = args[4] ?? '';
      if (p === 'repos/ashlrai/phantom') return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n{"default_branch":"master"}', stderr: '' };
      return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n[]', stderr: '' };
    };
    const first = await discoverBacklog(FLEET_REPO, { gh: greenGh });
    const agentItems = first.items.filter((i) => i.id.startsWith('outside-pr-agent-reverts-'));
    expect(agentItems).toHaveLength(1);
    expect(agentItems[0]!.repo).toBe(FLEET_REPO);
    expect(first.items.every((i) => validBacklogItem(i) !== null)).toBe(true);
    expect(appendUserBacklogItems(agentItems)).toBe(1);
    const second = await discoverBacklog(FLEET_REPO, { gh: greenGh });
    expect(appendUserBacklogItems(second.items.filter((i) => i.id.startsWith('outside-pr-agent-reverts-')))).toBe(0);
    expect(readUserBacklogItems().filter((i) => i.id.startsWith('outside-pr-agent-reverts-'))).toHaveLength(1);
  });
});
