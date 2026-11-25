import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  classifySelectorPick,
  foldSelectorJobOutcomes,
  foldSelectorPicksJournal,
  SELECTOR_PICKS_WINDOW_HOURS,
  selectorPickCells,
  selectorPicksBacklogItems,
  type SelectorJobTally,
  type SelectorJobsFold,
  type SelectorPickRecord,
} from '../src/core/improve/selector-picks-backlog.js';
import { discoverBacklog } from '../src/core/improve/discover.js';
import { appendUserBacklogItems, readUserBacklogItems, validBacklogItem } from '../src/core/cloud/backlog.js';

const DAY = 86_400_000;
const HOUR = 3_600_000;
const J = (o: Record<string, unknown>): string => JSON.stringify(o);

/** Fixed evaluation instant; fixture timestamps are ISO-8601 UTC like the writers emit. */
const NOW_MS = Date.parse('2026-11-23T12:00:00.000Z');
const iso = (ms: number): string => new Date(ms).toISOString();

/** One picks-journal row in pickRecords' writer shape. */
function pickRow(id: string, atMs: number, over: Record<string, unknown> = {}): string {
  return J({
    at: iso(atMs), rank: 1, id, repo: 'phantom', jobType: 'work', score: 1.5,
    predictedValue: 0.7, mergeRate: 0.6, minutes: 30, usage: 0.3, basis: 'learned',
    ...over,
  });
}

/** `days` x `perDay` distinct funded pick ids in pickSeries' naming order. */
function seriesIds(prefix: string, days: number, perDay: number): string[] {
  const ids: string[] = [];
  for (let d = 0; d < days; d++) for (let i = 0; i < perDay; i++) ids.push(`${prefix}${d}${i}`);
  return ids;
}

/** `days` distinct funded picks spread across UTC days, at the given stamp function. */
function pickSeries(prefix: string, days: number, perDay: number, at: (d: number, i: number) => number, over: Record<string, unknown> = {}): string[] {
  return seriesIds(prefix, days, perDay).map((id, n) => {
    const d = Math.floor(n / perDay);
    const i = n % perDay;
    return pickRow(id, at(d, i), over);
  });
}

// --- jobs-ledger row builders (dispatchd dialect) -------------------------

const launchRow = (job: string, atMs: number): string =>
  J({ event: 'launch', job, repo: 'phantom', lane: 'work', tier: 'mid', ts: iso(atMs) });
const finishRow = (job: string, atMs: number, empty = false): string =>
  J({ event: 'finish', job, empty, wall_s: 42, ts: iso(atMs) });
const publishPrRow = (job: string, atMs: number): string =>
  J({ event: 'publish', job, class: 'pr', url: `https://example.invalid/pr/${job}`, ts: iso(atMs) });
const publishEmptyRow = (job: string, atMs: number): string =>
  J({ event: 'publish', job, class: 'empty', ts: iso(atMs) });
const publishAbortRow = (job: string, atMs: number): string =>
  J({ event: 'publish', job, class: 'abort:quota', ts: iso(atMs) });
const outcomeRow = (job: string, state: string, atMs: number): string =>
  J({ event: 'outcome', job, state, ts: iso(atMs) });
const precheckSkipRow = (job: string, atMs: number): string =>
  J({ event: 'precheck_skip', job, reason: 'already-done', ts: iso(atMs) });
const skippedEmptyRow = (job: string, atMs: number): string =>
  J({ event: 'skipped_empty', job, code: 4, ts: iso(atMs) });

/** The production fold: picks text plus the jobs tail and the funded id set, as the items function reads them. */
function foldAll(picks: string, jobs: string, nowMs = NOW_MS) {
  const pf = foldSelectorPicksJournal(picks, nowMs, SELECTOR_PICKS_WINDOW_HOURS);
  const jf = foldSelectorJobOutcomes(jobs, nowMs, SELECTOR_PICKS_WINDOW_HOURS, new Set(pf.picks.keys()));
  return { picks: pf, jobs: jf, ...selectorPickCells(pf, jf, nowMs) };
}

