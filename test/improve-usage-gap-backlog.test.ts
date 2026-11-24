import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  foldUsageGapJournal,
  USAGE_GAP_MIN_DAYS,
  USAGE_GAP_MIN_JOBS,
  USAGE_GAP_WINDOW_HOURS,
  usageGapBacklogItems,
  usageGapCells,
} from '../src/core/improve/usage-gap-backlog.js';
import { discoverBacklog } from '../src/core/improve/discover.js';
import { appendUserBacklogItems, readUserBacklogItems, validBacklogItem } from '../src/core/cloud/backlog.js';
import { jobTimelines } from '../src/core/metrics/loop.js';

const DAY = 86_400_000;
const HOUR = 3_600_000;
const J = (o: Record<string, unknown>): string => JSON.stringify(o);

/** Fixed evaluation instant; fixture timestamps are ISO-8601 UTC like dispatchd's metric() writes. */
const NOW_MS = Date.parse('2026-11-23T12:00:00.000Z');
const iso = (ms: number): string => new Date(ms).toISOString();

/** One dispatchd finish row in the writer's shape; the usage block is always present unless `bare`. */
function finishRow(spec: {
  job: string;
  atMs?: number;
  ts?: string;
  lane?: string | null;
  missing?: string | null;
  source?: string | null;
  event?: string;
  bare?: boolean;
  extra?: Record<string, unknown>;
}): string {
  const row: Record<string, unknown> = {
    event: spec.event ?? 'finish',
    job: spec.job,
    ...(spec.lane === null ? {} : { lane: spec.lane ?? 'claude' }),
    ts: spec.ts ?? iso(spec.atMs ?? NOW_MS),
    wall_s: 95,
    exit_code: 0,
    ...spec.extra,
  };
  if (spec.bare !== true) {
    const missing = spec.missing === undefined ? null : spec.missing;
    row['tokens_total'] = missing === null ? 4321 : null;
    row['acus'] = null;
    row['usage_source'] = spec.source === undefined ? (missing === null ? 'claude-result-json' : null) : spec.source;
    row['usage_missing'] = missing;
  }
  return J(row);
}

/** One enqueue row — the producer that carries the repo label finish rows lack. */
function enqueueRow(job: string, repo: string, atMs: number, lane = 'claude'): string {
  return J({ event: 'enqueue', job, repo, lane, tier: 'work', ts: iso(atMs) });
}

/** n finish rows for distinct jobs spread across `days` distinct UTC days ending today. */
function gapSeries(
  label: string,
  days: number,
  perDay: number,
  opts: { lane?: string; repo?: string; prefix?: string; missing?: string } = {},
): string[] {
  const rows: string[] = [];
  let n = 0;
  for (let d = 0; d < days; d++) {
    for (let i = 0; i < perDay; i++) {
      const job = `${opts.prefix ?? 'RQ-G'}${n++}`;
      if (opts.repo !== undefined) rows.push(enqueueRow(job, opts.repo, NOW_MS - d * DAY - i * HOUR - HOUR));
      rows.push(finishRow({
        job, atMs: NOW_MS - d * DAY - i * HOUR, lane: opts.lane,
        missing: opts.missing ?? label,
      }));
    }
  }
  return rows;
}

/** The production fold: timelines joined from the same tail, as usageGapBacklogItems does. */
function foldRows(rows: string[], nowMs = NOW_MS) {
  const text = rows.join('\n');
  return foldUsageGapJournal(text, nowMs, USAGE_GAP_WINDOW_HOURS, jobTimelines(text, nowMs));
}

