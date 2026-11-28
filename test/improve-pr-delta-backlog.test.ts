import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  PR_DELTA_BACKLOG_MAX_ITEMS,
  PR_DELTA_MIN_DAYS,
  PR_DELTA_MIN_UNMEASURED,
  PR_DELTA_TAIL_BYTES,
  foldPrDelta,
  prDeltaCells,
  prDeltaBacklogItems,
} from '../src/core/improve/pr-delta-backlog.js';
import { discoverBacklog } from '../src/core/improve/discover.js';
import { appendUserBacklogItems, readUserBacklogItems, validBacklogItem } from '../src/core/cloud/backlog.js';

const DAY_MS = 86_400_000;

/** Fixed reference instant; fixture days are complete UTC days like the writer's. */
const daysAgo = (n: number): string => new Date(Date.parse('2026-11-23T00:00:00.000Z') - n * DAY_MS).toISOString().slice(0, 10);

/** One persisted fleet.delta.v1 row in the writer's rankPrLeverage delta shape.
 * Spec fields are unknown so malformed-shape cases can pass wrong types through
 * verbatim — the fold, not the helper, is what rejects them. */
function deltaRow(spec: {
  day?: unknown;
  repos?: unknown;
  prsMerged?: unknown;
  verifiedLines?: unknown;
  unmeasuredPrs?: unknown;
  jobsCompleted?: unknown;
  schema?: unknown;
  extra?: Record<string, unknown>;
} = {}): string {
  const row: Record<string, unknown> = {
    schema: spec.schema === undefined ? 'fleet.delta.v1' : spec.schema,
    day: spec.day === undefined ? daysAgo(1) : spec.day,
    repos: spec.repos === undefined ? ['ashlrai/phantom'] : spec.repos,
    prsMerged: spec.prsMerged === undefined ? 5 : spec.prsMerged,
    verifiedLines: spec.verifiedLines === undefined ? 1200 : spec.verifiedLines,
    unmeasuredPrs: spec.unmeasuredPrs === undefined ? 2 : spec.unmeasuredPrs,
    jobsCompleted: spec.jobsCompleted === undefined ? 3 : spec.jobsCompleted,
    ...(spec.extra ?? {}),
  };
  return JSON.stringify(row);
}

/**
 * Unverified rows spread across `days` distinct UTC days — every row is a
 * recorded delta day, so there is no window to satisfy, only distinct days.
 */
function deltaSeries(opts: { days: number; perDay?: number; unmeasured?: number; prsMerged?: number } = { days: PR_DELTA_MIN_DAYS }): string[] {
  const rows: string[] = [];
  const perDay = opts.perDay ?? 1;
  for (let d = 0; d < opts.days; d++) {
    for (let i = 0; i < perDay; i++) {
      rows.push(deltaRow({
        day: daysAgo(d + 1),
        unmeasuredPrs: opts.unmeasured ?? 2,
        prsMerged: opts.prsMerged ?? 5,
        // Rows sharing a (day, repos) are revisions of one recorded delta:
        // the fold keeps the latest, so a second row on a day still counts once.
        verifiedLines: 1000 + i,
      }));
    }
  }
  return rows;
}

/** The production fold: one journal text (the single append-only file). */
function foldRows(rows: string[]) {
  return foldPrDelta([rows.join('\n')]);
}