/** A valid in-window pick record for classifySelectorPick. */
function pickRecord(id: string, atMs: number): SelectorPickRecord {
  return {
    id, atMs, utcDay: new Date(atMs).toISOString().slice(0, 10),
    repo: 'phantom', jobType: 'work', basis: 'learned',
    predictedValue: 0.7, mergeRate: 0.6, friction: false,
  };
}

/** A jobs fold with the given per-id tallies and fleet guards. */
function jobFold(tallies: Record<string, SelectorJobTally>, over: Partial<SelectorJobsFold> = {}): SelectorJobsFold {
  return { tallies: new Map(Object.entries(tallies)), launchesInWindow: 1, coverageStartMs: NOW_MS - 10 * DAY, ...over };
}

/** A recorded outcome tally; override only the counters a case needs. */
function tally(over: Partial<SelectorJobTally> = {}): SelectorJobTally {
  return {
    rows: 1, launches: 1, finishes: 0, emptyFinishes: 0, prs: 0, aborts: 0,
    precheckSkips: 0, merged: 0, closed: 0, resolvedOther: 0, ...over,
  };
}

describe('foldSelectorPicksJournal', () => {
  it('folds in-window rows per pick id and keeps only contract-valid records', () => {
    const rows = [
      pickRow('RQ-AAA-1', NOW_MS - DAY),
      pickRow('RQ-AAA-1', NOW_MS - 2 * DAY), // duplicate id: first row wins
      pickRow('RQ-BBB-2', NOW_MS - HOUR, { jobType: 'friction', basis: 'default', frictionId: 'friction-9' }),
      // Malformed and off-contract rows never count.
      'not json',
      '{"at":',
      J({ at: 'not-a-date', id: 'RQ-CCC', repo: 'phantom' }),
      J({ id: 'RQ-DDD', repo: 'phantom' }),
      pickRow('bad id', NOW_MS - HOUR),
      pickRow('../escape', NOW_MS - HOUR),
      pickRow('RQ-EEE', NOW_MS - HOUR, { basis: 'bogus' }),
      // Out-of-window and future-dated rows contribute nothing.
      pickRow('RQ-OLD', NOW_MS - SELECTOR_PICKS_WINDOW_HOURS * 3_600_000 - DAY),
      pickRow('RQ-FUT', NOW_MS + 600_000),
      '',
    ];
    const fold = foldSelectorPicksJournal(rows.join('\n'), NOW_MS, SELECTOR_PICKS_WINDOW_HOURS);
    expect(fold.malformed).toBe(2);
    expect([...fold.picks.keys()].sort()).toEqual(['RQ-AAA-1', 'RQ-BBB-2', 'RQ-EEE']);
    const a = fold.picks.get('RQ-AAA-1')!;
    expect(a.atMs).toBe(NOW_MS - DAY); // the first recorded row, not the later duplicate
    expect(a.predictedValue).toBe(0.7);
    expect(a.mergeRate).toBe(0.6);
    const b = fold.picks.get('RQ-BBB-2')!;
    expect(b.jobType).toBe('friction');
    expect(b.basis).toBe('default');
    expect(b.friction).toBe(true);
    expect(fold.picks.get('RQ-EEE')!.basis).toBe('unrecorded');
  });
});