describe('foldUsageGapJournal', () => {
  it('collapses each job to its newest finish row and keeps only in-window standing finishes', () => {
    const rows = [
      // Recovered: an older gap finish superseded by a captured finish — counts as a finish, no gap.
      finishRow({ job: 'RQ-REC', atMs: NOW_MS - 2 * DAY, missing: 'tokens-line-not-in-log' }),
      finishRow({ job: 'RQ-REC', atMs: NOW_MS - HOUR, missing: null }),
      // Relapsed: captured first, then a gap — the standing finish carries the label.
      finishRow({ job: 'RQ-REL', atMs: NOW_MS - 2 * DAY, missing: null }),
      finishRow({ job: 'RQ-REL', atMs: NOW_MS - HOUR, missing: 'tokens-line-not-in-log', lane: 'devin' }),
      // Stale: the only finish predates the window — nothing counts.
      finishRow({ job: 'RQ-OLD', atMs: NOW_MS - USAGE_GAP_WINDOW_HOURS * 3_600_000 - DAY, missing: 'tokens-line-not-in-log' }),
      // Future-dated beyond skew — untrustworthy, contributes nothing.
      finishRow({ job: 'RQ-FUT', atMs: NOW_MS + 600_000, missing: 'tokens-line-not-in-log' }),
      // Undated standing finish — unknown stays unknown.
      finishRow({ job: 'RQ-NODATE', ts: 'not-a-date', missing: 'tokens-line-not-in-log' }),
      // Non-finish events never count even when they carry the label.
      finishRow({ job: 'RQ-LAUNCH', event: 'launch', atMs: NOW_MS - HOUR, missing: 'tokens-line-not-in-log' }),
      finishRow({ job: 'RQ-PUB', event: 'publish', atMs: NOW_MS - HOUR, missing: 'tokens-line-not-in-log' }),
      // A finish row without the usage block records no gap (unknown, not zero).
      finishRow({ job: 'RQ-BARE', atMs: NOW_MS - HOUR, bare: true }),
      // An invalid label shape is skipped like the router fold's own parse.
      finishRow({ job: 'RQ-BADC', atMs: NOW_MS - HOUR, missing: 'BAD LABEL!' }),
      finishRow({ job: 'RQ-BADP', atMs: NOW_MS - HOUR, missing: 'has spaces' }),
      // camelCase spelling joins, snake_case wins when both exist.
      finishRow({ job: 'RQ-CAMEL', atMs: NOW_MS - HOUR, missing: null, extra: { usageMissing: 'devin-usage-not-reported' } }),
      // Node-pool producer schemas are never dispatch attempts.
      J({ schema: 'fleet.session-pool.v1', event: 'finish', job: 'sess-1:2', ts: iso(NOW_MS - HOUR), usage_missing: 'tokens-line-not-in-log' }),
      J({ schema: 'phm-node-runner.v1', event: 'finish', job: 'job-1:tok', ts: iso(NOW_MS - HOUR), usage_missing: 'tokens-line-not-in-log' }),
      // Unsafe job ids never reach the fold.
      finishRow({ job: '../escape', atMs: NOW_MS - HOUR, missing: 'tokens-line-not-in-log' }),
      finishRow({ job: 'has space', atMs: NOW_MS - HOUR, missing: 'tokens-line-not-in-log' }),
      'not json finish',
      '{"finish":',
      '',
    ];
    const fold = foldRows(rows);
    // In-window standing finishes: REC(captured), REL(gap), BARE(no block), BADC(invalid), BADP(invalid), CAMEL(camel label) = 6.
    expect(fold.finishes).toBe(6);
    expect(fold.malformed).toBe(2);
    const gaps = fold.gaps;
    expect([...gaps.keys()].sort()).toEqual(['devin-usage-not-reported', 'tokens-line-not-in-log']);
    const tok = gaps.get('tokens-line-not-in-log')!;
    expect([...tok.jobs]).toEqual(['RQ-REL']);
    expect(tok.lanes.get('devin')).toBe(1);
    const camel = gaps.get('devin-usage-not-reported')!;
    expect([...camel.jobs]).toEqual(['RQ-CAMEL']);
    // The recovered job's older gap row never resurrects.
    expect(tok.jobs.has('RQ-REC')).toBe(false);
  });

  it('reads lane from the finish row and repo from the jobs timeline, degrading to unknown/unattributed', () => {
    const rows = [
      enqueueRow('RQ-A', 'ashlrai/phantom', NOW_MS - 2 * DAY),
      finishRow({ job: 'RQ-A', atMs: NOW_MS - DAY, lane: 'devin', missing: 'devin-usage-not-reported' }),
      finishRow({ job: 'RQ-B', atMs: NOW_MS - DAY, lane: 'claude', missing: 'devin-usage-not-reported' }),
      finishRow({ job: 'RQ-C', atMs: NOW_MS - 2 * DAY, lane: null, missing: 'devin-usage-not-reported' }),
    ];
    const fold = foldRows(rows);
    const cell = fold.gaps.get('devin-usage-not-reported')!;
    expect(cell.jobs.size).toBe(3);
    expect(cell.lanes.get('devin')).toBe(1);
    expect(cell.lanes.get('claude')).toBe(1);
    expect(cell.lanes.get('unknown')).toBe(1);
    expect(cell.repos.get('ashlrai/phantom')).toBe(1);
    expect(cell.repos.get('unattributed')).toBe(2);
  });
});

