import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  foldJobCostRows,
  JOB_COST_MIN_CORRUPT,
  JOB_COST_MIN_UNPRICED,
  jobCostBacklogItems,
  jobCostCells,
  parseJobCostJournal,
  parseJobCostJournalEntry,
} from '../src/core/improve/job-cost-backlog.js';
import { discoverBacklog } from '../src/core/improve/discover.js';
import { appendUserBacklogItems, readUserBacklogItems, validBacklogItem } from '../src/core/cloud/backlog.js';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const J = (o: Record<string, unknown>): string => JSON.stringify(o);
const SCHEMA = 'ashlr.job-cost-model/v1';

/** One writer-shaped finish row; overrides merge over the unpriced default. */
const finishRow = (over: Record<string, unknown>): Record<string, unknown> => ({
  schema: SCHEMA,
  job: 'RQ-JOB-1',
  lane: 'claude',
  ts: '2026-11-23T10:00:00Z',
  realSpendUsd: null,
  modeledValueUsd: null,
  method: 'none',
  inputs: {},
  source: null,
  confidence: null,
  reason: 'claude subscription lane logs no tokens per job; window share needs usage-readings.log and a verified plan price',
  ...over,
});

/** One writer-shaped real-spend-unmatched row. */
const unmatchedRow = (over: Record<string, unknown>): Record<string, unknown> => ({
  schema: SCHEMA,
  job: 'RQ-SPEND-1',
  lane: 'claude-api',
  ts: '2026-11-23T11:00:00Z',
  realSpendUsd: 1.5,
  modeledValueUsd: null,
  method: 'real-spend-unmatched',
  inputs: { model: 'sonnet' },
  source: 'metrics/api-spend.jsonl total_cost_usd (cost_estimated false)',
  confidence: 'high',
  reason: 'spend row has no finish row for its job at or after it',
  ...over,
});

describe('parseJobCostJournalEntry', () => {
  it('accepts a writer-shaped row and derives priced/unpriced from the values', () => {
    const unpriced = parseJobCostJournalEntry(finishRow({}));
    expect(unpriced).not.toBeNull();
    expect(unpriced!.priced).toBe(false);
    expect(unpriced!.unmatchedSpend).toBe(false);
    expect(unpriced!.utcDay).toBe('2026-11-23');

    const priced = parseJobCostJournalEntry(finishRow({
      method: 'tokens-x-list-input-rate', modeledValueUsd: 0.0123, confidence: 'low',
      reason: null, inputs: { model: 'gpt-5' }, source: 'price table fetched 2026-11-20',
    }));
    expect(priced!.priced).toBe(true);

    // A metered finish whose spend join found nothing is still unpriced.
    const meteredMiss = parseJobCostJournalEntry(finishRow({
      lane: 'claude-api', method: 'real-spend',
      reason: 'no verified api-spend row for this run',
      source: 'metrics/api-spend.jsonl',
    }));
    expect(meteredMiss!.priced).toBe(false);

    const unmatched = parseJobCostJournalEntry(unmatchedRow({}));
    expect(unmatched!.unmatchedSpend).toBe(true);
    expect(unmatched!.priced).toBe(true); // realSpendUsd is a recorded figure
  });

  it('rejects rows failing any arm of the writer contract', () => {
    const bad: unknown[] = [
      null, 'x', [],
      finishRow({ schema: 'ashlr.job-cost-model/v2' }),
      finishRow({ schema: undefined }),
      (() => { const r = finishRow({}); delete (r as Record<string, unknown>)['reason']; return r; })(),
      finishRow({ job: 'has space' }),
      finishRow({ job: '' }),
      finishRow({ lane: 'bad lane!' }),
      finishRow({ ts: 'not a date' }),
      finishRow({ ts: 1730000000 }),
      finishRow({ realSpendUsd: '1.5' }),
      finishRow({ modeledValueUsd: Number.NaN }),
      finishRow({ modeledValueUsd: Number.POSITIVE_INFINITY }),
      finishRow({ method: 'vibes' }),
      finishRow({ method: 3 }),
      finishRow({ inputs: [] }),
      finishRow({ inputs: 'x' }),
      finishRow({ source: 7 }),
      finishRow({ reason: {} }),
      finishRow({ confidence: 'certain' }),
      finishRow({ confidence: 1 }),
    ];
    for (const value of bad) expect(parseJobCostJournalEntry(value)).toBeNull();
    // Extra keys are tolerated for forward compatibility.
    expect(parseJobCostJournalEntry(finishRow({ extra: 'field' }))).not.toBeNull();
  });
});