describe('foldPrDelta', () => {
  it('counts unverified days and skips foreign shapes without guessing', () => {
    const rows = [
      deltaRow({ day: daysAgo(1), unmeasuredPrs: 2, prsMerged: 5 }),
      deltaRow({ day: daysAgo(2), unmeasuredPrs: 1, prsMerged: 4, jobsCompleted: null }),
      deltaRow({ day: daysAgo(9), unmeasuredPrs: 3, prsMerged: 6 }),
      // A clean day — merges all verified — is context, not adverse.
      deltaRow({ day: daysAgo(3), unmeasuredPrs: 0, prsMerged: 7, verifiedLines: 900 }),
      // Malformed JSON and non-object rows.
      'not json at all',
      '[1,2,3]',
      'null',
      // Foreign shapes — the writer's contract rejects them all.
      deltaRow({ schema: 'fleet.delta.v2' }),
      deltaRow({ day: 'not-a-day' }),
      deltaRow({ day: '2026-02-30' }),
      deltaRow({ repos: [] }),
      deltaRow({ repos: 'ashlrai/phantom' }),
      deltaRow({ prsMerged: -1 }),
      deltaRow({ verifiedLines: 1.5 }),
      deltaRow({ unmeasuredPrs: 'two' }),
      deltaRow({ jobsCompleted: 'many' }),
      deltaRow({ jobsCompleted: -2 }),
      '{"schema":"fleet.delta.v1","day":"2026',
      '',
    ];
    const fold = foldRows(rows);
    expect(fold.rows).toBe(4);
    expect(fold.unverifiedRows).toBe(3);
    expect(fold.unverifiedDays.size).toBe(3);
    expect(fold.unmeasuredTotal).toBe(6);
    expect(fold.mergedOnUnverifiedDays).toBe(15);
    expect(fold.verifiedOnUnverifiedDays).toBe(1200 + 1200 + 1200);
    expect(fold.allUnverifiedRows).toBe(0);
    expect(fold.jobsUnknownRows).toBe(1);
    expect(fold.firstDay).toBe(daysAgo(9));
    expect(fold.lastDay).toBe(daysAgo(1));
    expect(fold.repos.size).toBe(1);
    expect(fold.malformed).toBe(14);
  });

  it('collapses revisions to the latest (day, repos) row and tolerates extra fields', () => {
    const rows = [
      // Two revisions of the same (day, repos): the latest numbers win.
      deltaRow({ day: daysAgo(1), unmeasuredPrs: 2, prsMerged: 5, verifiedLines: 100 }),
      deltaRow({ day: daysAgo(1), unmeasuredPrs: 3, prsMerged: 6, verifiedLines: 200, extra: { note: 'revised' } }),
      deltaRow({ day: daysAgo(2), unmeasuredPrs: 1, prsMerged: 4, repos: ['ashlrai/lexicon', 'ashlrai/phantom'] }),
      deltaRow({ day: daysAgo(3), unmeasuredPrs: 1, prsMerged: 4 }),
    ];
    const fold = foldRows(rows);
    // Three distinct (day, repos) records survive: the first revision is superseded.
    expect(fold.rows).toBe(3);
    expect(fold.unverifiedRows).toBe(3);
    expect(fold.unverifiedDays.size).toBe(3);
    // unmeasuredPrs sums the surviving records' latest revisions only —
    // 3 (revised day 1) + 1 + 1 — never double-counting the superseded row.
    expect(fold.unmeasuredTotal).toBe(5);
    expect(fold.mergedOnUnverifiedDays).toBe(6 + 4 + 4);
    expect(fold.verifiedOnUnverifiedDays).toBe(200 + 1200 + 1200);
    expect(fold.repos.size).toBe(2);
  });

  it('marks rows where every recorded merge was unverified', () => {
    const rows = [
      deltaRow({ day: daysAgo(1), unmeasuredPrs: 5, prsMerged: 5, verifiedLines: 0 }),
      deltaRow({ day: daysAgo(2), unmeasuredPrs: 2, prsMerged: 5, verifiedLines: 800 }),
      deltaRow({ day: daysAgo(3), unmeasuredPrs: 1, prsMerged: 4 }),
    ];
    const fold = foldRows(rows);
    expect(fold.allUnverifiedRows).toBe(1);
  });
});

describe('prDeltaCells', () => {
  it('emits only at the day/unmeasured bars', () => {
    // Below bars: unverified merges but fewer than MIN_DAYS distinct days.
    const twoDays = [
      deltaRow({ day: daysAgo(1), unmeasuredPrs: 3, prsMerged: 5 }),
      deltaRow({ day: daysAgo(2), unmeasuredPrs: 3, prsMerged: 5 }),
    ];
    expect(prDeltaCells(foldRows(twoDays))).toEqual([]);

    // Below bars: enough days but the unmeasured total under MIN_UNMEASURED.
    const thinTotal = [
      deltaRow({ day: daysAgo(1), unmeasuredPrs: 1, prsMerged: 5 }),
      deltaRow({ day: daysAgo(2), unmeasuredPrs: 1, prsMerged: 5 }),
      deltaRow({ day: daysAgo(3), unmeasuredPrs: 1, prsMerged: 5 }),
    ];
    expect(foldRows(thinTotal).unverifiedDays.size).toBe(PR_DELTA_MIN_DAYS);
    expect(foldRows(thinTotal).unmeasuredTotal).toBeLessThan(PR_DELTA_MIN_UNMEASURED);
    expect(prDeltaCells(foldRows(thinTotal))).toEqual([]);

    // At the bars: days + unmeasured total → emits one cell carrying the evidence.
    const good = foldRows(deltaSeries({ days: PR_DELTA_MIN_DAYS, unmeasured: 2 }));
    const cells = prDeltaCells(good, { lowerBound: true });
    expect(cells).toHaveLength(1);
    const cell = cells[0]!;
    expect(cell).toMatchObject({
      kind: 'pr-delta-unmeasured',
      unmeasuredTotal: PR_DELTA_MIN_DAYS * 2,
      mergedTotal: PR_DELTA_MIN_DAYS * 5,
      repos: 1,
      lowerBound: true,
    });
    expect(cell.days.length).toBe(PR_DELTA_MIN_DAYS);
    expect(cell.days).toEqual([...cell.days].sort());
    expect(cell.firstSeen).toBe(daysAgo(PR_DELTA_MIN_DAYS));
    expect(cell.lastSeen).toBe(daysAgo(1));
    expect(prDeltaCells(good)[0]!.lowerBound).toBe(false);
  });
});

