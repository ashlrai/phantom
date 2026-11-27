import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  foldShareJournal,
  REPO_SHARE_ADVERSE_CODES,
  REPO_SHARE_BACKLOG_MAX_ITEMS,
  REPO_SHARE_MIN_DAYS,
  REPO_SHARE_MIN_ROWS,
  REPO_SHARE_WINDOW_HOURS,
  repoShareBacklogItems,
  shareCells,
} from '../src/core/improve/repo-share-backlog.js';
import { discoverBacklog } from '../src/core/improve/discover.js';
import { appendUserBacklogItems, readUserBacklogItems, validBacklogItem } from '../src/core/cloud/backlog.js';

const DAY = 86_400_000;
const HOUR = 3_600_000;
const J = (o: Record<string, unknown>): string => JSON.stringify(o);

/** Fixed evaluation instant; fixture timestamps are epoch seconds like dispatchd's market_metric writes. */
const NOW_MS = Date.parse('2026-11-23T12:00:00.000Z');
const NOW_S = Math.floor(NOW_MS / 1000);
/** Epoch seconds `msAgo` milliseconds before NOW_MS. */
const sec = (msAgo: number): number => Math.floor((NOW_MS - msAgo) / 1000);

/** One work-market.v1 repo_share row in the producer's shape; spec keys override fields. */
function shareRow(tsSec: number, spec: Record<string, unknown> = {}): string {
  return J({
    schema: 'work-market.v1',
    event: 'repo_share',
    repo: 'ashlrai/locus',
    priority: 'normal',
    score: 1.35,
    share: 0.2,
    reason_codes: ['flat_baseline', 'ready_work', 'docs_freshness_drift'],
    ts: tsSec,
    ...spec,
  });
}

/** n share rows for `repo` carrying `codes`, spread across `days` distinct UTC days ending today. */
function shareSeries(repo: string, codes: string[], days: number, perDay: number, spec: Record<string, unknown> = {}): string[] {
  const rows: string[] = [];
  for (let d = 0; d < days; d++) {
    for (let i = 0; i < perDay; i++) {
      rows.push(shareRow(sec(d * DAY + i * HOUR), { repo, reason_codes: ['flat_baseline', 'ready_work', ...codes], ...spec }));
    }
  }
  return rows;
}