describe('usageGapCells', () => {
  it('emits a label cell only at the job and day bars', () => {
    // Below the job bar: two distinct jobs across two days.
    const few = foldRows(gapSeries('tokens-line-not-in-log', 2, 1, { prefix: 'RQ-F' }));
    expect(few.gaps.get('tokens-line-not-in-log')!.jobs.size).toBe(2);
    expect(usageGapCells(few)).toEqual([]);

    // Below the day bar: enough jobs but all on one UTC day.
    const oneDay = foldRows(gapSeries('tokens-line-not-in-log', 1, USAGE_GAP_MIN_JOBS + 2, { prefix: 'RQ-O' }));
    expect(oneDay.gaps.get('tokens-line-not-in-log')!.days.size).toBe(1);
    expect(usageGapCells(oneDay)).toEqual([]);

    // At the bars: three jobs across two days.
    const recurring = foldRows(gapSeries('tokens-line-not-in-log', USAGE_GAP_MIN_DAYS, 2, { prefix: 'RQ-R', lane: 'claude' }));
    const cells = usageGapCells(recurring);
    expect(cells).toHaveLength(1);
    const cell = cells[0]!;
    expect(cell.jobs).toBe(4);
    expect(cell.days).toHaveLength(2);
    expect(cell.finishes).toBe(4);
    expect(cell.share).toBeCloseTo(1, 5);
    expect(cell.lanes).toEqual([{ text: 'claude', count: 4 }]);
    expect(cell.repos).toEqual([{ text: 'unattributed', count: 4 }]);
    expect(cell.examples).toHaveLength(3);
    expect(cell.firstSeen).not.toBeNull();
    expect(cell.lastSeen).not.toBeNull();
    expect(cell.lowerBound).toBe(false);
    expect(usageGapCells(recurring, true)[0]!.lowerBound).toBe(true);
  });

  it('sorts cells worst-first and never emits healthy or one-off labels', () => {
    const rows = [
      ...gapSeries('tokens-line-not-in-log', 2, 2, { prefix: 'RQ-T' }),       // 4 jobs, 2 days — emits
      ...gapSeries('devin-usage-not-reported', 3, 1, { prefix: 'RQ-D' }),    // 3 jobs, 3 days — emits
      ...gapSeries('claude-result-not-in-log', 1, 5, { prefix: 'RQ-C' }),    // one day — silent
      // Healthy finishes dilute the share denominator without joining a cell.
      ...[0, 1, 2, 3].map((i) => finishRow({ job: `RQ-H${i}`, atMs: NOW_MS - i * HOUR, missing: null })),
    ];
    const cells = usageGapCells(foldRows(rows));
    expect(cells.map((c) => c.label)).toEqual(['tokens-line-not-in-log', 'devin-usage-not-reported']);
    expect(cells[0]!.jobs).toBe(4);
    expect(cells[0]!.finishes).toBe(16);
    expect(cells[0]!.share).toBeCloseTo(4 / 16, 5);
    expect(cells[1]!.jobs).toBe(3);
  });
});