describe('prDeltaBacklogItems', () => {
  let home: string;
  let saved: { HOME?: string; ASHLR_HOME?: string; ASHLR_RUNS_DIR?: string };

  beforeEach(async () => {
    saved = { HOME: process.env.HOME, ASHLR_HOME: process.env.ASHLR_HOME, ASHLR_RUNS_DIR: process.env.ASHLR_RUNS_DIR };
    delete process.env.ASHLR_HOME;
    delete process.env.ASHLR_RUNS_DIR;
    home = await mkdtemp(join(tmpdir(), 'pr-delta-backlog-'));
    process.env.HOME = home;
  });
  afterEach(async () => {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    await rm(home, { recursive: true, force: true });
  });

  /** A journal file under the temp home's runs dir carrying the given rows. */
  async function journal(name: string, rows: string[], dir?: string): Promise<string> {
    const metrics = join(dir ?? home, 'metrics');
    await mkdir(metrics, { recursive: true });
    const path = join(metrics, `${name}.jsonl`);
    await writeFile(path, rows.join('\n') + '\n');
    return path;
  }

  it('emits one grounded item for a recurring unverified-merge journal', async () => {
    const runsDir = join(home, '.ashlr-runs');
    const rows = [
      ...deltaSeries({ days: 4, unmeasured: 2 }),
      deltaRow({ day: daysAgo(6), unmeasuredPrs: 0, prsMerged: 3, verifiedLines: 500, jobsCompleted: null }),
      deltaRow({ day: daysAgo(7), unmeasuredPrs: 1, prsMerged: 2, repos: ['ashlrai/lexicon'] }),
    ];
    const path = await journal('pr-delta', rows, runsDir);
    const items = await prDeltaBacklogItems({ repo: 'ashlrai/phantom', runsDir, journalPath: path });
    expect(items).toHaveLength(1);
    const item = items[0]!;
    expect(item.id).toMatch(/^pr-delta-[0-9a-f]{16}$/);
    expect(item).toMatchObject({ area: 'fleet-metrics', priority: 3, repo: 'ashlrai/phantom' });
    expect(validBacklogItem(item)).not.toBeNull();
    expect(item.title).toContain('unverified merges');
    expect(item.prompt).toContain('pr-delta.jsonl');
    expect(item.prompt).toContain('fleet.delta.v1');
    expect(item.prompt).toContain('unmeasuredPrs');
    expect(item.prompt).toContain('jobsCompleted');
    expect(item.prompt).toContain('no-change');
    expect(item.prompt).toContain('UTC day(s)');
    expect(item.prompt).not.toContain('lower bound');
  });

  it('emits nothing for missing, unreadable, foreign-repo or below-bar evidence', async () => {
    const runsDir = join(home, '.ashlr-runs');
    expect(await prDeltaBacklogItems({ repo: 'ashlrai/phantom', runsDir, journalPath: join(home, 'nope', 'pr-delta.jsonl') })).toEqual([]);

    // A directory instead of a file.
    const dirPath = join(home, 'metrics', 'pr-delta.jsonl');
    await mkdir(dirPath, { recursive: true });
    expect(await prDeltaBacklogItems({ repo: 'ashlrai/phantom', runsDir, journalPath: dirPath })).toEqual([]);

    // Another repository never inherits this install's delta journal.
    const recurring = deltaSeries({ days: 4, unmeasured: 2 });
    const recurringPath = await journal('pr-delta-recurring', recurring, runsDir);
    expect(await prDeltaBacklogItems({ repo: 'ashlrai/lexicon', runsDir, journalPath: recurringPath })).toEqual([]);
    expect(await prDeltaBacklogItems({ repo: '', runsDir, journalPath: recurringPath })).toEqual([]);
    expect(await prDeltaBacklogItems({ repo: 'ashlrai/phantom', runsDir, journalPath: recurringPath })).not.toEqual([]);

    // Rows below the recurring bars emit nothing.
    const sparse = [deltaRow({ day: daysAgo(1), unmeasuredPrs: 1 }), 'not json at all'];
    const sparsePath = await journal('pr-delta-sparse', sparse, runsDir);
    expect(await prDeltaBacklogItems({ repo: 'ashlrai/phantom', runsDir, journalPath: sparsePath })).toEqual([]);

    // All-malformed content emits nothing.
    const junkPath = await journal('pr-delta-junk', ['not json', '{}', '[1]'], runsDir);
    expect(await prDeltaBacklogItems({ repo: 'ashlrai/phantom', runsDir, journalPath: junkPath })).toEqual([]);
  });

  it('states truncation as a lower bound', async () => {
    const runsDir = join(home, '.ashlr-runs');
    const rows = deltaSeries({ days: 4, unmeasured: 2 });
    // Pad past the tail bound so the read reports truncated.
    const pad = 'x'.repeat(PR_DELTA_TAIL_BYTES + 1024);
    const path = join(runsDir, 'metrics', 'pr-delta-big.jsonl');
    await mkdir(join(runsDir, 'metrics'), { recursive: true });
    await writeFile(path, `${pad}\n${rows.join('\n')}\n`);
    const items = await prDeltaBacklogItems({ repo: 'ashlrai/phantom', runsDir, journalPath: path });
    expect(items).toHaveLength(1);
    expect(items[0]!.prompt).toContain('lower bound');
  });

  it('derives a stable id and honours the limit', async () => {
    const runsDir = join(home, '.ashlr-runs');
    const path = await journal('pr-delta-stable', deltaSeries({ days: 5, unmeasured: 2 }), runsDir);
    const opts = { repo: 'ashlrai/phantom', runsDir, journalPath: path };
    const first = await prDeltaBacklogItems(opts);
    const second = await prDeltaBacklogItems(opts);
    expect(first).toHaveLength(1);
    expect(second.map((i) => i.id)).toEqual(first.map((i) => i.id));
    const limited = await prDeltaBacklogItems({ ...opts, limit: PR_DELTA_BACKLOG_MAX_ITEMS });
    expect(limited).toHaveLength(1);
  });

  it('reads the default journal path under the relocated home', async () => {
    // prDeltaBacklogItems resolves <runsDir>/metrics/pr-delta.jsonl through
    // $ASHLR_RUNS_DIR ?? ~/.ashlr-runs; the relocated HOME controls the latter.
    const metrics = join(home, '.ashlr-runs', 'metrics');
    await mkdir(metrics, { recursive: true });
    await writeFile(join(metrics, 'pr-delta.jsonl'), deltaSeries({ days: 4, unmeasured: 2 }).join('\n') + '\n');
    const items = await prDeltaBacklogItems({ repo: 'ashlrai/phantom' });
    expect(items).toHaveLength(1);
    expect(items[0]!.id.startsWith('pr-delta-')).toBe(true);
  });

  it('honours a non-empty ASHLR_RUNS_DIR override', async () => {
    const runsDir = join(home, 'custom-runs');
    process.env.ASHLR_RUNS_DIR = runsDir;
    const metrics = join(runsDir, 'metrics');
    await mkdir(metrics, { recursive: true });
    await writeFile(join(metrics, 'pr-delta.jsonl'), deltaSeries({ days: 4, unmeasured: 2 }).join('\n') + '\n');
    const items = await prDeltaBacklogItems({ repo: 'ashlrai/phantom' });
    expect(items).toHaveLength(1);
  });

  it('appends the delta item through discovery and dedupes on refresh', async () => {
    const metrics = join(home, '.ashlr-runs', 'metrics');
    await mkdir(metrics, { recursive: true });
    await writeFile(
      join(metrics, 'pr-delta.jsonl'),
      [...deltaSeries({ days: 4, unmeasured: 2 }), deltaRow({ day: daysAgo(8), unmeasuredPrs: 1, prsMerged: 2 })].join('\n') + '\n',
    );
    const greenGh = async (args: string[]) => {
      const p = args[4] ?? '';
      if (p === 'repos/ashlrai/phantom') return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n{"default_branch":"master"}', stderr: '' };
      return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n[]', stderr: '' };
    };
    const first = await discoverBacklog('ashlrai/phantom', { gh: greenGh });
    const deltaItems = first.items.filter((i) => i.id.startsWith('pr-delta-'));
    expect(deltaItems).toHaveLength(1);
    expect(deltaItems[0]!.area).toBe('fleet-metrics');
    expect(first.items.every((i) => validBacklogItem(i) !== null)).toBe(true);
    expect(appendUserBacklogItems(deltaItems)).toBe(1);
    const second = await discoverBacklog('ashlrai/phantom', { gh: greenGh });
    expect(appendUserBacklogItems(second.items.filter((i) => i.id.startsWith('pr-delta-')))).toBe(0);
    expect(readUserBacklogItems().filter((i) => i.id.startsWith('pr-delta-'))).toHaveLength(1);
  });
});