describe('foldSelectorJobOutcomes', () => {
  it('tallies launches, finishes, publishes, skips and outcomes for pick ids only', () => {
    const pickIds = new Set(['RQ-AAA-1', 'RQ-BBB-2']);
    const rows = [
      launchRow('RQ-AAA-1', NOW_MS - 5 * DAY),
      finishRow('RQ-AAA-1', NOW_MS - 4 * DAY, true),
      launchRow('RQ-AAA-1', NOW_MS - 3 * DAY),
      publishPrRow('RQ-AAA-1', NOW_MS - 2 * DAY),
      outcomeRow('RQ-AAA-1', 'MERGED', NOW_MS - DAY),
      launchRow('RQ-BBB-2', NOW_MS - 2 * DAY),
      publishAbortRow('RQ-BBB-2', NOW_MS - DAY),
      outcomeRow('RQ-BBB-2', 'CLOSED', NOW_MS - 12 * HOUR),
      precheckSkipRow('RQ-BBB-2', NOW_MS - 6 * HOUR),
      skippedEmptyRow('RQ-BBB-2', NOW_MS - 5 * HOUR),
      // Non-pick jobs, node-pool rows, undated and out-of-window rows never join tallies.
      launchRow('RQ-OTHER', NOW_MS - DAY),
      finishRow('RQ-OTHER', NOW_MS - DAY, true),
      outcomeRow('RQ-OTHER', 'MERGED', NOW_MS - DAY),
      J({ schema: 'fleet.session-pool.v1', event: 'launch', job: 'sess-1:2', jobId: 'RQ-AAA-1', ts: iso(NOW_MS - DAY) }),
      J({ event: 'launch', job: 'RQ-AAA-1', ts: 'not-a-date' }),
      launchRow('RQ-AAA-1', NOW_MS - SELECTOR_PICKS_WINDOW_HOURS * 3_600_000 - DAY),
      'not json',
      '',
    ];
    const fold = foldSelectorJobOutcomes(rows.join('\n'), NOW_MS, SELECTOR_PICKS_WINDOW_HOURS, pickIds);
    expect([...fold.tallies.keys()].sort()).toEqual(['RQ-AAA-1', 'RQ-BBB-2']);
    const a = fold.tallies.get('RQ-AAA-1')!;
    expect(a).toMatchObject({ launches: 2, finishes: 1, emptyFinishes: 1, prs: 1, merged: 1 });
    const b = fold.tallies.get('RQ-BBB-2')!;
    expect(b).toMatchObject({ launches: 1, aborts: 1, closed: 1, precheckSkips: 2 });
    // The fleet-wide launch count sees every in-window launch, pick or not.
    expect(fold.launchesInWindow).toBe(4); // RQ-AAA x2 + RQ-BBB + RQ-OTHER
    // Coverage is the first dated retained row — here the 5-day-old launch.
    expect(fold.coverageStartMs).toBe(NOW_MS - 5 * DAY);
  });

  it('records null coverage when no retained row carries a timestamp', () => {
    const fold = foldSelectorJobOutcomes(
      [J({ event: 'launch', job: 'RQ-X' }), 'not json', ''].join('\n'),
      NOW_MS, SELECTOR_PICKS_WINDOW_HOURS, new Set(['RQ-X']),
    );
    expect(fold.coverageStartMs).toBeNull();
    expect(fold.launchesInWindow).toBe(0); // undated rows never count
  });
});