describe('parseJobCostJournal', () => {
  it('counts malformed and off-contract lines, dedupes exact replays', () => {
    const a = J(finishRow({ job: 'RQ-A', ts: '2026-11-23T10:00:00Z' }));
    const b = J(finishRow({ job: 'RQ-B', ts: '2026-11-23T11:00:00Z' }));
    const text = [
      a, a,                    // exact replay of the same verdict
      b,
      'not json',
      J(finishRow({ schema: 'other/v9' })),
      '',
      '   ',
    ].join('\n');
    const parsed = parseJobCostJournal(text);
    expect(parsed.rows).toHaveLength(2);
    expect(parsed.replayedRows).toBe(1);
    expect(parsed.invalidRows).toBe(2);
  });
});

describe('foldJobCostRows + jobCostCells', () => {
  const NOW = Date.parse('2026-11-23T12:00:00.000Z');
  const DAY1 = '2026-11-21T10:00:00Z';
  const DAY2 = '2026-11-22T10:00:00Z';
  const OLD = '2026-11-01T10:00:00Z'; // outside the 7-day window

  /** n unpriced finishes for one lane spread over two UTC days. */
  const unpricedLane = (lane: string, n: number, priced: number): string[] => {
    const rows: string[] = [];
    for (let i = 0; i < n; i += 1) {
      rows.push(J(finishRow({
        job: `RQ-${lane}-${i}`, lane,
        ts: i % 2 === 0 ? DAY1 : DAY2,
      })));
    }
    for (let i = 0; i < priced; i += 1) {
      rows.push(J(finishRow({
        job: `RQ-${lane}-P${i}`, lane,
        ts: i % 2 === 0 ? DAY1 : DAY2,
        method: 'tokens-x-list-input-rate', modeledValueUsd: 0.01, confidence: 'low',
        reason: null, source: 'price table',
      })));
    }
    return rows;
  };

  it('emits a cost-gap cell per lane at the row/day/share bars', () => {
    // claude: 8 unpriced across 2 days, all finishes unpriced → share 1.0
    const text = unpricedLane('claude', JOB_COST_MIN_UNPRICED, 0).join('\n');
    const fold = foldJobCostRows(text, { nowMs: NOW });
    expect(fold.finishes).toBe(JOB_COST_MIN_UNPRICED);
    const cells = jobCostCells(fold);
    expect(cells).toHaveLength(1);
    const cell = cells[0]!;
    expect(cell.kind).toBe('cost-gap');
    if (cell.kind !== 'cost-gap') return;
    expect(cell.lane).toBe('claude');
    expect(cell.unpriced).toBe(JOB_COST_MIN_UNPRICED);
    expect(cell.share).toBe(1);
    expect(cell.days).toEqual([DAY1.slice(0, 10), DAY2.slice(0, 10)]);
    expect(cell.reasons[0]!.reason).toContain('claude subscription lane');
    expect(cell.firstSeen).toBe(`${DAY1.slice(0, 10)}T10:00:00.000Z`);

    // Below the row bar: nothing.
    const few = foldJobCostRows(unpricedLane('claude', JOB_COST_MIN_UNPRICED - 1, 0).join('\n'), { nowMs: NOW });
    expect(jobCostCells(few)).toEqual([]);

    // One UTC day only: the recurrence bar fails even with enough rows.
    const oneDay = Array.from({ length: JOB_COST_MIN_UNPRICED }, (_, i) =>
      J(finishRow({ job: `RQ-1D-${i}`, lane: 'claude', ts: DAY1 }))).join('\n');
    expect(jobCostCells(foldJobCostRows(oneDay, { nowMs: NOW }))).toEqual([]);

    // Priced finishes dilute the share below 25%: 8 unpriced + 30 priced = 21%.
    const diluted = foldJobCostRows(unpricedLane('claude', JOB_COST_MIN_UNPRICED, 30).join('\n'), { nowMs: NOW });
    expect(jobCostCells(diluted)).toEqual([]);
    // At exactly the share bar it still emits.
    const atBar = foldJobCostRows(unpricedLane('claude', JOB_COST_MIN_UNPRICED, 24).join('\n'), { nowMs: NOW });
    // 8/32 = 0.25 exactly → emits.
    expect(jobCostCells(atBar).map((c) => c.kind)).toEqual(['cost-gap']);

    // Priced days do not count toward the unpriced day bar: priced rows on
    // other days cannot launder a single-day unpriced streak into recurrence.
    const laundered = [
      ...Array.from({ length: JOB_COST_MIN_UNPRICED }, (_, i) =>
        J(finishRow({ job: `RQ-LD-${i}`, lane: 'claude', ts: DAY1 }))),
      ...Array.from({ length: 8 }, (_, i) =>
        J(finishRow({
          job: `RQ-LP-${i}`, lane: 'claude', ts: DAY2,
          method: 'tokens-x-list-input-rate', modeledValueUsd: 0.01, confidence: 'low',
          reason: null, source: 'price table',
        }))),
    ].join('\n');
    expect(jobCostCells(foldJobCostRows(laundered, { nowMs: NOW }))).toEqual([]);
  });

  it('splits unmatched spend from lane finishes and windows on ts', () => {
    const text = [
      // 3 unmatched rows across 2 days → unmatched cell.
      J(unmatchedRow({ job: 'RQ-U1', ts: DAY1 })),
      J(unmatchedRow({ job: 'RQ-U2', ts: DAY2 })),
      J(unmatchedRow({ job: 'RQ-U3', ts: DAY2, realSpendUsd: 2.25 })),
      // A finish row for the same lane name does not join the unmatched tally.
      J(finishRow({ job: 'RQ-F1', lane: 'claude-api', method: 'real-spend',
        realSpendUsd: 0.5, source: 'api-spend', confidence: 'high', reason: null })),
      // Out-of-window rows are context, never cells.
      J(unmatchedRow({ job: 'RQ-U-OLD', ts: OLD })),
      J(finishRow({ job: 'RQ-F-OLD', lane: 'claude', ts: OLD })),
      // Future-skew tolerance: 30s ahead of now still counts.
      J(unmatchedRow({ job: 'RQ-U-FUTURE', ts: new Date(NOW + 30_000).toISOString() })),
    ].join('\n');
    const fold = foldJobCostRows(text, { nowMs: NOW });
    expect(fold.finishes).toBe(1);
    expect(fold.pricedFinishes).toBe(1);
    expect(fold.outsideWindow).toBe(2);
    expect(fold.unmatched!.rows).toBe(4); // 3 + the future-skew row
    expect(fold.unmatched!.usd).toBeCloseTo(6.75, 6); // 1.5 + 1.5 + 2.25 + 1.5
    const cells = jobCostCells(fold);
    const unmatched = cells.find((c) => c.kind === 'unmatched-spend');
    expect(unmatched).toBeDefined();
    if (unmatched!.kind !== 'unmatched-spend') return;
    expect(unmatched!.rows).toBe(4);
    expect(unmatched!.lanes).toEqual(['claude-api']);
    // Below the row bar the cell stays silent.
    const few = foldJobCostRows(
      [J(unmatchedRow({ ts: DAY1 })), J(unmatchedRow({ ts: DAY2 }))].join('\n'),
      { nowMs: NOW });
    expect(jobCostCells(few).filter((c) => c.kind === 'unmatched-spend')).toEqual([]);
  });

  it('emits corrupt-lines at the contract-failure bar and counts replays as context', () => {
    const corrupt = [
      'not json at all',
      J({ schema: 'wrong/v1' }),
      J(finishRow({ lane: 'bad lane!' })),
    ];
    const text = corrupt.join('\n');
    const fold = foldJobCostRows(text, { nowMs: NOW });
    expect(fold.invalidRows).toBe(3);
    expect(fold.finishes).toBe(0);
    const cells = jobCostCells(fold);
    expect(cells).toHaveLength(1);
    expect(cells[0]).toMatchObject({ kind: 'corrupt-lines', invalidRows: 3 });
    // Below the bar: silent.
    const two = foldJobCostRows(corrupt.slice(0, JOB_COST_MIN_CORRUPT - 1).join('\n'), { nowMs: NOW });
    expect(jobCostCells(two)).toEqual([]);
    // Replays of a valid row do not inflate invalidRows.
    const replay = J(finishRow({ job: 'RQ-R' }));
    const withReplay = foldJobCostRows([replay, replay, ...corrupt].join('\n'), { nowMs: NOW });
    expect(withReplay.replayedRows).toBe(1);
    expect(withReplay.invalidRows).toBe(3);
  });
});

