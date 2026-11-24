import { mkdir, mkdtemp, rm, truncate, writeFile, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  devinReviewBacklogItems,
  devinReviewCells,
  DEVIN_REVIEW_MIN_DAYS,
  DEVIN_REVIEW_MIN_PRS,
  DEVIN_REVIEW_MIN_ROWS,
  DEVIN_REVIEW_ORPHAN_STALE_MS,
  DEVIN_REVIEW_WINDOW_MS,
  foldDevinReviewRows,
  parseDevinReviewJournal,
  parseDevinReviewJournalEntry,
} from '../src/core/improve/devin-review-backlog.js';
import { devinPrReviewKey } from '../src/core/devin/pr-review.js';
import { PR_REVIEW_JOURNAL_MAX_BYTES } from '../src/core/devin/store.js';
import { discoverBacklog } from '../src/core/improve/discover.js';
import { appendUserBacklogItems, readUserBacklogItems, validBacklogItem } from '../src/core/cloud/backlog.js';

const DAY = 86_400_000;
const HOUR = 3_600_000;
const J = (o: Record<string, unknown>): string => JSON.stringify(o);

/** Fixed evaluation instant; fixture timestamps are ISO-8601 UTC like the journal writer's `at`. */
const NOW_MS = Date.parse('2026-11-23T12:00:00.000Z');
const iso = (ms: number): string => new Date(ms).toISOString();
const sha = (seed: string): string => seed.repeat(45).slice(0, 40);
const dayKey = (ms: number): string => iso(ms).slice(0, 10);

/**
 * One row in the writer's journaled shape — triggerDevinPrReviewOnce's
 * row() emits {v:1, repo, number, headSha, origin, key, at, day,
 * outcome, ...extra}; `requested` is always paired with one terminal
 * row carrying the same `at`.
 */
function reviewRow(spec: {
  atMs?: number;
  repo?: string;
  number?: number;
  headSha?: string;
  origin?: 'fleet' | 'cli';
  outcome?: 'requested' | 'triggered' | 'failed' | 'quota-exhausted';
  reason?: string;
  status?: string;
  key?: string;
  extra?: Record<string, unknown>;
}): string {
  const atMs = spec.atMs ?? NOW_MS;
  const repo = spec.repo ?? 'ashlrai/phantom';
  const number = spec.number ?? 100;
  const headSha = spec.headSha ?? sha('a');
  const outcome = spec.outcome ?? 'failed';
  return J({
    v: 1,
    repo,
    number,
    headSha,
    origin: spec.origin ?? 'fleet',
    key: spec.key ?? devinPrReviewKey(repo, number, headSha),
    at: iso(atMs),
    day: dayKey(atMs),
    outcome,
    ...(spec.reason !== undefined ? { reason: spec.reason } : {}),
    ...(spec.status !== undefined ? { status: spec.status } : {}),
    ...spec.extra,
  });
}

/**
 * A resolved attempt: 'requested' plus one terminal row sharing `at`,
 * exactly what triggerDevinPrReviewOnce appends per call.
 */
function attempt(spec: {
  atMs?: number;
  repo?: string;
  number?: number;
  headSha?: string;
  origin?: 'fleet' | 'cli';
  terminal?: 'triggered' | 'failed' | 'quota-exhausted';
  status?: string;
}): string[] {
  const headSha = spec.headSha ?? sha(`${spec.number ?? 100}`.padEnd(2, '0'));
  const base = {
    atMs: spec.atMs,
    repo: spec.repo,
    number: spec.number,
    headSha,
    origin: spec.origin,
  };
  return [
    reviewRow({ ...base, outcome: 'requested' }),
    reviewRow({ ...base, outcome: spec.terminal ?? 'triggered', status: spec.status ?? 'completed' }),
  ];
}

/**
 * Recurring adverse rows on one outcome. Each attempt contributes a
 * 'requested' row plus its terminal row; pass resolved:false to emit
 * orphaned requests (requested rows with no terminal sibling).
 */