describe('classifySelectorPick', () => {
  it('classifies by recorded tallies with merged winning every adverse signal', () => {
    const p = pickRecord('RQ-T', NOW_MS - 2 * DAY);
    const jf = jobFold({});
    expect(classifySelectorPick(p, tally({ merged: 1, emptyFinishes: 1, closed: 1 }), jf, NOW_MS)).toBe('merged');
    expect(classifySelectorPick(p, tally({ emptyFinishes: 1, aborts: 1 }), jf, NOW_MS)).toBe('empty');
    expect(classifySelectorPick(p, tally({ aborts: 1, closed: 1 }), jf, NOW_MS)).toBe('aborted');
    expect(classifySelectorPick(p, tally({ closed: 1 }), jf, NOW_MS)).toBe('unmerged');
    expect(classifySelectorPick(p, tally({ resolvedOther: 1 }), jf, NOW_MS)).toBe('unmerged');
    expect(classifySelectorPick(p, tally({ launches: 1, prs: 1 }), jf, NOW_MS)).toBe('open');
    expect(classifySelectorPick(p, tally({ launches: 0, precheckSkips: 2 }), jf, NOW_MS)).toBe('declined');
    // Rows seen but nothing recognized is unknown, never guessed.
    expect(classifySelectorPick(p, tally({ rows: 3, launches: 0 }), jf, NOW_MS)).toBe('unknown');
    // No rows at all, too fresh to judge.
    expect(classifySelectorPick(pickRecord('RQ-T', NOW_MS - HOUR), undefined, jf, NOW_MS)).toBe('unknown');
  });

  it('never-launched requires grace, coverage and fleet launch activity', () => {
    const old = pickRecord('RQ-N', NOW_MS - 3 * DAY);
    const fresh = pickRecord('RQ-N', NOW_MS - 12 * HOUR);
    const live = jobFold({}, { launchesInWindow: 5, coverageStartMs: NOW_MS - 10 * DAY });
    // Past grace, covered, fleet launching, zero rows for the id.
    expect(classifySelectorPick(old, undefined, live, NOW_MS)).toBe('never-launched');
    // Too fresh — the planner/queue may still be working it.
    expect(classifySelectorPick(fresh, undefined, live, NOW_MS)).toBe('unknown');
    // Fleet-wide stall: nothing launched in-window, so absence is not the selector's.
    expect(classifySelectorPick(old, undefined, jobFold({}, { launchesInWindow: 0, coverageStartMs: NOW_MS - 10 * DAY }), NOW_MS)).toBe('unknown');
    // Truncated tail starts after the funding: a launch could have been cut.
    expect(classifySelectorPick(old, undefined, jobFold({}, { coverageStartMs: NOW_MS - DAY }), NOW_MS)).toBe('unknown');
    // No dated retained row at all: coverage is unproven.
    expect(classifySelectorPick(old, undefined, jobFold({}, { coverageStartMs: null }), NOW_MS)).toBe('unknown');
  });
});