describe('jobCostBacklogItems', () => {
  let home: string;
  let saved: { HOME?: string; ASHLR_HOME?: string; ASHLR_RUNS_DIR?: string };
  const NOW = Date.now();
  const DAY1 = new Date(NOW - 2 * DAY).toISOString();
  const DAY2 = new Date(NOW - DAY).toISOString();

  beforeEach(async () => {
    saved = { HOME: process.env.HOME, ASHLR_HOME: process.env.ASHLR_HOME, ASHLR_RUNS_DIR: process.env.ASHLR_RUNS_DIR };
    delete process.env.ASHLR_HOME;
    delete process.env.ASHLR_RUNS_DIR;
    home = await mkdtemp(join(tmpdir(), 'job-cost-backlog-'));
    process.env.HOME = home;
  });
  afterEach(async () => {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    vi.restoreAllMocks();
    await rm(home, { recursive: true, force: true });
  });

  /** A runs dir with metrics/job-cost-model.jsonl written when rows are provided. */
  async function runsDir(name: string, rows?: string[]): Promise<string> {
    const dir = join(home, name);
    await mkdir(join(dir, 'metrics'), { recursive: true });
    if (rows !== undefined) {
      await writeFile(join(dir, 'metrics', 'job-cost-model.jsonl'), rows.join('\n') + '\n');
    }
    return dir;
  }

  const unpriced = (lane: string, job: string, ts: string): string =>
    J(finishRow({ job, lane, ts }));
  const gapRows = (lane: string): string[] =>
    Array.from({ length: JOB_COST_MIN_UNPRICED }, (_, i) =>
      unpriced(lane, `RQ-${lane}-${i}`, i % 2 === 0 ? DAY1 : DAY2));

  it('emits per-lane cost-gap items that pass the backlog contract', async () => {
    const dir = await runsDir('runs-gap', [...gapRows('claude'), ...gapRows('devin')]);
    const items = await jobCostBacklogItems({ repo: 'ashlrai/phantom', runsDir: dir, now: NOW });
    expect(items).toHaveLength(2);
    for (const item of items) {
      expect(item).toMatchObject({ priority: 3, repo: 'ashlrai/phantom', area: 'job-cost-model' });
      expect(validBacklogItem(item)).not.toBeNull();
      expect(item.id).toContain('job-cost-gap-');
      expect(item.prompt).toContain('job-cost-model.jsonl');
      expect(item.prompt).toContain('no-change');
      expect(item.prompt).toContain('unpriced');
    }
    const claude = items.find((i) => i.id.includes('claude'))!;
    expect(claude.title).toContain('claude');
    expect(claude.prompt).toContain('claude subscription lane');
    // Stable ids: a refresh re-derives the same identities.
    const again = await jobCostBacklogItems({ repo: 'ashlrai/phantom', runsDir: dir, now: NOW });
    expect(again.map((i) => i.id)).toEqual(items.map((i) => i.id));
  });

  it('emits the unmatched-spend and corrupt-lines items at their bars', async () => {
    const unmatched = [
      J(unmatchedRow({ job: 'RQ-U1', ts: DAY1 })),
      J(unmatchedRow({ job: 'RQ-U2', ts: DAY2 })),
      J(unmatchedRow({ job: 'RQ-U3', ts: DAY2, realSpendUsd: 4.5 })),
    ];
    const dir = await runsDir('runs-unmatched', unmatched);
    const items = await jobCostBacklogItems({ repo: 'ashlrai/phantom', runsDir: dir, now: NOW });
    expect(items).toHaveLength(1);
    expect(items[0]!.id).toContain('job-cost-unmatched-spend');
    expect(items[0]!.prompt).toContain('real-spend-unmatched');
    expect(items[0]!.prompt).toContain('$7.50'); // 1.5 + 1.5 + 4.5 recorded spend

    const corruptDir = await runsDir('runs-corrupt', [
      'torn line',
      J({ schema: 'nope/v0' }),
      J(finishRow({ lane: 'bad lane!' })),
    ]);
    const corruptItems = await jobCostBacklogItems({ repo: 'ashlrai/phantom', runsDir: corruptDir, now: NOW });
    expect(corruptItems).toHaveLength(1);
    expect(corruptItems[0]!.id).toContain('job-cost-corrupt');
    expect(corruptItems[0]!.prompt).toContain('contract');
  });

  it('emits nothing for absent journals, foreign repos, sub-bar evidence or priced lanes', async () => {
    expect(await jobCostBacklogItems({ repo: 'ashlrai/phantom', runsDir: join(home, 'nope'), now: NOW })).toEqual([]);
    const bare = await runsDir('runs-bare'); // metrics dir, no journal
    expect(await jobCostBacklogItems({ repo: 'ashlrai/phantom', runsDir: bare, now: NOW })).toEqual([]);
    // Empty journal file.
    const empty = await runsDir('runs-empty', []);
    expect(await jobCostBacklogItems({ repo: 'ashlrai/phantom', runsDir: empty, now: NOW })).toEqual([]);
    // Foreign repository never inherits this install's fleet evidence.
    const gap = await runsDir('runs-repo', gapRows('claude'));
    expect(await jobCostBacklogItems({ repo: 'ashlrai/other', runsDir: gap, now: NOW })).toEqual([]);
    expect(await jobCostBacklogItems({ repo: 'AshlrAI/Phantom', runsDir: gap, now: NOW })).toHaveLength(1); // case-insensitive fleet name
    // Sub-bar: 4 unpriced finishes never reach the row bar.
    const few = await runsDir('runs-few', gapRows('claude').slice(0, 4));
    expect(await jobCostBacklogItems({ repo: 'ashlrai/phantom', runsDir: few, now: NOW })).toEqual([]);
    // All-priced lane: finishes carry modeled values, nothing is unpriced.
    const priced = await runsDir('runs-priced', Array.from({ length: 10 }, (_, i) =>
      J(finishRow({
        job: `RQ-P${i}`, lane: 'codex-personal', ts: i % 2 === 0 ? DAY1 : DAY2,
        method: 'tokens-x-list-input-rate', modeledValueUsd: 0.02, confidence: 'low',
        reason: null, source: 'price table',
      }))));
    expect(await jobCostBacklogItems({ repo: 'ashlrai/phantom', runsDir: priced, now: NOW })).toEqual([]);
    // Honours the item limit across multiple cells.
    const two = await runsDir('runs-two', [...gapRows('claude'), ...gapRows('devin')]);
    expect(await jobCostBacklogItems({ repo: 'ashlrai/phantom', runsDir: two, now: NOW })).toHaveLength(2);
    const many = await jobCostBacklogItems({ repo: 'ashlrai/phantom', runsDir: two, now: NOW, limit: 1 });
    expect(many).toHaveLength(1);
  });
});