function adverseSeries(opts: {
  outcome?: 'failed' | 'quota-exhausted';
  days: number;
  prs: number;
  perPr?: number;
  repo?: string;
  origin?: 'fleet' | 'cli';
  resolved?: boolean;
}): string[] {
  const rows: string[] = [];
  const perPr = opts.perPr ?? 1;
  for (let p = 0; p < opts.prs; p++) {
    for (let d = 0; d < opts.days; d++) {
      for (let i = 0; i < perPr; i++) {
        const atMs = NOW_MS - d * DAY - p * HOUR - i * HOUR;
        if (opts.resolved === false) {
          rows.push(reviewRow({
            atMs,
            repo: opts.repo,
            number: 100 + p,
            headSha: sha(`${p}${d}${i}`),
            origin: opts.origin,
            outcome: 'requested',
          }));
        } else {
          rows.push(...attempt({
            atMs,
            repo: opts.repo,
            number: 100 + p,
            headSha: sha(`${p}${d}${i}`),
            origin: opts.origin,
            terminal: opts.outcome ?? 'failed',
          }));
        }
      }
    }
  }
  return rows;
}

/** The production fold: one journal text for the target repo. */
function foldRows(text: string, repo = 'ashlrai/phantom', nowMs = NOW_MS) {
  return foldDevinReviewRows(text, { nowMs, repo });
}

describe('parseDevinReviewJournalEntry', () => {
  it('accepts writer-shaped rows and rejects off-contract shapes', () => {
    const good = JSON.parse(reviewRow({ outcome: 'triggered', status: 'running' }));
    expect(parseDevinReviewJournalEntry(good)).toMatchObject({
      repo: 'ashlrai/phantom',
      repoKey: 'ashlrai/phantom',
      number: 100,
      outcome: 'triggered',
      origin: 'fleet',
      status: 'running',
      reason: null,
    });
    expect(parseDevinReviewJournalEntry(null)).toBeNull();
    expect(parseDevinReviewJournalEntry('x')).toBeNull();
    expect(parseDevinReviewJournalEntry({ ...good, v: 2 })).toBeNull();
    expect(parseDevinReviewJournalEntry({ ...good, key: '' })).toBeNull();
    expect(parseDevinReviewJournalEntry({ ...good, key: 'k'.repeat(201) })).toBeNull();
    expect(parseDevinReviewJournalEntry({ ...good, repo: 'not-a-repo' })).toBeNull();
    expect(parseDevinReviewJournalEntry({ ...good, repo: 'a/b/c' })).toBeNull();
    expect(parseDevinReviewJournalEntry({ ...good, number: 0 })).toBeNull();
    expect(parseDevinReviewJournalEntry({ ...good, number: 1.5 })).toBeNull();
    expect(parseDevinReviewJournalEntry({ ...good, number: '7' })).toBeNull();
    expect(parseDevinReviewJournalEntry({ ...good, headSha: 'xyz' })).toBeNull();
    expect(parseDevinReviewJournalEntry({ ...good, headSha: 'a'.repeat(39) })).toBeNull();
    expect(parseDevinReviewJournalEntry({ ...good, at: 'not a date' })).toBeNull();
    expect(parseDevinReviewJournalEntry({ ...good, at: 123 })).toBeNull();
    expect(parseDevinReviewJournalEntry({ ...good, day: '' })).toBeNull();
    expect(parseDevinReviewJournalEntry({ ...good, origin: 'bot' })).toBeNull();
    expect(parseDevinReviewJournalEntry({ ...good, outcome: 'refused' })).toBeNull();
    expect(parseDevinReviewJournalEntry({ ...good, status: 'bogus' })).toBeNull();
    expect(parseDevinReviewJournalEntry({ ...good, reason: 'x'.repeat(121) })).toBeNull();
    expect(parseDevinReviewJournalEntry({ ...good, key: 'bad\nkey' })).toBeNull();
  });
});

describe('parseDevinReviewJournal', () => {
  it('counts malformed and off-contract lines without guessing', () => {
    const text = [
      reviewRow({ outcome: 'failed' }),
      'not json at all',
      J({ v: 1, hello: 'world' }),
      reviewRow({ outcome: 'quota-exhausted' }),
      '',
    ].join('\n');
    const parsed = parseDevinReviewJournal(text);
    expect(parsed.rows).toHaveLength(2);
    expect(parsed.invalidRows).toBe(2);
  });
});

