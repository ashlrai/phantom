/**
 * review-blocks-backlog — the nightly retro's review-block journal folded
 * into self-improvement backlog items.
 *
 * Contract:
 *   - A repo cell emits only at REVIEW_BLOCKS_MIN_ROWS (3) review-block
 *     rows inside the 7-day window spanning REVIEW_BLOCKS_MIN_DAYS (2)
 *     distinct UTC days; rows outside the window or past the future skew
 *     never count toward the bar.
 *   - Rows count only under the producer's wire contract (v:1,
 *     kind 'review-block', retro-pattern id/jobId/repo, canonical ISO
 *     updatedAt, body within the 16 KiB bound); malformed lines and
 *     off-contract rows are counted as dropped, never guessed.
 *   - The fold dedupes on (repo,id) keeping the latest updatedAt — the
 *     producer's own merge — before windowing.
 *   - Items self-target the repository the blocked PRs named
 *     (owner/name), unlike the sibling machinery feeds that gate on the
 *     fleet repo; counts quote recorded floors when the tail truncated.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendUserBacklogItems, readUserBacklogItems, validBacklogItem } from '../src/core/cloud/backlog.js';
import {
  foldReviewBlockCells,
  parseReviewBlockEntry,
  parseReviewBlockText,
  REVIEW_BLOCKS_BACKLOG_MAX_ITEMS,
  REVIEW_BLOCKS_MIN_DAYS,
  REVIEW_BLOCKS_MIN_ROWS,
  REVIEW_BLOCKS_WINDOW_MS,
  reviewBlocksBacklogItems,
  type ReviewBlockRow,
} from '../src/core/improve/review-blocks-backlog.js';
import { discoverBacklog } from '../src/core/improve/discover.js';

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
// Fixed midday-UTC anchor: hours-ago offsets can never cross a UTC day
// boundary, so the same-day bar test is deterministic at any run time.
const NOW_MS = Date.parse('2026-11-26T12:00:00.000Z');
const iso = (msAgo: number): string => new Date(NOW_MS - msAgo).toISOString();
const daysAgo = (days: number): string => iso(days * DAY);
const hoursAgo = (hours: number): string => iso(hours * 60 * MIN);

const BODY = 'Recorded GitHub review verdict with 2 recorded change requests on acme/widgets#42 at head abc123def456.';

const entry = (
  repo: string,
  task: string,
  updatedAt: string,
  over: Record<string, unknown> = {},
): Record<string, unknown> => ({
  v: 1,
  id: `cloud-review:${task}`,
  jobId: task,
  repo,
  kind: 'review-block',
  updatedAt,
  body: BODY,
  ...over,
});

const row = (repo: string, task: string, updatedAt: string): ReviewBlockRow => ({
  id: `cloud-review:${task}`, jobId: task, repo, atMs: Date.parse(updatedAt),
});

describe('parseReviewBlockEntry', () => {
  it('accepts a contract row and carries the outcome clock', () => {
    const at = daysAgo(2);
    expect(parseReviewBlockEntry(entry('acme/widgets', 'task-1', at))).toEqual({
      id: 'cloud-review:task-1', jobId: 'task-1', repo: 'acme/widgets', atMs: Date.parse(at),
    });
  });

  it('rejects off-contract shapes without guessing', () => {
    const at = daysAgo(1);
    expect(parseReviewBlockEntry(null)).toBeNull();
    expect(parseReviewBlockEntry('x')).toBeNull();
    expect(parseReviewBlockEntry([])).toBeNull();
    expect(parseReviewBlockEntry(entry('acme/widgets', 'task-1', at, { v: 2 }))).toBeNull();
    expect(parseReviewBlockEntry(entry('acme/widgets', 'task-1', at, { kind: 'job' }))).toBeNull();
    expect(parseReviewBlockEntry(entry('acme/widgets', 'task 1', at))).toBeNull();
    expect(parseReviewBlockEntry(entry('acme/widgets', 'task-1', at, { id: '' }))).toBeNull();
    expect(parseReviewBlockEntry(entry('acme/widgets', 'task-1', at, { jobId: 'bad id' }))).toBeNull();
    expect(parseReviewBlockEntry(entry('widgets', 'task-1', at))).toBeNull();
    expect(parseReviewBlockEntry(entry('acme/widgets/extra', 'task-1', at))).toBeNull();
    expect(parseReviewBlockEntry(entry('acme/widgets', 'task-1', 'not a date'))).toBeNull();
    // The producer's timestamp rule is canonical ISO: no-millis spelling fails the round-trip.
    expect(parseReviewBlockEntry(entry('acme/widgets', 'task-1', '2026-11-26T00:00:00Z'))).toBeNull();
    expect(parseReviewBlockEntry(entry('acme/widgets', 'task-1', at, { body: undefined }))).toBeNull();
    expect(parseReviewBlockEntry(entry('acme/widgets', 'task-1', at, { body: 42 }))).toBeNull();
    expect(parseReviewBlockEntry(entry('acme/widgets', 'task-1', at, { body: 'x'.repeat(16_385) }))).toBeNull();
  });

  it('keeps a max-size body and rejects a persisted cause-shaped row', () => {
    const at = daysAgo(1);
    expect(parseReviewBlockEntry(entry('acme/widgets', 'task-1', at, { body: 'x'.repeat(16_384) }))).not.toBeNull();
    // The state shape (cause, no body) belongs to retro-proposals.json, not this input file.
    expect(parseReviewBlockEntry({ v: 1, id: 'r1', jobId: 'j1', repo: 'acme/widgets', kind: 'review-block', updatedAt: at, cause: 'review' })).toBeNull();
  });
});

describe('parseReviewBlockText', () => {
  it('parses contract rows and counts malformed or off-contract lines', () => {
    const at = daysAgo(1);
    const parsed = parseReviewBlockText([
      JSON.stringify(entry('acme/widgets', 'task-1', at)),
      '',
      '   ',
      'not json at all',
      JSON.stringify(entry('acme/widgets', 'task-2', at, { kind: 'job' })),
      JSON.stringify(entry('acme/other', 'task-3', at)),
    ].join('\n'));
    expect(parsed.rows).toHaveLength(2);
    expect(parsed.rows.map((r) => r.repo).sort()).toEqual(['acme/other', 'acme/widgets']);
    expect(parsed.invalidRows).toBe(2);
  });
});

describe('foldReviewBlockCells', () => {
  const opts = { nowMs: NOW_MS, windowMs: REVIEW_BLOCKS_WINDOW_MS };

  it('groups in-window rows per repo with day and task tallies', () => {
    const cells = foldReviewBlockCells([
      row('acme/widgets', 'task-1', daysAgo(1)),
      row('acme/widgets', 'task-2', daysAgo(2)),
      row('acme/widgets', 'task-3', daysAgo(3)),
      row('acme/widgets', 'task-4', daysAgo(3)),
      row('acme/other', 'task-9', daysAgo(1)),
    ], opts);
    expect(cells).toHaveLength(1);
    const cell = cells[0]!;
    expect(cell.repo).toBe('acme/widgets');
    expect(cell.rows).toBe(4);
    expect(cell.days.size).toBe(3);
    expect(cell.tasks.size).toBe(4);
    expect(cell.firstAtMs).toBe(Date.parse(daysAgo(3)));
    expect(cell.lastAtMs).toBe(Date.parse(daysAgo(1)));
  });

  it('emits only at the recurring bars: rows and distinct UTC days', () => {
    expect(REVIEW_BLOCKS_MIN_ROWS).toBe(3);
    expect(REVIEW_BLOCKS_MIN_DAYS).toBe(2);
    // Below the row bar.
    expect(foldReviewBlockCells([
      row('acme/widgets', 'task-1', daysAgo(1)),
      row('acme/widgets', 'task-2', daysAgo(2)),
    ], opts)).toEqual([]);
    // Enough rows but all on one UTC day.
    expect(foldReviewBlockCells([
      row('acme/widgets', 'task-1', hoursAgo(2)),
      row('acme/widgets', 'task-2', hoursAgo(5)),
      row('acme/widgets', 'task-3', hoursAgo(8)),
    ], opts)).toEqual([]);
    // Rows outside the window never count.
    expect(foldReviewBlockCells([
      row('acme/widgets', 'task-1', daysAgo(1)),
      row('acme/widgets', 'task-2', daysAgo(2)),
      row('acme/widgets', 'task-3', daysAgo(REVIEW_BLOCKS_WINDOW_MS / DAY + 1)),
    ], opts)).toEqual([]);
  });

  it('dedupes on (repo,id) keeping the latest updatedAt before windowing', () => {
    // Same review id recorded twice: the newer stamp wins. task-9's newer
    // stamp sits past the future skew, so the row folds to nothing — a
    // stale in-window duplicate cannot resurrect evidence the merge
    // already replaced. Survivors: task-1 (newest of its pair), task-2,
    // task-3 — 3 rows across 3 distinct UTC days.
    const future = new Date(NOW_MS + 2 * 3_600_000).toISOString();
    const cells = foldReviewBlockCells([
      row('acme/widgets', 'task-1', daysAgo(5)),
      row('acme/widgets', 'task-1', daysAgo(1)),
      row('acme/widgets', 'task-2', daysAgo(2)),
      row('acme/widgets', 'task-3', daysAgo(3)),
      row('acme/widgets', 'task-9', daysAgo(1)),
      row('acme/widgets', 'task-9', future),
    ], opts);
    expect(cells).toHaveLength(1);
    expect(cells[0]!.rows).toBe(3);
    expect(cells[0]!.tasks.size).toBe(3);
    expect(cells[0]!.lastAtMs).toBe(Date.parse(daysAgo(1)));
  });

  it('never counts rows stamped past the future skew', () => {
    const future = new Date(NOW_MS + 2 * 3_600_000).toISOString();
    expect(foldReviewBlockCells([
      row('acme/widgets', 'task-1', future),
      row('acme/widgets', 'task-2', daysAgo(1)),
      row('acme/widgets', 'task-3', daysAgo(2)),
    ], opts)).toEqual([]);
    // Inside the one-minute skew the stamp still counts as clock drift.
    const cells = foldReviewBlockCells([
      row('acme/widgets', 'task-1', new Date(NOW_MS + 30_000).toISOString()),
      row('acme/widgets', 'task-2', daysAgo(1)),
      row('acme/widgets', 'task-3', daysAgo(2)),
    ], opts);
    expect(cells).toHaveLength(1);
    expect(cells[0]!.rows).toBe(3);
  });
});

describe('reviewBlocksBacklogItems', () => {
  let home: string;
  let saved: { HOME?: string; ASHLR_HOME?: string; ASHLR_RUNS_DIR?: string };

  beforeEach(async () => {
    saved = { HOME: process.env.HOME, ASHLR_HOME: process.env.ASHLR_HOME, ASHLR_RUNS_DIR: process.env.ASHLR_RUNS_DIR };
    delete process.env.ASHLR_HOME;
    delete process.env.ASHLR_RUNS_DIR;
    home = await mkdtemp(join(tmpdir(), 'review-blocks-backlog-'));
    process.env.HOME = home;
  });
  afterEach(async () => {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    await rm(home, { recursive: true, force: true });
  });

  /** Write the journal at its default learnHome()/retro-input location. */
  async function journal(lines: string[] | null | undefined, name = 'review-blocks.jsonl'): Promise<string> {
    const dir = join(home, '.ashlr', 'learn', 'retro-input');
    await mkdir(dir, { recursive: true });
    if (lines !== undefined && lines !== null) {
      await writeFile(join(dir, name), lines.join('\n') + '\n');
    }
    return join(dir, name);
  }

  const RECURRING = [
    entry('acme/widgets', 'task-11', daysAgo(1)),
    entry('acme/widgets', 'task-12', daysAgo(2)),
    entry('acme/widgets', 'task-13', daysAgo(3)),
    entry('acme/widgets', 'task-14', daysAgo(4)),
  ];

  it('emits one self-targeted item per recurring repo and validates it', async () => {
    await journal(RECURRING.map((e) => JSON.stringify(e)));
    const items = await reviewBlocksBacklogItems({ homeDir: home, now: new Date(NOW_MS) });
    expect(items).toHaveLength(1);
    const [item] = items;
    expect(item).toMatchObject({ priority: 3, repo: 'acme/widgets', area: 'review-blocks' });
    expect(item!.id).toMatch(/^review-block-[0-9a-f]{16}$/);
    expect(item!.title).toContain('acme/widgets');
    expect(validBacklogItem(item)).not.toBeNull();
    expect(item!.prompt).toContain('4 review-block row(s)');
    expect(item!.prompt).toContain('4 distinct task(s)');
    expect(item!.prompt).toContain('review-blocks.jsonl');
    expect(item!.prompt).toContain('CHANGES_REQUESTED');
    expect(item!.prompt).toContain('no-change');
  });

  it('emits nothing below the bar, for a missing journal, or an unreadable one', async () => {
    await journal([
      JSON.stringify(entry('acme/widgets', 'task-21', daysAgo(1))),
      JSON.stringify(entry('acme/widgets', 'task-22', daysAgo(2))),
    ]);
    // Two rows never reach the bar.
    expect(await reviewBlocksBacklogItems({ homeDir: home, now: new Date(NOW_MS) })).toEqual([]);

    const emptyHome = await mkdtemp(join(tmpdir(), 'review-blocks-empty-'));
    try {
      expect(await reviewBlocksBacklogItems({ homeDir: emptyHome, now: new Date(NOW_MS) })).toEqual([]);
    } finally {
      await rm(emptyHome, { recursive: true, force: true });
    }

    // A directory where the journal file should be reads as not-file.
    const badDir = join(home, '.ashlr', 'learn', 'retro-input', 'review-blocks.jsonl');
    await rm(badDir);
    await mkdir(badDir, { recursive: true });
    expect(await reviewBlocksBacklogItems({ homeDir: home, now: new Date(NOW_MS) })).toEqual([]);
  });

  it('emits per-repo items that each carry their own repository target', async () => {
    await journal([
      ...RECURRING.map((e) => JSON.stringify(e)),
      JSON.stringify(entry('acme/other', 'task-31', daysAgo(1))),
      JSON.stringify(entry('acme/other', 'task-32', daysAgo(2))),
      JSON.stringify(entry('acme/other', 'task-33', daysAgo(3))),
      JSON.stringify(entry('acme/other', 'task-34', daysAgo(4))),
    ]);
    const items = await reviewBlocksBacklogItems({ homeDir: home, now: new Date(NOW_MS) });
    expect(items).toHaveLength(2);
    const repos = items.map((i) => i.repo).sort();
    expect(repos).toEqual(['acme/other', 'acme/widgets']);
    expect(items.every((i) => validBacklogItem(i) !== null)).toBe(true);
    const limited = await reviewBlocksBacklogItems({ homeDir: home, now: new Date(NOW_MS), limit: 1 });
    expect(limited).toHaveLength(1);
    expect(REVIEW_BLOCKS_BACKLOG_MAX_ITEMS).toBeGreaterThanOrEqual(2);
  });

  it('states recorded floors when lines were dropped or the tail truncated', async () => {
    await journal([
      ...RECURRING.map((e) => JSON.stringify(e)),
      'not json at all',
      JSON.stringify(entry('acme/widgets', 'task-99', daysAgo(1), { kind: 'job' })),
    ]);
    const items = await reviewBlocksBacklogItems({ homeDir: home, now: new Date(NOW_MS) });
    expect(items).toHaveLength(1);
    expect(items[0]!.prompt).toContain('4 review-block row(s)');
    expect(items[0]!.prompt).toContain('2 malformed or off-contract lines dropped');
  });

  it('quotes recorded floors when the bounded tail truncated the journal', async () => {
    // One oversized invalid line pushes the file past the 8 MiB tail
    // bound; the cut prefix drops silently and every surviving count is
    // a lower bound the prompt must state.
    const dir = join(home, '.ashlr', 'learn', 'retro-input');
    await mkdir(dir, { recursive: true });
    const rows = RECURRING.map((e) => JSON.stringify(e)).join('\n');
    await writeFile(join(dir, 'review-blocks.jsonl'), `${'x'.repeat(8_400_000)}\n${rows}\n`);
    const items = await reviewBlocksBacklogItems({ homeDir: home, now: new Date(NOW_MS) });
    expect(items).toHaveLength(1);
    expect(items[0]!.prompt).toContain('at least 4 review-block row(s)');
    expect(items[0]!.prompt).toContain('lower bound');
    expect(items[0]!.title).toContain('at least');
  });

  it('derives stable ids per repo so a refresh re-adds nothing', async () => {
    await journal(RECURRING.map((e) => JSON.stringify(e)));
    const opts = { homeDir: home, now: new Date(NOW_MS) };
    const first = await reviewBlocksBacklogItems(opts);
    const second = await reviewBlocksBacklogItems(opts);
    expect(first.map((i) => i.id)).toEqual(second.map((i) => i.id));
    expect(first).toHaveLength(1);
  });

  it('appends review-block items through discovery and dedupes on refresh', async () => {
    // discoverBacklog anchors its feeds on the wall clock, so this
    // journal's rows stamp relative to the real now — three distinct
    // UTC days inside the 7-day window.
    const realDaysAgo = (days: number): string => new Date(Date.now() - days * DAY).toISOString();
    const live = [
      entry('acme/widgets', 'task-51', realDaysAgo(1)),
      entry('acme/widgets', 'task-52', realDaysAgo(2)),
      entry('acme/widgets', 'task-53', realDaysAgo(3)),
    ];
    const dir = join(home, '.ashlr', 'learn', 'retro-input');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'review-blocks.jsonl'), live.map((e) => JSON.stringify(e)).join('\n') + '\n');
    const greenGh = async (args: string[]) => {
      const p = args[4] ?? '';
      if (p === 'repos/ashlrai/phantom') return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n{"default_branch":"master"}', stderr: '' };
      return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n[]', stderr: '' };
    };
    const first = await discoverBacklog('ashlrai/phantom', { gh: greenGh });
    const rbItems = first.items.filter((i) => i.id.startsWith('review-block-'));
    expect(rbItems).toHaveLength(1);
    expect(rbItems[0]!.repo).toBe('acme/widgets');
    expect(first.items.every((i) => validBacklogItem(i) !== null)).toBe(true);
    expect(appendUserBacklogItems(rbItems)).toBe(1);
    const second = await discoverBacklog('ashlrai/phantom', { gh: greenGh });
    expect(appendUserBacklogItems(second.items.filter((i) => i.id.startsWith('review-block-')))).toBe(0);
    expect(readUserBacklogItems().filter((i) => i.id.startsWith('review-block-'))).toHaveLength(1);
  });
});