describe('foldShareJournal', () => {
  it('keeps only in-window work-market.v1 repo_share rows of the producer contract', () => {
    const rows = [
      shareRow(NOW_S),
      shareRow(NOW_S - HOUR / 1000, { reason_codes: ['flat_baseline', 'ready_work'] }),
      // Wrong schema, wrong event name, bad ts, non-JSON.
      J({ schema: 'other.v9', event: 'repo_share', repo: 'ashlrai/locus', priority: 'normal', score: 1, share: 0.5, reason_codes: [], ts: NOW_S }),
      J({ schema: 'work-market.v1', event: 'route_decision', repo: 'ashlrai/locus', priority: 'normal', score: 1, share: 0.5, reason_codes: [], ts: NOW_S }),
      J({ schema: 'work-market.v1', event: 'repo_share', repo: 'ashlrai/locus', priority: 'normal', score: 1, share: 0.5, reason_codes: [], ts: 'soon' }),
      J({ schema: 'work-market.v1', event: 'repo_share', repo: 'ashlrai/locus', priority: 'normal', score: 1, share: 0.5, reason_codes: [], ts: -5 }),
      'not json {"event":"repo_share"',
      '',
      // Out-of-window and beyond the +300 s skew: skipped as non-evidence, not invalid.
      shareRow(NOW_S - REPO_SHARE_WINDOW_HOURS * 3600 - 10),
      shareRow(NOW_S + 600),
      // Other events never reach the parse: no '"event":"repo_share"' substring.
      J({ schema: 'work-market.v1', event: 'posture', lanes: {}, ts: NOW_S }),
      J({ schema: 'work-market.v1', event: 'unfed_capacity', lanes: {}, ts: NOW_S }),
      J({ schema: 'work-market.v1', event: 'route_decision', job: 'j1', chosen_lane: 'claude', ts: NOW_S }),
    ].join('\n');
    const fold = foldShareJournal(rows, NOW_MS, REPO_SHARE_WINDOW_HOURS);
    // Two contract-valid in-window rows; the non-adverse one still counts as a record.
    expect(fold.records).toBe(2);
    // bad-schema row, string-ts, negative-ts and the non-JSON line all count
    // as invalid; the route_decision row and the other-event rows are skipped
    // before parsing (no '"event":"repo_share"' substring).
    expect(fold.invalidRows).toBe(4);
    expect(fold.cells.get('ashlrai/locusdocs_freshness_drift')?.rows).toBe(1);
  });

  it('rejects rows outside the producer contract field by field', () => {
    const bad = [
      shareRow(NOW_S, { repo: 'Locus' }),                       // repo_key lowercases — uppercase is not the writer's shape
      shareRow(NOW_S, { repo: 'not-a-repo' }),                  // no owner/name
      shareRow(NOW_S, { repo: 'ashlrai/locus', priority: 'high' }),
      shareRow(NOW_S, { score: 'high' }),
      shareRow(NOW_S, { score: -1 }),
      shareRow(NOW_S, { share: 1.5 }),
      shareRow(NOW_S, { share: -0.1 }),
      shareRow(NOW_S, { reason_codes: 'docs_freshness_drift' }),
      shareRow(NOW_S, { reason_codes: null }),
    ];
    const fold = foldShareJournal(bad.join('\n'), NOW_MS, REPO_SHARE_WINDOW_HOURS);
    expect(fold.records).toBe(0);
    expect(fold.invalidRows).toBe(bad.length);
    expect(fold.cells.size).toBe(0);
  });

  it('creates one cell per (repo, adverse code) and ignores designed and owner-state codes', () => {
    const rows = [
      // One row carrying two adverse codes plus designed and owner codes.
      shareRow(NOW_S, {
        repo: 'ashlrai/phantom',
        reason_codes: [
          'flat_baseline', 'ready_work', 'default_branch_ci_fix_ready',
          'historical_solution_yield', 'docs_freshness_drift',
          'site_freshness_unhealthy', 'owner_boost', 'owner_pause',
          'Bug_Fix_Ready', // not the writer's lowercase vocabulary — never matches
        ],
      }),
      // A second repo with only a designed mix — no cells.
      shareRow(NOW_S - HOUR / 1000, {
        repo: 'ashlrai/lexicon',
        reason_codes: ['flat_baseline', 'ready_work', 'research_work_ready', 'declared_mission_impact'],
      }),
      // site_freshness_stale on the first repo.
      shareRow(NOW_S - 2 * HOUR / 1000, { reason_codes: ['flat_baseline', 'site_freshness_stale'] }),
    ].join('\n');
    const fold = foldShareJournal(rows, NOW_MS, REPO_SHARE_WINDOW_HOURS);
    expect(fold.records).toBe(3);
    expect(fold.cells.size).toBe(3);
    expect(fold.cells.get('ashlrai/phantomdocs_freshness_drift')?.rows).toBe(1);
    expect(fold.cells.get('ashlrai/phantomsite_freshness_unhealthy')?.rows).toBe(1);
    expect(fold.cells.get('ashlrai/locussite_freshness_stale')?.rows).toBe(1);
    // The newest row's allocation context is what the cell quotes.
    const drift = fold.cells.get('ashlrai/phantomdocs_freshness_drift')!;
    expect(drift.lastShare).toBe(0.2);
    expect(drift.lastScore).toBe(1.35);
    expect(drift.lastPriority).toBe('normal');
  });

  it('tracks days, first/last seen and the latest allocation context', () => {
    const rows = [
      shareRow(sec(3 * DAY), { share: 0.1, score: 1.2, priority: 'boost' }),
      shareRow(sec(2 * DAY), { share: 0.3, score: 2.1 }),
      shareRow(sec(DAY), { share: 0.4, score: 2.4, priority: 'pause' }),
    ].join('\n');
    const fold = foldShareJournal(rows, NOW_MS, REPO_SHARE_WINDOW_HOURS);
    const cell = fold.cells.get('ashlrai/locusdocs_freshness_drift')!;
    expect(cell.rows).toBe(3);
    expect(cell.days.size).toBe(3);
    expect(cell.firstMs).toBe(sec(3 * DAY) * 1000);
    expect(cell.lastMs).toBe(sec(DAY) * 1000);
    // Journal order is chronological — the newest row's context wins.
    expect(cell.lastShare).toBe(0.4);
    expect(cell.lastScore).toBe(2.4);
    expect(cell.lastPriority).toBe('pause');
  });
});