describe('selectorPickCells', () => {
  it('emits a cell only at the pick and day bars, with window counts as context', () => {
    // Below the pick bar: two picks across two days in one class.
    const fewPicks = [pickRow('RQ-E1', NOW_MS - 3 * DAY), pickRow('RQ-E2', NOW_MS - DAY)].join('\n');
    const fewJobs = [
      launchRow('RQ-E1', NOW_MS - 3 * DAY), finishRow('RQ-E1', NOW_MS - 2 * DAY, true),
      launchRow('RQ-E2', NOW_MS - DAY), publishEmptyRow('RQ-E2', NOW_MS - 12 * HOUR),
    ].join('\n');
    const few = foldAll(fewPicks, fewJobs);
    expect(few.cells).toEqual([]);
    expect(few.window.total).toBe(2);
    expect(few.window.adverse.get('empty')).toBe(2);

    // Below the day bar: three picks, all funded today.
    const oneDay = foldAll(
      [0, 1, 2].map((i) => pickRow(`RQ-D${i}`, NOW_MS - i * HOUR)).join('\n'),
      [0, 1, 2].flatMap((i) => [launchRow(`RQ-D${i}`, NOW_MS - i * HOUR), finishRow(`RQ-D${i}`, NOW_MS - i * HOUR + 60_000, true)]).join('\n'),
    );
    expect(oneDay.cells).toEqual([]);

    // At the bars: four empty picks across two UTC days, plus one merged
    // and one still-open pick that count as window context only.
    const picksText = [
      ...pickSeries('RQ-E', 2, 2, (d, i) => NOW_MS - d * DAY - i * HOUR - 2 * HOUR),
      pickRow('RQ-OK1', NOW_MS - 2 * DAY),
      pickRow('RQ-OPEN1', NOW_MS - DAY),
    ].join('\n');
    const jobsText = [
      launchRow('RQ-E00', NOW_MS - 2 * DAY - 2 * HOUR), finishRow('RQ-E00', NOW_MS - 2 * DAY, true),
      launchRow('RQ-E01', NOW_MS - 2 * DAY - HOUR), publishEmptyRow('RQ-E01', NOW_MS - 2 * DAY + HOUR),
      launchRow('RQ-E10', NOW_MS - DAY - 2 * HOUR), finishRow('RQ-E10', NOW_MS - DAY, true),
      launchRow('RQ-E11', NOW_MS - DAY - HOUR), finishRow('RQ-E11', NOW_MS - DAY + HOUR, true),
      launchRow('RQ-OK1', NOW_MS - 2 * DAY), publishPrRow('RQ-OK1', NOW_MS - DAY), outcomeRow('RQ-OK1', 'MERGED', NOW_MS - 12 * HOUR),
      launchRow('RQ-OPEN1', NOW_MS - DAY),
    ].join('\n');
    const full = foldAll(picksText, jobsText);
    expect(full.cells).toHaveLength(1);
    const cell = full.cells[0]!;
    expect(cell.cls).toBe('empty');
    expect(cell.picks).toBe(4);
    expect(cell.days).toHaveLength(2);
    expect(cell.examples).toEqual(['RQ-E00', 'RQ-E01', 'RQ-E10']);
    expect(cell.jobTypes).toEqual([{ text: 'work', count: 4 }]);
    expect(cell.bases).toEqual([{ text: 'learned', count: 4 }]);
    expect(cell.repos).toEqual([{ text: 'phantom', count: 4 }]);
    expect(cell.firstSeen).toBe(iso(NOW_MS - DAY - 3 * HOUR));
    expect(cell.lastSeen).toBe(iso(NOW_MS - 2 * HOUR));
    expect(full.window).toMatchObject({ total: 6, merged: 1, open: 1, unknown: 0 });
    expect(full.window.adverse.get('empty')).toBe(4);
  });

  it('keeps never-launched picks out of cells until every guard holds', () => {
    // Four old picks, zero ledger rows — but the jobs tail's first dated
    // row is only one day old, so a launch could have been cut: unknown.
    const picks = pickSeries('RQ-N', 2, 2, (d, i) => NOW_MS - d * DAY - i * HOUR - 30 * HOUR).join('\n');
    const shallow = foldAll(picks, [launchRow('RQ-OTHER', NOW_MS - DAY)].join('\n'));
    expect(shallow.cells).toEqual([]);
    expect(shallow.window.unknown).toBe(4);

    // Same picks, but the ledger reaches back past the funding times and
    // the fleet launched other work — now the absence is proven.
    const deep = foldAll(picks, [launchRow('RQ-OTHER', NOW_MS - 6 * DAY), launchRow('RQ-OTHER2', NOW_MS - DAY)].join('\n'));
    expect(deep.cells).toHaveLength(1);
    expect(deep.cells[0]!.cls).toBe('never-launched');
    expect(deep.cells[0]!.picks).toBe(4);
  });

  it('sorts emitted cells busiest-first and quotes friction-sourced picks', () => {
    const picks = [
      // Four aborted picks across two days.
      ...pickSeries('RQ-A', 2, 2, (d, i) => NOW_MS - d * DAY - i * HOUR - HOUR),
      // Three unmerged picks across two days (one friction-sourced).
      pickRow('RQ-U1', NOW_MS - 3 * DAY, { jobType: 'friction', frictionId: 'friction-1' }),
      pickRow('RQ-U2', NOW_MS - 2 * DAY),
      pickRow('RQ-U3', NOW_MS - DAY),
    ].join('\n');
    const jobsRows = [
      ...seriesIds('RQ-A', 2, 2).flatMap((id, i) => [
        launchRow(id, NOW_MS - (i % 2 + 1) * DAY - 2 * HOUR),
        publishAbortRow(id, NOW_MS - (i % 2 + 1) * DAY - HOUR),
      ]),
      launchRow('RQ-U1', NOW_MS - 3 * DAY), outcomeRow('RQ-U1', 'CLOSED', NOW_MS - 2 * DAY),
      launchRow('RQ-U2', NOW_MS - 2 * DAY), outcomeRow('RQ-U2', 'CLOSED', NOW_MS - DAY),
      launchRow('RQ-U3', NOW_MS - DAY), outcomeRow('RQ-U3', 'CLOSED', NOW_MS - 12 * HOUR),
      launchRow('RQ-FLEET', NOW_MS - 5 * DAY), // deep coverage anchor for the whole tail
      launchRow('RQ-FLEET', NOW_MS - DAY),
    ];
    const { cells, window } = foldAll(picks, jobsRows.join('\n'));
    expect(cells.map((c) => c.cls)).toEqual(['aborted', 'unmerged']);
    expect(cells[0]!.picks).toBe(4);
    expect(cells[1]!.picks).toBe(3);
    expect(cells[1]!.friction).toBe(1);
    expect(cells[1]!.jobTypes).toEqual([{ text: 'work', count: 2 }, { text: 'friction', count: 1 }]);
    expect(window.adverse.get('aborted')).toBe(4);
    expect(window.adverse.get('unmerged')).toBe(3);
  });
});