describe('foldDevinReviewRows', () => {
  it('folds adverse outcomes per kind and skips the healthy path', () => {
    const rows = [
      // Resolved healthy attempts — requested + triggered pairs.
      ...attempt({ atMs: NOW_MS - HOUR, number: 1, terminal: 'triggered' }),
      ...attempt({ atMs: NOW_MS - 2 * HOUR, number: 2, terminal: 'triggered', status: 'pending' }),
      // Adverse: two failed attempts on distinct PRs/days.
      ...attempt({ atMs: NOW_MS - DAY, number: 3, terminal: 'failed' }),
      ...attempt({ atMs: NOW_MS - 2 * DAY, number: 4, terminal: 'failed' }),
      ...attempt({ atMs: NOW_MS - 3 * DAY, number: 5, terminal: 'quota-exhausted' }),
      // Foreign shapes.
      'not json',
      J({ v: 9, key: 'x' }),
    ];
    const fold = foldRows(rows.join('\n'));
    // 5 resolved attempts × 2 rows = 10 in-window on-contract rows.
    expect(fold.rows).toBe(10);
    expect(fold.invalidRows).toBe(2);
    expect(fold.cells.get('failed')!.rows).toBe(2);
    expect(fold.cells.get('quota-exhausted')!.rows).toBe(1);
    expect(fold.cells.has('orphaned-request')).toBe(false);
  });

  it('marks stale requested rows without terminal siblings as orphaned', () => {
    const stale = NOW_MS - DEVIN_REVIEW_ORPHAN_STALE_MS - HOUR;
    const rows = [
      // Orphaned: requested only, older than the staleness bound.
      reviewRow({ atMs: stale, number: 10, headSha: sha('b'), outcome: 'requested' }),
      reviewRow({ atMs: stale - DAY, number: 11, headSha: sha('c'), outcome: 'requested' }),
      // Resolved request: requested + triggered share `at`.
      ...attempt({ atMs: NOW_MS - DAY, number: 12, headSha: sha('d'), terminal: 'triggered' }),
      // Fresh request without outcome yet — in flight, not orphaned.
      reviewRow({ atMs: NOW_MS - HOUR, number: 13, headSha: sha('e'), outcome: 'requested' }),
      // Requested row whose terminal sibling exists for the same key.
      ...attempt({ atMs: NOW_MS - 2 * DAY, number: 14, headSha: sha('f'), terminal: 'failed' }),
    ];
    const fold = foldRows(rows.join('\n'));
    const orphan = fold.cells.get('orphaned-request')!;
    expect(orphan.rows).toBe(2);
    expect(orphan.prs.size).toBe(2);
    expect(orphan.days.size).toBe(2);
    // The resolved requested rows never join the orphan cell.
    expect(fold.cells.get('failed')!.rows).toBe(1);
  });

  it('matches rows to the discovery repo case-insensitively and windows them', () => {
    const rows = [
      // Target repo, in window.
      ...attempt({ atMs: NOW_MS - DAY, repo: 'AshlrAI/Phantom', number: 20, terminal: 'failed' }),
      // Other repo — never joins a cell.
      ...attempt({ atMs: NOW_MS - DAY, repo: 'ashlrai/lexicon', number: 21, terminal: 'failed' }),
      ...attempt({ atMs: NOW_MS - 2 * DAY, repo: 'ashlrai/lexicon', number: 22, terminal: 'failed' }),
      // Target repo but outside the window.
      ...attempt({ atMs: NOW_MS - DEVIN_REVIEW_WINDOW_MS - DAY, number: 23, terminal: 'failed' }),
      // Beyond the future-skew allowance.
      ...attempt({ atMs: NOW_MS + DAY, number: 24, terminal: 'failed' }),
    ];
    const fold = foldRows(rows.join('\n'));
    // Only the in-window target-repo rows count: 1 failed terminal + its requested = 2 rows.
    expect(fold.rows).toBe(2);
    expect(fold.otherRepo).toBe(4);
    expect(fold.outsideWindow).toBe(4);
    expect(fold.cells.get('failed')!.rows).toBe(1);
    expect(fold.cells.get('failed')!.prs.size).toBe(1);
  });
});

