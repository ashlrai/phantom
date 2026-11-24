import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  foldGapJobOutcomes,
  foldGapProposalJournal,
  GAP_PROPOSAL_MIN_DAYS,
  GAP_PROPOSAL_WINDOW_HOURS,
  gapProposalBacklogItems,
  gapProposalCells,
} from '../src/core/improve/gap-proposal-backlog.js';
import { discoverBacklog } from '../src/core/improve/discover.js';
import { appendUserBacklogItems, readUserBacklogItems, validBacklogItem } from '../src/core/cloud/backlog.js';

const DAY = 86_400_000;
const HOUR = 3_600_000;
const J = (o: Record<string, unknown>): string => JSON.stringify(o);

/** Fixed evaluation instant; fixture timestamps are ISO-8601 UTC like the writers emit. */
const NOW_MS = Date.parse('2026-11-23T12:00:00.000Z');
const iso = (ms: number): string => new Date(ms).toISOString();

/** One proposal-journal row in gap-proposal-record.ts's writer shape. */
function propRow(id: string, title: string, atMs: number, repo = 'phantom'): string {
  return J({ at: iso(atMs), id, title, repo });
}

/** perDay proposal rows for one gap id spread across `days` distinct UTC days ending today. */
function proposalSeries(id: string, title: string, days: number, perDay: number, repo = 'phantom'): string[] {
  const rows: string[] = [];
  for (let d = 0; d < days; d++) {
    for (let i = 0; i < perDay; i++) {
      rows.push(propRow(id, title, NOW_MS - d * DAY - i * HOUR - HOUR, repo));
    }
  }
  return rows;
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

/** The production fold: proposal journal text plus the jobs tail, as gapProposalBacklogItems reads them. */
function foldAll(proposals: string, jobs: string | null, nowMs = NOW_MS) {
  const p = foldGapProposalJournal(proposals, nowMs, GAP_PROPOSAL_WINDOW_HOURS);
  const j = jobs === null ? null : foldGapJobOutcomes(jobs, nowMs, GAP_PROPOSAL_WINDOW_HOURS);
  return { fold: p, jobs: j, cells: gapProposalCells(p, j) };
}

describe('foldGapProposalJournal', () => {
  it('folds in-window rows per gap id and keeps only contract-valid records', () => {
    const rows = [
      propRow('GAPAAA1111BB', 'Add the frobnicate retry', NOW_MS - DAY),
      propRow('GAPAAA1111BB', 'Add the frobnicate retry', NOW_MS - 2 * DAY),
      propRow('GAPCCC2222DD', 'Document the widget', NOW_MS - HOUR),
      // Malformed and off-contract rows never count.
      'not json',
      '{"at":',
      J({ at: 'not-a-date', id: 'GAPDDD', title: 'x', repo: 'phantom' }),
      J({ id: 'GAPEEE', title: 'no timestamp', repo: 'phantom' }),
      J({ at: iso(NOW_MS - HOUR), title: 'no id', repo: 'phantom' }),
      J({ at: iso(NOW_MS - HOUR), id: 'GAPFFF', repo: 'phantom' }),
      J({ at: iso(NOW_MS - HOUR), id: 'GAPGGG', title: '   ', repo: 'phantom' }),
      J({ at: iso(NOW_MS - HOUR), id: 'has space', title: 'bad id', repo: 'phantom' }),
      J({ at: iso(NOW_MS - HOUR), id: '../escape', title: 'bad id', repo: 'phantom' }),
      // Out-of-window and future-dated rows contribute nothing.
      propRow('GAPOLD0000ZZ', 'Stale gap', NOW_MS - GAP_PROPOSAL_WINDOW_HOURS * 3_600_000 - DAY),
      propRow('GAPFUT0000ZZ', 'Future gap', NOW_MS + 600_000),
      // Missing repo records as unrecorded, never guessed.
      J({ at: iso(NOW_MS - HOUR), id: 'GAPHHH4444II', title: 'Repo-less gap' }),
      '',
    ];
    const fold = foldGapProposalJournal(rows.join('\n'), NOW_MS, GAP_PROPOSAL_WINDOW_HOURS);
    expect(fold.malformed).toBe(2);
    expect([...fold.gaps.keys()].sort()).toEqual(['GAPAAA1111BB', 'GAPCCC2222DD', 'GAPHHH4444II']);
    const a = fold.gaps.get('GAPAAA1111BB')!;
    expect(a.proposals).toBe(2);
    expect(a.days.size).toBe(2);
    expect(a.title).toBe('Add the frobnicate retry');
    expect(a.repos.get('phantom')).toBe(2);
    expect(fold.gaps.get('GAPHHH4444II')!.repos.get('unrecorded')).toBe(1);
  });

  it('quotes the newest recorded title when writes disagree', () => {
    const rows = [
      propRow('GAPAAA', 'First wording', NOW_MS - 3 * DAY),
      propRow('GAPAAA', 'Newer wording', NOW_MS - DAY),
      propRow('GAPAAA', 'Newest wording', NOW_MS - HOUR),
    ];
    const fold = foldGapProposalJournal(rows.join('\n'), NOW_MS, GAP_PROPOSAL_WINDOW_HOURS);
    expect(fold.gaps.get('GAPAAA')!.title).toBe('Newest wording');
  });
});

describe('foldGapJobOutcomes', () => {
  it('tallies launches, finishes, publishes and resolved outcomes for RQ-PHX-GAP* jobs only', () => {
    const job = 'RQ-PHX-GAPAAA1111BB';
    const rows = [
      launchRow(job, NOW_MS - 5 * DAY),
      finishRow(job, NOW_MS - 4 * DAY, true),
      launchRow(job, NOW_MS - 3 * DAY),
      publishEmptyRow(job, NOW_MS - 2 * DAY),
      launchRow(job, NOW_MS - DAY),
      publishPrRow(job, NOW_MS - 20 * HOUR),
      outcomeRow(job, 'MERGED', NOW_MS - 10 * HOUR),
      // A second gap job with different evidence.
      launchRow('RQ-PHX-GAPCCC2222DD', NOW_MS - DAY),
      finishRow('RQ-PHX-GAPCCC2222DD', NOW_MS - 12 * HOUR, false),
      publishAbortRow('RQ-PHX-GAPCCC2222DD', NOW_MS - 11 * HOUR),
      outcomeRow('RQ-PHX-GAPCCC2222DD', 'CLOSED', NOW_MS - HOUR),
      // Non-gap jobs, node-pool rows, undated and out-of-window rows never count.
      launchRow('RQ-PHX-OTHERJOB', NOW_MS - DAY),
      finishRow('RQ-PHX-OTHERJOB', NOW_MS - DAY, true),
      J({ schema: 'fleet.session-pool.v1', event: 'launch', job: 'sess-1:2', jobId: job, ts: iso(NOW_MS - DAY) }),
      J({ event: 'launch', job, ts: 'not-a-date' }),
      launchRow(job, NOW_MS - GAP_PROPOSAL_WINDOW_HOURS * 3_600_000 - DAY),
      'not json',
      '',
    ];
    const tallies = foldGapJobOutcomes(rows.join('\n'), NOW_MS, GAP_PROPOSAL_WINDOW_HOURS);
    expect([...tallies.keys()].sort()).toEqual(['RQ-PHX-GAPAAA1111BB', 'RQ-PHX-GAPCCC2222DD']);
    const a = tallies.get(job)!;
    expect(a.launches).toBe(3);
    expect(a.finishes).toBe(1);
    expect(a.emptyFinishes).toBe(2); // the empty:true finish plus the class:'empty' publish
    expect(a.prs).toBe(1);
    expect(a.aborts).toBe(0);
    expect(a.merged).toBe(1);
    expect(a.closed).toBe(0);
    expect(a.resolvedOther).toBe(0);
    const c = tallies.get('RQ-PHX-GAPCCC2222DD')!;
    expect(c.launches).toBe(1);
    expect(c.finishes).toBe(1);
    expect(c.emptyFinishes).toBe(0);
    expect(c.aborts).toBe(1);
    expect(c.closed).toBe(1);
  });

  it('counts other resolved phases and unclassified publishes honestly', () => {
    const job = 'RQ-PHX-GAPDDD3333EE';
    const rows = [
      outcomeRow(job, 'DONE-NOOP', NOW_MS - DAY),
      J({ event: 'publish', job, ts: iso(NOW_MS - DAY) }), // no class, no url — no publish verdict
      J({ event: 'publish', job, class: 'unknown', url: 'https://example.invalid/pr/x', ts: iso(NOW_MS - DAY) }), // unclassified with url — PR claim
      J({ event: 'publish', job, class: 'unknown', ts: iso(NOW_MS - DAY) }), // unclassified without url — nothing
    ];
    const tally = foldGapJobOutcomes(rows.join('\n'), NOW_MS, GAP_PROPOSAL_WINDOW_HOURS).get(job)!;
    expect(tally.resolvedOther).toBe(1);
    expect(tally.prs).toBe(1);
    expect(tally.emptyFinishes).toBe(0);
    expect(tally.aborts).toBe(0);
  });
});

describe('gapProposalCells', () => {
  it('emits a cell only at the proposal and day bars', () => {
    // Below the proposal bar: two writes across two days.
    const few = foldAll(proposalSeries('GAPAAA', 'Gap A', GAP_PROPOSAL_MIN_DAYS, 1).join('\n'), null);
    expect(few.fold.gaps.get('GAPAAA')!.proposals).toBe(GAP_PROPOSAL_MIN_DAYS);
    expect(few.cells).toEqual([]);

    // Below the day bar: enough writes but all on one UTC day.
    const oneDay = foldAll(
      [0, 1, 2].map((i) => propRow('GAPBBB', 'Gap B', NOW_MS - i * HOUR)).join('\n'),
      null,
    );
    expect(oneDay.fold.gaps.get('GAPBBB')!.days.size).toBe(1);
    expect(oneDay.cells).toEqual([]);

    // At the bars: three writes across two days.
    const recurring = foldAll(
      [
        propRow('GAPCCC', 'Gap C', NOW_MS - 3 * DAY),
        propRow('GAPCCC', 'Gap C', NOW_MS - 2 * DAY),
        propRow('GAPCCC', 'Gap C', NOW_MS - DAY),
      ].join('\n'),
      null,
    );
    expect(recurring.cells).toHaveLength(1);
    const cell = recurring.cells[0]!;
    expect(cell.id).toBe('GAPCCC');
    expect(cell.jobId).toBe('RQ-PHX-GAPCCC');
    expect(cell.proposals).toBe(3);
    expect(cell.days).toHaveLength(3);
    expect(cell.jobs).toBeNull();
    expect(cell.lowerBound).toBe(false);
  });

  it('joins job tallies and sorts cells worst-first', () => {
    const proposals = [
      ...proposalSeries('GAPAAA', 'Gap A', 2, 2),  // 4 proposals — emits first
      ...proposalSeries('GAPBBB', 'Gap B', 2, 1),  // wait: 2 proposals — below bar
    ].join('\n');
    const jobs = [
      launchRow('RQ-PHX-GAPAAA', NOW_MS - 2 * DAY),
      finishRow('RQ-PHX-GAPAAA', NOW_MS - DAY, true),
      outcomeRow('RQ-PHX-GAPAAA', 'CLOSED', NOW_MS - 12 * HOUR),
    ].join('\n');
    const { cells } = foldAll(proposals, jobs);
    expect(cells).toHaveLength(1);
    expect(cells[0]!.id).toBe('GAPAAA');
    expect(cells[0]!.jobs).toMatchObject({ launches: 1, finishes: 1, emptyFinishes: 1, closed: 1 });
    expect(cells[0]!.jobsLowerBound).toBe(false);

    // A second recurring gap sorts after the busier one.
    const more = foldAll(
      [
        ...proposalSeries('GAPAAA', 'Gap A', 2, 2),
        propRow('GAPDDD', 'Gap D', NOW_MS - 2 * DAY),
        propRow('GAPDDD', 'Gap D', NOW_MS - DAY),
        propRow('GAPDDD', 'Gap D', NOW_MS - HOUR),
      ].join('\n'),
      jobs,
    );
    expect(more.cells.map((c) => c.id)).toEqual(['GAPAAA', 'GAPDDD']);
    expect(more.cells[1]!.jobs).toMatchObject({ launches: 0, merged: 0 });
  });
});

describe('gapProposalBacklogItems', () => {
  let home: string;
  let saved: { HOME?: string; ASHLR_HOME?: string; ASHLR_RUNS_DIR?: string };
  const NOW = new Date(NOW_MS);

  beforeEach(async () => {
    saved = { HOME: process.env.HOME, ASHLR_HOME: process.env.ASHLR_HOME, ASHLR_RUNS_DIR: process.env.ASHLR_RUNS_DIR };
    delete process.env.ASHLR_HOME;
    delete process.env.ASHLR_RUNS_DIR;
    home = await mkdtemp(join(tmpdir(), 'gap-proposal-backlog-'));
    process.env.HOME = home;
  });
  afterEach(async () => {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    vi.restoreAllMocks();
    await rm(home, { recursive: true, force: true });
  });

  /** A runs dir whose metrics/ carries the given proposal rows and jobs rows. */
  async function runsDir(name: string, proposals: string[], jobs: string[] = []): Promise<string> {
    const dir = join(home, name);
    await mkdir(join(dir, 'metrics'), { recursive: true });
    await writeFile(join(dir, 'metrics', 'gap-proposed.jsonl'), proposals.join('\n') + '\n');
    await writeFile(join(dir, 'metrics', 'jobs.jsonl'), jobs.join('\n') + '\n');
    return dir;
  }

  const recurringProposals = () => [
    propRow('GAPAAA1111BB', 'Add the frobnicate retry', NOW_MS - 3 * DAY),
    propRow('GAPAAA1111BB', 'Add the frobnicate retry', NOW_MS - 2 * DAY),
    propRow('GAPAAA1111BB', 'Add the frobnicate retry', NOW_MS - DAY),
  ];

  it('emits a gap-proposal item for a recurring re-queue with joined job evidence', async () => {
    const dir = await runsDir('runs-gap', recurringProposals(), [
      launchRow('RQ-PHX-GAPAAA1111BB', NOW_MS - 3 * DAY),
      finishRow('RQ-PHX-GAPAAA1111BB', NOW_MS - 2 * DAY, true),
      outcomeRow('RQ-PHX-GAPAAA1111BB', 'CLOSED', NOW_MS - DAY),
    ]);
    const items = await gapProposalBacklogItems({ repo: 'ashlrai/phantom', runsDir: dir, now: NOW });
    expect(items).toHaveLength(1);
    const [item] = items;
    expect(item).toMatchObject({ priority: 3, repo: 'ashlrai/phantom', area: 'gap-proposal' });
    expect(item!.id).toMatch(/^gap-proposal-[0-9a-f]{16}$/);
    expect(item!.title).toContain('frobnicate retry');
    expect(validBacklogItem(item)).not.toBeNull();
    expect(item!.prompt).toContain('GAPAAA1111BB');
    expect(item!.prompt).toContain('RQ-PHX-GAPAAA1111BB');
    expect(item!.prompt).toContain('gap-proposed.jsonl');
    expect(item!.prompt).toContain('jobs gaps');
    expect(item!.prompt).toContain('1 launch(es)');
    expect(item!.prompt).toContain('1 empty finish(es)/publish(es)');
    expect(item!.prompt).toContain('1 CLOSED outcome(s)');
    expect(item!.prompt).toContain('no-change');
    expect(item!.prompt).not.toContain('lower bound');
  });

  it('emits nothing for missing evidence, another repository, or below-bar cells', async () => {
    expect(await gapProposalBacklogItems({ repo: 'ashlrai/phantom', runsDir: join(home, 'nope'), now: NOW })).toEqual([]);

    const empty = await runsDir('runs-empty', []);
    expect(await gapProposalBacklogItems({ repo: 'ashlrai/phantom', runsDir: empty, now: NOW })).toEqual([]);

    // A directory instead of a file.
    const notFile = join(home, 'runs-notfile');
    await mkdir(join(notFile, 'metrics', 'gap-proposed.jsonl'), { recursive: true });
    expect(await gapProposalBacklogItems({ repo: 'ashlrai/phantom', runsDir: notFile, now: NOW })).toEqual([]);

    // Below the bars: one proposal, or three on one day.
    const thin = await runsDir('runs-thin', [propRow('GAPAAA', 'One gap', NOW_MS - DAY)]);
    expect(await gapProposalBacklogItems({ repo: 'ashlrai/phantom', runsDir: thin, now: NOW })).toEqual([]);
    const oneDay = await runsDir('runs-oneday', [
      propRow('GAPBBB', 'Day gap', NOW_MS - 2 * HOUR),
      propRow('GAPBBB', 'Day gap', NOW_MS - HOUR),
      propRow('GAPBBB', 'Day gap', NOW_MS),
    ]);
    expect(await gapProposalBacklogItems({ repo: 'ashlrai/phantom', runsDir: oneDay, now: NOW })).toEqual([]);
    expect(await gapProposalBacklogItems({ repo: 'ashlrai/lexicon', runsDir: oneDay, now: NOW })).toEqual([]);
    expect(await gapProposalBacklogItems({ repo: '', runsDir: oneDay, now: NOW })).toEqual([]);
  });

  it('says outcome evidence is unknown — never zero — when the jobs ledger is withheld', async () => {
    const dir = join(home, 'runs-nojobs');
    await mkdir(join(dir, 'metrics'), { recursive: true });
    await writeFile(join(dir, 'metrics', 'gap-proposed.jsonl'), recurringProposals().join('\n') + '\n');
    const items = await gapProposalBacklogItems({ repo: 'ashlrai/phantom', runsDir: dir, now: NOW });
    expect(items).toHaveLength(1);
    expect(items[0]!.prompt).toContain('unknown — not zero');
    expect(items[0]!.prompt).not.toContain('0 launch(es)');
  });

  it('derives stable ids so a refresh re-adds nothing and honours the limit', async () => {
    const dir = await runsDir('runs-stable', [
      ...proposalSeries('GAPAAA', 'Gap A', 2, 2),
      propRow('GAPDDD', 'Gap D', NOW_MS - 2 * DAY),
      propRow('GAPDDD', 'Gap D', NOW_MS - DAY),
      propRow('GAPDDD', 'Gap D', NOW_MS - HOUR),
    ]);
    const opts = { repo: 'ashlrai/phantom', runsDir: dir, now: NOW };
    const first = await gapProposalBacklogItems(opts);
    const second = await gapProposalBacklogItems(opts);
    expect(second.map((i) => i.id)).toEqual(first.map((i) => i.id));
    expect(first).toHaveLength(2);
    const limited = await gapProposalBacklogItems({ ...opts, limit: 1 });
    expect(limited).toHaveLength(1);
    expect(first.map((i) => i.id)).toContain(limited[0]!.id);
  });

  it('appends gap-proposal items through discovery and dedupes on refresh', async () => {
    const runs = join(home, '.ashlr-runs');
    await mkdir(join(runs, 'metrics'), { recursive: true });
    // discoverBacklog anchors the window on the real clock, so these rows
    // are stamped relative to Date.now() rather than the fixed NOW_MS.
    const realNow = Date.now();
    const at = (d: number): number => realNow - d * DAY;
    await writeFile(join(runs, 'metrics', 'gap-proposed.jsonl'), [
      propRow('GAPAAA1111BB', 'Add the frobnicate retry', at(3)),
      propRow('GAPAAA1111BB', 'Add the frobnicate retry', at(2)),
      propRow('GAPAAA1111BB', 'Add the frobnicate retry', at(1)),
    ].join('\n') + '\n');
    await writeFile(join(runs, 'metrics', 'jobs.jsonl'), [
      launchRow('RQ-PHX-GAPAAA1111BB', at(3)),
      finishRow('RQ-PHX-GAPAAA1111BB', at(2), true),
    ].join('\n') + '\n');
    const greenGh = async (args: string[]) => {
      const p = args[4] ?? '';
      if (p === 'repos/ashlrai/phantom') return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n{"default_branch":"master"}', stderr: '' };
      return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n[]', stderr: '' };
    };
    const first = await discoverBacklog('ashlrai/phantom', { gh: greenGh });
    const gapItems = first.items.filter((i) => i.id.startsWith('gap-proposal-'));
    expect(gapItems).toHaveLength(1);
    expect(gapItems[0]!.area).toBe('gap-proposal');
    expect(first.items.every((i) => validBacklogItem(i) !== null)).toBe(true);
    expect(appendUserBacklogItems(gapItems)).toBe(1);
    const second = await discoverBacklog('ashlrai/phantom', { gh: greenGh });
    expect(appendUserBacklogItems(second.items.filter((i) => i.id.startsWith('gap-proposal-')))).toBe(0);
    expect(readUserBacklogItems().filter((i) => i.id.startsWith('gap-proposal-'))).toHaveLength(1);
  });
});