describe('shareCells', () => {
  it('emits only at the row and day bars', () => {
    // Below the row bar: one verdict carried on too few share changes —
    // two recorded rows across two days never reach REPO_SHARE_MIN_ROWS.
    const few = foldShareJournal([
      shareRow(sec(2 * DAY)),
      shareRow(sec(DAY)),
    ].join('\n'), NOW_MS, REPO_SHARE_WINDOW_HOURS);
    expect(few.cells.get('ashlrai/locusdocs_freshness_drift')!.rows).toBeLessThan(REPO_SHARE_MIN_ROWS);
    expect(few.cells.get('ashlrai/locusdocs_freshness_drift')!.days.size).toBeGreaterThanOrEqual(REPO_SHARE_MIN_DAYS);
    expect(shareCells(few)).toEqual([]);

    // One day only — a burst of share changes, not a pattern.
    const oneDay = foldShareJournal(shareSeries('ashlrai/locus', ['docs_freshness_drift'], 1, REPO_SHARE_MIN_ROWS + 2).join('\n'), NOW_MS, REPO_SHARE_WINDOW_HOURS);
    expect(oneDay.cells.get('ashlrai/locusdocs_freshness_drift')!.days.size).toBe(1);
    expect(shareCells(oneDay)).toEqual([]);

    // Recurring: rows across 3 distinct UTC days.
    const recurring = foldShareJournal(shareSeries('ashlrai/locus', ['docs_freshness_drift'], 3, 2).join('\n'), NOW_MS, REPO_SHARE_WINDOW_HOURS);
    const cells = shareCells(recurring);
    expect(cells).toHaveLength(1);
    expect(cells[0]).toMatchObject({ repo: 'ashlrai/locus', code: 'docs_freshness_drift', rows: 6 });
    expect(cells[0]!.days).toHaveLength(3);
    expect(cells[0]!.lowerBound).toBe(false);
    expect(shareCells(recurring, true)[0]!.lowerBound).toBe(true);
  });
});