describe('devinReviewCells', () => {
  it('emits cells only at the row/day/PR bars', () => {
    // Below bars: three failed rows on one PR across days — one stubborn
    // pull request is not a broken trigger path.
    const onePr = [
      ...adverseSeries({ outcome: 'failed', days: DEVIN_REVIEW_MIN_DAYS + 1, prs: 1, perPr: 2 }),
    ];
    const thinPr = foldRows(onePr.join('\n'));
    expect(thinPr.cells.get('failed')!.rows).toBeGreaterThanOrEqual(DEVIN_REVIEW_MIN_ROWS);
    expect(thinPr.cells.get('failed')!.days.size).toBeGreaterThanOrEqual(DEVIN_REVIEW_MIN_DAYS);
    expect(thinPr.cells.get('failed')!.prs.size).toBe(1);
    expect(devinReviewCells(thinPr)).toEqual([]);

    // Below bars: rows across PRs but a single UTC day.
    const oneDay = [
      ...adverseSeries({ outcome: 'failed', days: 1, prs: DEVIN_REVIEW_MIN_PRS + 1, perPr: 2 }),
    ];
    // perPr attempts land hours apart on the same day; force same-day by using day 0 offsets only.
    const sameDay = foldRows(oneDay.join('\n'));
    expect(sameDay.cells.get('failed')!.days.size).toBe(1);
    expect(devinReviewCells(sameDay)).toEqual([]);

    // At the bars: rows + days + PRs → emits, quota first.
    const good = foldRows([
      ...adverseSeries({ outcome: 'failed', days: DEVIN_REVIEW_MIN_DAYS, prs: DEVIN_REVIEW_MIN_PRS, perPr: 2 }),
      ...adverseSeries({ outcome: 'quota-exhausted', days: DEVIN_REVIEW_MIN_DAYS, prs: DEVIN_REVIEW_MIN_PRS }),
    ].join('\n'));
    const cells = devinReviewCells(good);
    expect(cells.map((c) => c.kind)).toEqual(['quota-exhausted', 'failed']);
    const [quota, failed] = cells;
    expect(quota).toMatchObject({ kind: 'quota-exhausted' });
    expect(quota!.rows).toBeGreaterThanOrEqual(DEVIN_REVIEW_MIN_ROWS);
    expect(quota!.days.length).toBeGreaterThanOrEqual(DEVIN_REVIEW_MIN_DAYS);
    expect(quota!.prs).toBeGreaterThanOrEqual(DEVIN_REVIEW_MIN_PRS);
    expect(failed).toMatchObject({ kind: 'failed' });
    expect(failed!.origins.map((t) => t.text)).toContain('fleet');
  });

  it('marks truncation as a lower bound on every cell', () => {
    const fold = foldRows(adverseSeries({ outcome: 'failed', days: 3, prs: 2, perPr: 2 }).join('\n'));
    const cells = devinReviewCells(fold, true);
    expect(cells).toHaveLength(1);
    expect(cells[0]!.lowerBound).toBe(true);
    expect(devinReviewCells(fold, false)[0]!.lowerBound).toBe(false);
  });
});