describe('usageGapBacklogItems', () => {
  let home: string;
  let saved: { HOME?: string; ASHLR_HOME?: string; ASHLR_RUNS_DIR?: string };
  const NOW = new Date(NOW_MS);

  beforeEach(async () => {
    saved = { HOME: process.env.HOME, ASHLR_HOME: process.env.ASHLR_HOME, ASHLR_RUNS_DIR: process.env.ASHLR_RUNS_DIR };
    delete process.env.ASHLR_HOME;
    delete process.env.ASHLR_RUNS_DIR;
    home = await mkdtemp(join(tmpdir(), 'usage-gap-backlog-'));
    process.env.HOME = home;
  });
  afterEach(async () => {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    vi.restoreAllMocks();
    await rm(home, { recursive: true, force: true });
  });

  /** A runs dir whose metrics/jobs.jsonl carries the given rows. */
  async function runsDir(name: string, rows: string[]): Promise<string> {
    const dir = join(home, name);
    await mkdir(join(dir, 'metrics'), { recursive: true });
    await writeFile(join(dir, 'metrics', 'jobs.jsonl'), rows.join('\n') + '\n');
    return dir;
  }

  it('emits a usage-gap item for a recurring capture label', async () => {
    const rows = [
      ...gapSeries('tokens-line-not-in-log', 3, 1, { prefix: 'RQ-A', lane: 'claude', repo: 'ashlrai/phantom' }),
      ...gapSeries('tokens-line-not-in-log', 2, 1, { prefix: 'RQ-B', lane: 'devin' }),
    ];
    const dir = await runsDir('runs-gap', rows);
    const items = await usageGapBacklogItems({ repo: 'ashlrai/phantom', runsDir: dir, now: NOW });
    expect(items).toHaveLength(1);
    const [item] = items;
    expect(item).toMatchObject({ priority: 3, repo: 'ashlrai/phantom', area: 'usage-gap' });
    expect(item!.id).toMatch(/^usage-gap-[0-9a-f]{16}$/);
    expect(item!.title).toContain('tokens-line-not-in-log');
    expect(validBacklogItem(item)).not.toBeNull();
    expect(item!.prompt).toContain('usage_missing');
    expect(item!.prompt).toContain('tokens-line-not-in-log');
    expect(item!.prompt).toContain('jobs.jsonl');
    expect(item!.prompt).toContain('phm fleet router-weights');
    expect(item!.prompt).toContain('phm router outcomes');
    expect(item!.prompt).toContain('claude');
    expect(item!.prompt).toContain('devin');
    expect(item!.prompt).toContain('ashlrai/phantom');
    expect(item!.prompt).toContain('no-change');
    expect(item!.prompt).not.toContain('lower bound');
  });

  it('emits nothing for missing evidence, another repository, or below-bar cells', async () => {
    expect(await usageGapBacklogItems({ repo: 'ashlrai/phantom', runsDir: join(home, 'nope'), now: NOW })).toEqual([]);

    const empty = await runsDir('runs-empty', []);
    expect(await usageGapBacklogItems({ repo: 'ashlrai/phantom', runsDir: empty, now: NOW })).toEqual([]);

    // A directory instead of a file.
    const notFile = join(home, 'runs-notfile');
    await mkdir(join(notFile, 'metrics', 'jobs.jsonl'), { recursive: true });
    expect(await usageGapBacklogItems({ repo: 'ashlrai/phantom', runsDir: notFile, now: NOW })).toEqual([]);

    // Below the day bar: one burst day of gaps.
    const thin = await runsDir('runs-thin', gapSeries('tokens-line-not-in-log', 1, USAGE_GAP_MIN_JOBS + 2, { prefix: 'RQ-T' }));
    expect(await usageGapBacklogItems({ repo: 'ashlrai/phantom', runsDir: thin, now: NOW })).toEqual([]);
    expect(await usageGapBacklogItems({ repo: 'ashlrai/lexicon', runsDir: thin, now: NOW })).toEqual([]);
    expect(await usageGapBacklogItems({ repo: '', runsDir: thin, now: NOW })).toEqual([]);

    // A healthy ledger: finishes with usage captured emit nothing.
    const healthy = await runsDir('runs-healthy', [
      ...[0, 1, 2, 3].map((i) => finishRow({ job: `RQ-H${i}`, atMs: NOW_MS - i * DAY, missing: null })),
      ...[4, 5].map((i) => finishRow({ job: `RQ-H${i}`, atMs: NOW_MS - i * HOUR, bare: true })),
    ]);
    expect(await usageGapBacklogItems({ repo: 'ashlrai/phantom', runsDir: healthy, now: NOW })).toEqual([]);
  });

  it('states truncation as a lower bound in every prompt', async () => {
    const rows = gapSeries('tokens-line-not-in-log', 3, 1, { prefix: 'RQ-TR' });
    // Pad the ledger past the 16 MiB tail bound so the read reports truncated.
    const pad = 'x'.repeat(17 * 1024 * 1024);
    const dir = await runsDir('runs-trunc', []);
    await writeFile(join(dir, 'metrics', 'jobs.jsonl'), pad + '\n' + rows.join('\n') + '\n');
    const items = await usageGapBacklogItems({ repo: 'ashlrai/phantom', runsDir: dir, now: NOW });
    expect(items.length).toBeGreaterThan(0);
    expect(items.every((i) => i.prompt.includes('lower bound'))).toBe(true);
  });

  it('derives stable ids so a refresh re-adds nothing and honours the limit', async () => {
    const rows = [
      ...gapSeries('tokens-line-not-in-log', 2, 2, { prefix: 'RQ-S1' }),
      ...gapSeries('devin-usage-not-reported', 3, 1, { prefix: 'RQ-S2' }),
    ];
    const dir = await runsDir('runs-stable', rows);
    const opts = { repo: 'ashlrai/phantom', runsDir: dir, now: NOW };
    const first = await usageGapBacklogItems(opts);
    const second = await usageGapBacklogItems(opts);
    expect(second.map((i) => i.id)).toEqual(first.map((i) => i.id));
    expect(first).toHaveLength(2);
    const limited = await usageGapBacklogItems({ ...opts, limit: 1 });
    expect(limited).toHaveLength(1);
    expect(first.map((i) => i.id)).toContain(limited[0]!.id);
  });

  it('appends usage-gap items through discovery and dedupes on refresh', async () => {
    const runs = join(home, '.ashlr-runs');
    await mkdir(join(runs, 'metrics'), { recursive: true });
    // discoverBacklog anchors the window on the real clock, so these rows
    // are stamped relative to Date.now() rather than the fixed NOW_MS.
    const realNow = Date.now();
    const at = (d: number, i = 0): number => realNow - d * DAY - i * HOUR;
    await writeFile(join(runs, 'metrics', 'jobs.jsonl'), [
      finishRow({ job: 'RQ-D0', atMs: at(0), missing: 'tokens-line-not-in-log' }),
      finishRow({ job: 'RQ-D1', atMs: at(1), missing: 'tokens-line-not-in-log' }),
      finishRow({ job: 'RQ-D2', atMs: at(2), missing: 'tokens-line-not-in-log' }),
      finishRow({ job: 'RQ-D3', atMs: at(0, 1), missing: 'tokens-line-not-in-log' }),
    ].join('\n') + '\n');
    const greenGh = async (args: string[]) => {
      const p = args[4] ?? '';
      if (p === 'repos/ashlrai/phantom') return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n{"default_branch":"master"}', stderr: '' };
      return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n[]', stderr: '' };
    };
    const first = await discoverBacklog('ashlrai/phantom', { gh: greenGh });
    const gapItems = first.items.filter((i) => i.id.startsWith('usage-gap-'));
    expect(gapItems).toHaveLength(1);
    expect(gapItems[0]!.area).toBe('usage-gap');
    expect(first.items.every((i) => validBacklogItem(i) !== null)).toBe(true);
    expect(appendUserBacklogItems(gapItems)).toBe(1);
    const second = await discoverBacklog('ashlrai/phantom', { gh: greenGh });
    expect(appendUserBacklogItems(second.items.filter((i) => i.id.startsWith('usage-gap-')))).toBe(0);
    expect(readUserBacklogItems().filter((i) => i.id.startsWith('usage-gap-'))).toHaveLength(1);
  });
});