describe('repoShareBacklogItems', () => {
  let home: string;
  let saved: { HOME?: string; ASHLR_HOME?: string; ASHLR_RUNS_DIR?: string };

  beforeEach(async () => {
    saved = { HOME: process.env.HOME, ASHLR_HOME: process.env.ASHLR_HOME, ASHLR_RUNS_DIR: process.env.ASHLR_RUNS_DIR };
    delete process.env.ASHLR_HOME;
    delete process.env.ASHLR_RUNS_DIR;
    home = await mkdtemp(join(tmpdir(), 'repo-share-backlog-'));
    process.env.HOME = home;
  });
  afterEach(async () => {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    vi.restoreAllMocks();
    await rm(home, { recursive: true, force: true });
  });

  /** A runs dir whose metrics/work-market.jsonl carries the given rows. */
  async function runsDir(name: string, rows: string[]): Promise<string> {
    const dir = join(home, name);
    await mkdir(join(dir, 'metrics'), { recursive: true });
    await writeFile(join(dir, 'metrics', 'work-market.jsonl'), rows.length ? rows.join('\n') + '\n' : '');
    return dir;
  }

  it('emits self-targeted items for recurring adverse freshness verdicts', async () => {
    const rows = [
      ...shareSeries('ashlrai/locus', ['docs_freshness_drift'], 3, 2),
      ...shareSeries('ashlrai/phantom', ['site_freshness_unhealthy'], 3, 2, { score: 2.5, share: 0.4 }),
      ...shareSeries('ashlrai/ashlr-md', ['site_freshness_stale'], 2, 2),
    ];
    const dir = await runsDir('runs-cells', rows);
    const items = await repoShareBacklogItems({ runsDir: dir, now: new Date(NOW_MS) });
    expect(items).toHaveLength(3);
    for (const item of items) {
      expect(validBacklogItem(item)).not.toBeNull();
      expect(item).toMatchObject({ priority: 3 });
      expect(item.id).toMatch(/^repo-share-[0-9a-f]{16}$/);
      expect(item.prompt).toContain('work-market.jsonl');
      expect(item.prompt).toContain('repo_share');
      expect(item.prompt).toContain('no-change');
      expect(item.prompt).not.toContain('lower bound');
    }
    // Items self-target the repository the verdict belongs to.
    const locus = items.find((i) => i.repo === 'ashlrai/locus')!;
    expect(locus.title).toContain('ashlrai/locus');
    expect(locus.title).toContain('docs freshness drift');
    expect(locus.prompt).toContain('docs_freshness_drift');
    expect(locus.prompt).toContain('RQ-DOCS-FRESHNESS');
    expect(locus.prompt).toContain('queuegen');
    const phantom = items.find((i) => i.repo === 'ashlrai/phantom')!;
    expect(phantom.title).toContain('site freshness unhealthy');
    expect(phantom.prompt).toContain('RQ-SITE-FRESHNESS');
    const md = items.find((i) => i.repo === 'ashlrai/ashlr-md')!;
    expect(md.title).toContain('site freshness stale');
    expect(md.prompt).toContain('deployment');
  });

  it('emits nothing for missing evidence, non-adverse codes, or below-bar cells', async () => {
    expect(await repoShareBacklogItems({ runsDir: join(home, 'nope'), now: new Date(NOW_MS) })).toEqual([]);
    const empty = await runsDir('runs-empty', []);
    expect(await repoShareBacklogItems({ runsDir: empty, now: new Date(NOW_MS) })).toEqual([]);

    // A journal directory instead of a file.
    const notFile = join(home, 'runs-notfile');
    await mkdir(join(notFile, 'metrics', 'work-market.jsonl'), { recursive: true });
    expect(await repoShareBacklogItems({ runsDir: notFile, now: new Date(NOW_MS) })).toEqual([]);

    // Designed and owner-state codes alone never emit, even recurring.
    const healthy = await runsDir('runs-healthy', shareSeries('ashlrai/locus', [
      'default_branch_ci_fix_ready', 'historical_solution_yield', 'owner_boost',
    ], 4, 3));
    expect(await repoShareBacklogItems({ runsDir: healthy, now: new Date(NOW_MS) })).toEqual([]);

    // Below the day bar: one burst day of share changes.
    const thin = await runsDir('runs-thin', shareSeries('ashlrai/locus', ['docs_freshness_drift'], 1, REPO_SHARE_MIN_ROWS + 4));
    expect(await repoShareBacklogItems({ runsDir: thin, now: new Date(NOW_MS) })).toEqual([]);

    // Below the row bar across days: two recorded share rows never emit.
    const sparse = await runsDir('runs-sparse', [
      shareRow(sec(2 * DAY)),
      shareRow(sec(DAY)),
    ]);
    expect(await repoShareBacklogItems({ runsDir: sparse, now: new Date(NOW_MS) })).toEqual([]);
  });

  it('states truncation as a lower bound in every prompt', async () => {
    const rows = shareSeries('ashlrai/locus', ['docs_freshness_drift'], 3, 2);
    // Pad the journal past the 32 MiB tail bound so the read reports truncated.
    const pad = 'x'.repeat(33 * 1024 * 1024);
    const dir = await runsDir('runs-trunc', []);
    await writeFile(join(dir, 'metrics', 'work-market.jsonl'), pad + '\n' + rows.join('\n') + '\n');
    const items = await repoShareBacklogItems({ runsDir: dir, now: new Date(NOW_MS) });
    expect(items.length).toBeGreaterThan(0);
    expect(items.every((i) => i.prompt.includes('lower bound'))).toBe(true);
  });

  it('derives stable ids so a refresh re-adds nothing and honours the limit', async () => {
    const rows = [
      ...shareSeries('ashlrai/locus', ['docs_freshness_drift'], 3, 2),
      ...shareSeries('ashlrai/phantom', ['site_freshness_unhealthy'], 3, 2),
      ...shareSeries('ashlrai/ashlr-md', ['site_freshness_stale'], 3, 2),
      ...shareSeries('ashlrai/lexicon', ['docs_freshness_drift', 'site_freshness_stale'], 3, 2),
    ];
    const dir = await runsDir('runs-stable', rows);
    const opts = { runsDir: dir, now: new Date(NOW_MS) };
    const first = await repoShareBacklogItems(opts);
    const second = await repoShareBacklogItems(opts);
    expect(second.map((i) => i.id)).toEqual(first.map((i) => i.id));
    expect(first.length).toBe(5);
    expect(first.length).toBeLessThanOrEqual(REPO_SHARE_BACKLOG_MAX_ITEMS);
    const limited = await repoShareBacklogItems({ ...opts, limit: 1 });
    expect(limited).toHaveLength(1);
    expect(first.map((i) => i.id)).toContain(limited[0]!.id);
  });

  it('appends repo-share items through discovery and dedupes on refresh', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW_MS);
    try {
      const runs = join(home, '.ashlr-runs');
      await mkdir(join(runs, 'metrics'), { recursive: true });
      await writeFile(join(runs, 'metrics', 'work-market.jsonl'),
        shareSeries('ashlrai/locus', ['docs_freshness_drift'], 3, 2).join('\n') + '\n');
      const greenGh = async (args: string[]) => {
        const p = args[4] ?? '';
        if (p === 'repos/ashlrai/phantom') return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n{"default_branch":"master"}', stderr: '' };
        return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n[]', stderr: '' };
      };
      const first = await discoverBacklog('ashlrai/phantom', { gh: greenGh });
      const shareItems = first.items.filter((i) => i.id.startsWith('repo-share-'));
      expect(shareItems).toHaveLength(1);
      expect(shareItems[0]!.repo).toBe('ashlrai/locus');
      expect(shareItems[0]!.area).toBe('repo-freshness');
      expect(first.items.every((i) => validBacklogItem(i) !== null)).toBe(true);
      expect(appendUserBacklogItems(shareItems)).toBe(1);
      const second = await discoverBacklog('ashlrai/phantom', { gh: greenGh });
      expect(appendUserBacklogItems(second.items.filter((i) => i.id.startsWith('repo-share-')))).toBe(0);
      expect(readUserBacklogItems().filter((i) => i.id.startsWith('repo-share-'))).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('closed vocabularies', () => {
  it('keeps the emitted codes inside the writer\'s vocabulary', () => {
    expect(REPO_SHARE_ADVERSE_CODES).toEqual([
      'docs_freshness_drift',
      'site_freshness_unhealthy',
      'site_freshness_stale',
    ]);
    for (const code of REPO_SHARE_ADVERSE_CODES) {
      expect(code).toMatch(/^[a-z][a-z0-9_]{0,63}$/);
    }
  });
});