describe('selectorPicksBacklogItems', () => {
  let home: string;
  let saved: { HOME?: string; ASHLR_HOME?: string; ASHLR_RUNS_DIR?: string };
  const NOW = new Date(NOW_MS);

  beforeEach(async () => {
    saved = { HOME: process.env.HOME, ASHLR_HOME: process.env.ASHLR_HOME, ASHLR_RUNS_DIR: process.env.ASHLR_RUNS_DIR };
    delete process.env.ASHLR_HOME;
    delete process.env.ASHLR_RUNS_DIR;
    home = await mkdtemp(join(tmpdir(), 'selector-picks-backlog-'));
    process.env.HOME = home;
  });
  afterEach(async () => {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    vi.restoreAllMocks();
    await rm(home, { recursive: true, force: true });
  });

  /** A runs dir whose selector/ and metrics/ carry the given picks and jobs rows. */
  async function runsDir(name: string, picks: string[], jobs: string[] = []): Promise<string> {
    const dir = join(home, name);
    await mkdir(join(dir, 'selector'), { recursive: true });
    await mkdir(join(dir, 'metrics'), { recursive: true });
    await writeFile(join(dir, 'selector', 'picks.jsonl'), picks.length ? picks.join('\n') + '\n' : '');
    await writeFile(join(dir, 'metrics', 'jobs.jsonl'), jobs.length ? jobs.join('\n') + '\n' : '');
    return dir;
  }

  /** Three empty-finishing picks across three days — the recurring 'empty' cell. */
  const emptyPicks = () => [
    pickRow('RQ-E1', NOW_MS - 3 * DAY),
    pickRow('RQ-E2', NOW_MS - 2 * DAY),
    pickRow('RQ-E3', NOW_MS - DAY),
  ];
  const emptyJobs = () => [
    launchRow('RQ-E1', NOW_MS - 3 * DAY), finishRow('RQ-E1', NOW_MS - 2 * DAY, true),
    launchRow('RQ-E2', NOW_MS - 2 * DAY), publishEmptyRow('RQ-E2', NOW_MS - DAY),
    launchRow('RQ-E3', NOW_MS - DAY), finishRow('RQ-E3', NOW_MS - 12 * HOUR, true),
    launchRow('RQ-FLEET', NOW_MS - 6 * DAY), // deep coverage anchor
  ];

  it('emits a selector-picks item for a recurring empty class with joined evidence', async () => {
    const dir = await runsDir('runs-empty', emptyPicks(), emptyJobs());
    const items = await selectorPicksBacklogItems({ repo: 'ashlrai/phantom', runsDir: dir, now: NOW });
    expect(items).toHaveLength(1);
    const [item] = items;
    expect(item).toMatchObject({ priority: 3, repo: 'ashlrai/phantom', area: 'selector-picks' });
    expect(item!.id).toMatch(/^selector-picks-empty-[0-9a-f]{16}$/);
    expect(item!.title).toContain('finishing empty');
    expect(validBacklogItem(item)).not.toBeNull();
    expect(item!.prompt).toContain('RQ-E1');
    expect(item!.prompt).toContain('picks.jsonl');
    expect(item!.prompt).toContain('predictedValue');
    expect(item!.prompt).toContain('3 pick(s)');
    expect(item!.prompt).toContain('0 merged/held');
    expect(item!.prompt).toContain('no-change');
  });

  it('emits nothing for missing evidence, a withheld jobs ledger, another repository, or below-bar cells', async () => {
    expect(await selectorPicksBacklogItems({ repo: 'ashlrai/phantom', runsDir: join(home, 'nope'), now: NOW })).toEqual([]);

    const noPicks = await runsDir('runs-nopicks', [], [launchRow('RQ-X', NOW_MS - DAY)]);
    expect(await selectorPicksBacklogItems({ repo: 'ashlrai/phantom', runsDir: noPicks, now: NOW })).toEqual([]);

    // Picks present but no jobs.jsonl at all — the comparison cannot run.
    const noJobs = join(home, 'runs-nojobs');
    await mkdir(join(noJobs, 'selector'), { recursive: true });
    await writeFile(join(noJobs, 'selector', 'picks.jsonl'), emptyPicks().join('\n') + '\n');
    expect(await selectorPicksBacklogItems({ repo: 'ashlrai/phantom', runsDir: noJobs, now: NOW })).toEqual([]);

    // Injected withheld ledger — same honesty through the test seam.
    const dir = await runsDir('runs-thin', [pickRow('RQ-E1', NOW_MS - DAY)]);
    expect(await selectorPicksBacklogItems({ repo: 'ashlrai/phantom', runsDir: dir, jobsText: null, now: NOW })).toEqual([]);

    // An empty ledger leaves every pick unknown — still nothing to emit.
    expect(await selectorPicksBacklogItems({ repo: 'ashlrai/phantom', runsDir: dir, jobsText: '', now: NOW })).toEqual([]);

    // Below the bars and the repo gate.
    const recurring = await runsDir('runs-rec', emptyPicks(), emptyJobs());
    expect(await selectorPicksBacklogItems({ repo: 'ashlrai/lexicon', runsDir: recurring, now: NOW })).toEqual([]);
    expect(await selectorPicksBacklogItems({ repo: '', runsDir: recurring, now: NOW })).toEqual([]);
  });

  it('says merged and open picks are context, and never-launched needs its guards', async () => {
    // Three picks: two merged, one still open — nothing adverse, no items.
    const calmPicks = [pickRow('RQ-M1', NOW_MS - 3 * DAY), pickRow('RQ-M2', NOW_MS - 2 * DAY), pickRow('RQ-M3', NOW_MS - DAY)];
    const calmJobs = [
      launchRow('RQ-M1', NOW_MS - 3 * DAY), outcomeRow('RQ-M1', 'MERGED', NOW_MS - 2 * DAY),
      launchRow('RQ-M2', NOW_MS - 2 * DAY), outcomeRow('RQ-M2', 'MERGED', NOW_MS - DAY),
      launchRow('RQ-M3', NOW_MS - DAY),
      launchRow('RQ-FLEET', NOW_MS - 5 * DAY),
    ];
    const calm = await runsDir('runs-calm', calmPicks, calmJobs);
    expect(await selectorPicksBacklogItems({ repo: 'ashlrai/phantom', runsDir: calm, now: NOW })).toEqual([]);

    // Three old picks with zero ledger rows, fleet activity and deep coverage → never-launched cell.
    const lostPicks = [
      pickRow('RQ-N1', NOW_MS - 4 * DAY), pickRow('RQ-N2', NOW_MS - 3 * DAY), pickRow('RQ-N3', NOW_MS - 2 * DAY),
    ];
    const lostJobs = [launchRow('RQ-FLEET', NOW_MS - 6 * DAY), launchRow('RQ-FLEET', NOW_MS - DAY)];
    const lost = await runsDir('runs-lost', lostPicks, lostJobs);
    const items = await selectorPicksBacklogItems({ repo: 'ashlrai/phantom', runsDir: lost, now: NOW });
    expect(items).toHaveLength(1);
    expect(items[0]!.id).toMatch(/^selector-picks-never-launched-[0-9a-f]{16}$/);
    expect(items[0]!.prompt).toContain('never appears in metrics/jobs.jsonl');
    expect(items[0]!.prompt).toContain('fundedIds');

    // Same picks but the jobs tail only reaches back one day — coverage cannot prove the absence.
    const shallowJobs = [launchRow('RQ-FLEET', NOW_MS - DAY)];
    const shallow = await runsDir('runs-shallow', lostPicks, shallowJobs);
    expect(await selectorPicksBacklogItems({ repo: 'ashlrai/phantom', runsDir: shallow, now: NOW })).toEqual([]);
  });

  it('derives stable ids so a refresh re-adds nothing and honours the limit', async () => {
    const picks = [
      ...emptyPicks(),
      pickRow('RQ-A1', NOW_MS - 3 * DAY), pickRow('RQ-A2', NOW_MS - 2 * DAY), pickRow('RQ-A3', NOW_MS - DAY),
    ];
    const jobs = [
      ...emptyJobs(),
      launchRow('RQ-A1', NOW_MS - 3 * DAY), publishAbortRow('RQ-A1', NOW_MS - 2 * DAY),
      launchRow('RQ-A2', NOW_MS - 2 * DAY), publishAbortRow('RQ-A2', NOW_MS - DAY),
      launchRow('RQ-A3', NOW_MS - DAY), publishAbortRow('RQ-A3', NOW_MS - 12 * HOUR),
    ];
    const dir = await runsDir('runs-stable', picks, jobs);
    const opts = { repo: 'ashlrai/phantom', runsDir: dir, now: NOW };
    const first = await selectorPicksBacklogItems(opts);
    const second = await selectorPicksBacklogItems(opts);
    expect(second.map((i) => i.id)).toEqual(first.map((i) => i.id));
    expect(first).toHaveLength(2);
    const ids = first.map((i) => i.id);
    expect(ids.some((i) => i.startsWith('selector-picks-aborted-'))).toBe(true);
    expect(ids.some((i) => i.startsWith('selector-picks-empty-'))).toBe(true);
    const limited = await selectorPicksBacklogItems({ ...opts, limit: 1 });
    expect(limited).toHaveLength(1);
    expect(first.map((i) => i.id)).toContain(limited[0]!.id);
  });

  it('appends selector-picks items through discovery and dedupes on refresh', async () => {
    const runs = join(home, '.ashlr-runs');
    await mkdir(join(runs, 'selector'), { recursive: true });
    await mkdir(join(runs, 'metrics'), { recursive: true });
    // discoverBacklog anchors the window on the real clock, so these rows
    // are stamped relative to Date.now() rather than the fixed NOW_MS.
    const realNow = Date.now();
    const at = (d: number): number => realNow - d * DAY;
    await writeFile(join(runs, 'selector', 'picks.jsonl'), [
      pickRow('RQ-E1', at(3)), pickRow('RQ-E2', at(2)), pickRow('RQ-E3', at(1)),
    ].join('\n') + '\n');
    await writeFile(join(runs, 'metrics', 'jobs.jsonl'), [
      launchRow('RQ-E1', at(3)), finishRow('RQ-E1', at(2), true),
      launchRow('RQ-E2', at(2)), publishEmptyRow('RQ-E2', at(1)),
      launchRow('RQ-E3', at(1)), finishRow('RQ-E3', realNow - 30 * 60 * 1000, true),
      launchRow('RQ-FLEET', at(6)),
    ].join('\n') + '\n');
    const greenGh = async (args: string[]) => {
      const p = args[4] ?? '';
      if (p === 'repos/ashlrai/phantom') return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n{"default_branch":"master"}', stderr: '' };
      return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n[]', stderr: '' };
    };
    const first = await discoverBacklog('ashlrai/phantom', { gh: greenGh });
    const selItems = first.items.filter((i) => i.id.startsWith('selector-picks-'));
    expect(selItems).toHaveLength(1);
    expect(selItems[0]!.area).toBe('selector-picks');
    expect(first.items.every((i) => validBacklogItem(i) !== null)).toBe(true);
    expect(appendUserBacklogItems(selItems)).toBe(1);
    const second = await discoverBacklog('ashlrai/phantom', { gh: greenGh });
    expect(appendUserBacklogItems(second.items.filter((i) => i.id.startsWith('selector-picks-')))).toBe(0);
    expect(readUserBacklogItems().filter((i) => i.id.startsWith('selector-picks-'))).toHaveLength(1);
  });
});