describe('devinReviewBacklogItems', () => {
  let home: string;
  let saved: { HOME?: string; ASHLR_HOME?: string };
  const NOW = new Date(NOW_MS);

  beforeEach(async () => {
    saved = { HOME: process.env.HOME, ASHLR_HOME: process.env.ASHLR_HOME };
    delete process.env.ASHLR_HOME;
    home = await mkdtemp(join(tmpdir(), 'devin-review-backlog-'));
    process.env.HOME = home;
  });
  afterEach(async () => {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    vi.restoreAllMocks();
    await rm(home, { recursive: true, force: true });
  });

  /** A journal file under the temp home carrying the given rows. */
  async function journal(name: string, rows: string[]): Promise<string> {
    const dir = join(home, 'devin');
    await mkdir(dir, { recursive: true });
    const path = join(dir, `${name}.jsonl`);
    await writeFile(path, rows.join('\n') + '\n');
    return path;
  }

  it('emits one item per recurring cell with grounded prompts', async () => {
    const rows = [
      ...adverseSeries({ outcome: 'failed', days: 2, prs: 2, perPr: 2 }),
      ...adverseSeries({ outcome: 'quota-exhausted', days: 2, prs: 2 }),
    ];
    const path = await journal('pr-reviews', rows);
    const items = await devinReviewBacklogItems({ repo: 'ashlrai/phantom', journalPath: path, now: NOW });
    expect(items).toHaveLength(2);
    expect(items.map((i) => i.area)).toEqual(['devin-review-quota', 'devin-review-failed']);
    for (const item of items) {
      expect(item.id).toMatch(/^devin-review-(quota-exhausted|failed)-[0-9a-f]{16}$/);
      expect(item).toMatchObject({ priority: 3, repo: 'ashlrai/phantom' });
      expect(validBacklogItem(item)).not.toBeNull();
      expect(item.prompt).toContain('pr-reviews.jsonl');
      expect(item.prompt).toContain('no-change');
      expect(item.prompt).not.toContain('lower bound');
    }
    const [quota, failed] = items;
    expect(quota!.title).toContain('quota');
    expect(quota!.prompt).toContain('quota-exhausted');
    expect(quota!.prompt).toContain('weekly-capacity');
    expect(failed!.title).toContain('failing');
    expect(failed!.prompt).toContain("outcome 'failed'");
    expect(failed!.prompt).toContain('DevinFailureCode');
  });

  it('emits nothing for missing, unreadable, foreign-repo or below-bar evidence', async () => {
    expect(await devinReviewBacklogItems({ repo: 'ashlrai/phantom', journalPath: join(home, 'nope', 'pr-reviews.jsonl'), now: NOW })).toEqual([]);

    // A directory instead of a file.
    const dirPath = join(home, 'devin', 'pr-reviews.jsonl');
    await mkdir(dirPath, { recursive: true });
    expect(await devinReviewBacklogItems({ repo: 'ashlrai/phantom', journalPath: dirPath, now: NOW })).toEqual([]);

    // Rows for another repository never emit for this target.
    const foreign = adverseSeries({ outcome: 'failed', days: 3, prs: 3, repo: 'ashlrai/lexicon' });
    const foreignPath = await journal('pr-reviews-foreign', foreign);
    expect(await devinReviewBacklogItems({ repo: 'ashlrai/phantom', journalPath: foreignPath, now: NOW })).toEqual([]);
    expect(await devinReviewBacklogItems({ repo: '', journalPath: foreignPath, now: NOW })).toEqual([]);
    expect(await devinReviewBacklogItems({ repo: 'not a repo', journalPath: foreignPath, now: NOW })).toEqual([]);
    // ...but they do emit for the repo they name.
    expect(await devinReviewBacklogItems({ repo: 'ashlrai/lexicon', journalPath: foreignPath, now: NOW })).not.toEqual([]);

    // Below the bars: two PRs but only one UTC day of failures.
    const thin = adverseSeries({ outcome: 'failed', days: 1, prs: 3, perPr: 2 });
    const thinPath = await journal('pr-reviews-thin', thin);
    expect(await devinReviewBacklogItems({ repo: 'ashlrai/phantom', journalPath: thinPath, now: NOW })).toEqual([]);

    // A journal with only the healthy path emits nothing.
    const healthy = [
      ...attempt({ atMs: NOW_MS - DAY, number: 1, terminal: 'triggered' }),
      ...attempt({ atMs: NOW_MS - 2 * DAY, number: 2, terminal: 'triggered' }),
      ...attempt({ atMs: NOW_MS - 3 * DAY, number: 3, terminal: 'triggered' }),
      'not json at all',
    ];
    const healthyPath = await journal('pr-reviews-healthy', healthy);
    expect(await devinReviewBacklogItems({ repo: 'ashlrai/phantom', journalPath: healthyPath, now: NOW })).toEqual([]);
  });

  it('emits an oversize item for the fleet repo when the journal passes the writer bound', async () => {
    const path = join(home, 'devin', 'pr-reviews-oversize.jsonl');
    await mkdir(join(home, 'devin'), { recursive: true });
    // Sparse file one byte past the writer's own read bound: readLedgerTail
    // reports truncated, which is exactly the condition journalRows refuses on.
    await writeFile(path, '');
    await truncate(path, PR_REVIEW_JOURNAL_MAX_BYTES + 1);
    const fleet = await devinReviewBacklogItems({ repo: 'ashlrai/phantom', journalPath: path, now: NOW });
    expect(fleet).toHaveLength(1);
    expect(fleet[0]!.id).toMatch(/^devin-review-journal-oversize-[0-9a-f]{16}$/);
    expect(fleet[0]!.area).toBe('devin-review-oversize');
    expect(fleet[0]!.prompt).toContain('read bound');
    expect(fleet[0]!.prompt).toContain('no-change');
    // The oversize condition is install-wide but repo-less: a non-fleet
    // target does not inherit it (and has no rows to fold either).
    expect(await devinReviewBacklogItems({ repo: 'ashlrai/lexicon', journalPath: path, now: NOW })).toEqual([]);
  });

  it('states truncation as a lower bound in every prompt', async () => {
    const rows = adverseSeries({ outcome: 'failed', days: 3, prs: 2, perPr: 2 });
    const path = join(home, 'devin', 'pr-reviews-big.jsonl');
    await mkdir(join(home, 'devin'), { recursive: true });
    // Sparse padding past the bound, then the rows: the tail keeps the
    // newest bytes so the rows fold while truncated stays true.
    await writeFile(path, '');
    await truncate(path, PR_REVIEW_JOURNAL_MAX_BYTES + 1);
    await appendFile(path, rows.join('\n') + '\n');
    const items = await devinReviewBacklogItems({ repo: 'ashlrai/phantom', journalPath: path, now: NOW });
    // Oversize item plus the failed cell, all stating the lower bound.
    expect(items.map((i) => i.area)).toContain('devin-review-oversize');
    expect(items.map((i) => i.area)).toContain('devin-review-failed');
    expect(items.every((i) => i.prompt.includes('lower bound') || i.area === 'devin-review-oversize')).toBe(true);
    const failed = items.find((i) => i.area === 'devin-review-failed')!;
    expect(failed.prompt).toContain('lower bound');
  });

  it('derives stable ids so a refresh re-adds nothing and honours the limit', async () => {
    const rows = [
      ...adverseSeries({ outcome: 'failed', days: 2, prs: 2, perPr: 2 }),
      ...adverseSeries({ outcome: 'quota-exhausted', days: 2, prs: 2 }),
      ...adverseSeries({ outcome: 'failed', days: 3, prs: 3, perPr: 1, repo: 'ashlrai/lexicon' }),
    ];
    const path = await journal('pr-reviews-stable', rows);
    const opts = { repo: 'ashlrai/phantom', journalPath: path, now: NOW };
    const first = await devinReviewBacklogItems(opts);
    const second = await devinReviewBacklogItems(opts);
    expect(second.map((i) => i.id)).toEqual(first.map((i) => i.id));
    expect(first).toHaveLength(2);
    // Repo scoping: the lexicon rows mint their own ids under that repo.
    const other = await devinReviewBacklogItems({ ...opts, repo: 'ashlrai/lexicon' });
    expect(other).toHaveLength(1);
    expect(other[0]!.id).not.toBe(first.find((i) => i.area === 'devin-review-failed')!.id);
    const limited = await devinReviewBacklogItems({ ...opts, limit: 1 });
    expect(limited).toHaveLength(1);
    expect(first.map((i) => i.id)).toContain(limited[0]!.id);
  });

  it('appends devin-review items through discovery and dedupes on refresh', async () => {
    // discoverBacklog anchors the window on the real clock, so these rows
    // are stamped relative to Date.now() rather than the fixed NOW_MS.
    // The journal's writer path is <ashlr home>/devin/pr-reviews.jsonl —
    // the relocated HOME is the temp dir.
    const realNow = Date.now();
    const at = (d: number, i = 0): number => realNow - d * DAY - i * HOUR;
    const dir = join(home, '.ashlr', 'devin');
    await mkdir(dir, { recursive: true });
    const liveRows = [
      ...attempt({ atMs: at(0), number: 30, headSha: sha('1'), terminal: 'failed' }),
      ...attempt({ atMs: at(1), number: 31, headSha: sha('2'), terminal: 'failed' }),
      ...attempt({ atMs: at(2), number: 32, headSha: sha('3'), terminal: 'failed' }),
      ...attempt({ atMs: at(0, 1), number: 33, headSha: sha('4'), terminal: 'quota-exhausted' }),
      ...attempt({ atMs: at(1, 1), number: 34, headSha: sha('5'), terminal: 'quota-exhausted' }),
      ...attempt({ atMs: at(2, 1), number: 35, headSha: sha('6'), terminal: 'quota-exhausted' }),
    ];
    await writeFile(join(dir, 'pr-reviews.jsonl'), liveRows.join('\n') + '\n');
    const greenGh = async (args: string[]) => {
      const p = args[4] ?? '';
      if (p === 'repos/ashlrai/phantom') return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n{"default_branch":"master"}', stderr: '' };
      return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n[]', stderr: '' };
    };
    const first = await discoverBacklog('ashlrai/phantom', { gh: greenGh });
    const journalItems = first.items.filter((i) => i.id.startsWith('devin-review-'));
    expect(journalItems).toHaveLength(2);
    expect(journalItems.map((i) => i.area)).toEqual(['devin-review-quota', 'devin-review-failed']);
    expect(first.items.every((i) => validBacklogItem(i) !== null)).toBe(true);
    expect(appendUserBacklogItems(journalItems)).toBe(2);
    const second = await discoverBacklog('ashlrai/phantom', { gh: greenGh });
    expect(appendUserBacklogItems(second.items.filter((i) => i.id.startsWith('devin-review-')))).toBe(0);
    expect(readUserBacklogItems().filter((i) => i.id.startsWith('devin-review-'))).toHaveLength(2);
  });
});