describe('discoverBacklog integration', () => {
  let home: string;
  let saved: { HOME?: string; ASHLR_HOME?: string; ASHLR_RUNS_DIR?: string };
  const NOW = Date.now();
  const DAY1 = new Date(NOW - 2 * DAY).toISOString();
  const DAY2 = new Date(NOW - DAY).toISOString();

  beforeEach(async () => {
    saved = { HOME: process.env.HOME, ASHLR_HOME: process.env.ASHLR_HOME, ASHLR_RUNS_DIR: process.env.ASHLR_RUNS_DIR };
    delete process.env.ASHLR_HOME;
    delete process.env.ASHLR_RUNS_DIR;
    home = await mkdtemp(join(tmpdir(), 'job-cost-discover-'));
    process.env.HOME = home;
  });
  afterEach(async () => {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    vi.restoreAllMocks();
    await rm(home, { recursive: true, force: true });
  });

  it('appends job-cost items through discovery and dedupes on refresh', async () => {
    const runs = join(home, '.ashlr-runs');
    await mkdir(join(runs, 'metrics'), { recursive: true });
    const rows = Array.from({ length: JOB_COST_MIN_UNPRICED }, (_, i) =>
      J(finishRow({ job: `RQ-D${i}`, lane: 'claude', ts: i % 2 === 0 ? DAY1 : DAY2 })));
    await writeFile(join(runs, 'metrics', 'job-cost-model.jsonl'), rows.join('\n') + '\n');
    const greenGh = async (args: string[]) => {
      const p = args[4] ?? '';
      if (p === 'repos/ashlrai/phantom') return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n{"default_branch":"master"}', stderr: '' };
      return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n[]', stderr: '' };
    };
    const first = await discoverBacklog('ashlrai/phantom', { gh: greenGh });
    const jobCostItems = first.items.filter((i) => i.id.includes('job-cost-'));
    expect(jobCostItems.length).toBeGreaterThan(0);
    expect(first.items.every((i) => validBacklogItem(i) !== null)).toBe(true);
    expect(appendUserBacklogItems(jobCostItems)).toBe(jobCostItems.length);
    const second = await discoverBacklog('ashlrai/phantom', { gh: greenGh });
    expect(appendUserBacklogItems(second.items.filter((i) => i.id.includes('job-cost-')))).toBe(0);
    expect(readUserBacklogItems().filter((i) => i.id.includes('job-cost-'))).toHaveLength(jobCostItems.length);
  });
});
