import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DISCOVERY_ERRORS_BACKLOG_MAX_ITEMS,
  DISCOVERY_ERRORS_MIN_DAYS,
  DISCOVERY_ERRORS_MIN_PASSES,
  DISCOVERY_ERRORS_WINDOW_HOURS,
  discoveryErrorsBacklogItems,
  discoveryErrorsCells,
  foldDiscoveryErrors,
} from '../src/core/improve/discovery-errors-backlog.js';
import {
  appendDiscoveryPass,
  discoveryPassJournalPath,
} from '../src/core/improve/discovery-pass-journal.js';
import { autoDiscover, resetAutoDiscoverForTests } from '../src/core/improve/discover.js';
import { updateCloudBudget } from '../src/core/cloud/store.js';
import { appendUserBacklogItems, readUserBacklogItems, validBacklogItem } from '../src/core/cloud/backlog.js';
import type { DiscoveryPassRow } from '../src/core/improve/discovery-errors-backlog.js';

const HOUR = 3_600_000;
const DAY = 86_400_000;

/** Fixed reference instant; fixture timestamps are ISO-8601 UTC like the writer's. */
const NOW_MS = Date.parse('2026-11-23T12:00:00.000Z');
const WINDOW_MS = DISCOVERY_ERRORS_WINDOW_HOURS * HOUR;
const iso = (ms: number): string => new Date(ms).toISOString();

let runsDir = '';
let journalPath = '';

beforeEach(async () => {
  runsDir = await mkdtemp(join(tmpdir(), 'phm-disc-err-'));
  journalPath = discoveryPassJournalPath(runsDir);
});

afterEach(async () => {
  await rm(runsDir, { recursive: true, force: true });
});

/** One pass row in the writer's {v:1, at, added, errors[]} shape, as a fold input. */
function passRow(spec: { atMs?: number; added?: number | null; errors?: string[] } = {}): DiscoveryPassRow {
  return {
    atMs: spec.atMs ?? NOW_MS,
    added: spec.added === undefined ? 0 : spec.added,
    errors: spec.errors ?? [],
  };
}

/** `count` passes carrying `source`'s error, spread across `days` UTC days. */
function errorSeries(source: string, opts: { passes?: number; days?: number; atMs?: number; message?: string } = {}): DiscoveryPassRow[] {
  const passes = opts.passes ?? DISCOVERY_ERRORS_MIN_PASSES;
  const days = opts.days ?? DISCOVERY_ERRORS_MIN_DAYS;
  const base = opts.atMs ?? NOW_MS;
  const message = opts.message ?? 'read failed';
  const rows: DiscoveryPassRow[] = [];
  for (let i = 0; i < passes; i++) {
    rows.push(passRow({
      atMs: base - (i % days) * DAY - i * HOUR,
      added: i,
      errors: [`${source}: ${message} (attempt ${i})`],
    }));
  }
  return rows;
}

async function writeJournal(rows: readonly unknown[]): Promise<void> {
  await mkdir(dirname(journalPath), { recursive: true });
  await writeFile(journalPath, rows.map((r) => `${JSON.stringify(r)}\n`).join(''), 'utf8');
}

async function journalRow(spec: { at?: string; added?: number | null; errors?: string[] }): Promise<Record<string, unknown>> {
  return { v: 1, at: spec.at ?? iso(NOW_MS), added: spec.added === undefined ? 0 : spec.added, errors: spec.errors ?? [] };
}

describe('foldDiscoveryErrors', () => {
  it('folds pass rows per recorded source inside the window', () => {
    const rows = [
      ...errorSeries('fleetLearningBacklogItems', { passes: 3, days: 2 }),
      passRow({ atMs: NOW_MS - HOUR, errors: ['issues: gh api failed'] }),
      passRow({ atMs: NOW_MS - 2 * HOUR, errors: [] }),
      // Out of window — normal aging counts nowhere.
      passRow({ atMs: NOW_MS - WINDOW_MS - DAY, errors: ['fleetLearningBacklogItems: old'] }),
    ];
    const fold = foldDiscoveryErrors(rows, NOW_MS, WINDOW_MS);
    expect(fold.passes).toBe(5);
    expect(fold.passesWithErrors).toBe(4);
    expect(fold.outOfWindow).toBe(1);
    const cell = discoveryErrorsCells(fold).find((c) => c.source === 'fleetLearningBacklogItems');
    expect(cell).toBeDefined();
    expect(cell!.passes).toBe(3);
    expect(cell!.occurrences).toBe(3);
    expect(cell!.days).toBe(2);
    expect(cell!.examples[0]).toContain('fleetLearningBacklogItems:');
  });

  it('keys a source by the prefix before the first colon-space, or the bounded head', () => {
    const fold = foldDiscoveryErrors([
      passRow({ errors: ['default branch checks: gh api 502', 'issues: rate limited'] }),
      passRow({ errors: ['Could not read the hot-patch log.'] }),
    ], NOW_MS, WINDOW_MS);
    expect([...fold.sources.keys()].sort()).toEqual([
      'Could not read the hot-patch log.',
      'default branch checks',
      'issues',
    ]);
  });
});

describe('discoveryErrorsCells', () => {
  it('requires the recurring bars: passes across distinct UTC days', () => {
    const oneDay = foldDiscoveryErrors(errorSeries('tickHealthBacklogItems', { passes: 5, days: 1 }), NOW_MS, WINDOW_MS);
    expect(discoveryErrorsCells(oneDay)).toEqual([]);
    const twoPasses = foldDiscoveryErrors(errorSeries('tickHealthBacklogItems', { passes: DISCOVERY_ERRORS_MIN_PASSES - 1, days: 3 }), NOW_MS, WINDOW_MS);
    expect(discoveryErrorsCells(twoPasses)).toEqual([]);
    const recurring = foldDiscoveryErrors(errorSeries('tickHealthBacklogItems', { passes: DISCOVERY_ERRORS_MIN_PASSES, days: DISCOVERY_ERRORS_MIN_DAYS }), NOW_MS, WINDOW_MS);
    expect(discoveryErrorsCells(recurring)).toHaveLength(1);
  });
});

describe('appendDiscoveryPass + discoveryErrorsBacklogItems', () => {
  it('round-trips: appended pass rows fold into items for the fleet repo only', async () => {
    for (let i = 0; i < DISCOVERY_ERRORS_MIN_PASSES; i++) {
      appendDiscoveryPass([`memoryBacklogItems: journal corrupt (day ${i % 2})`], i, new Date(NOW_MS - i * DAY), runsDir);
    }
    appendDiscoveryPass([], 4, new Date(NOW_MS - HOUR), runsDir);
    const items = await discoveryErrorsBacklogItems({ repo: 'ashlrai/phantom', runsDir, now: new Date(NOW_MS) });
    expect(items).toHaveLength(1);
    const item = items[0]!;
    expect(item.id).toMatch(/^improve-discovery-[0-9a-f]{16}$/);
    expect(item.title).toContain('memoryBacklogItems');
    expect(item.area).toBe('improve-discovery');
    expect(item.priority).toBe(3);
    expect(item.repo).toBe('ashlrai/phantom');
    expect(validBacklogItem(item)).not.toBeNull();
    expect(item.prompt).toContain('memoryBacklogItems');
    expect(item.prompt).toContain('metrics/improve-discovery.jsonl');
    // A non-fleet repo inherits nothing.
    expect(await discoveryErrorsBacklogItems({ repo: 'ashlrai/other', runsDir, now: new Date(NOW_MS) })).toEqual([]);
    expect(await discoveryErrorsBacklogItems({ repo: 'phantom', runsDir, now: new Date(NOW_MS) })).toHaveLength(1);
  });

  it('a missing journal is a clean empty source', async () => {
    expect(await discoveryErrorsBacklogItems({ repo: 'ashlrai/phantom', runsDir, now: new Date(NOW_MS) })).toEqual([]);
  });

  it('an unreadable journal emits the degraded-source item alone', async () => {
    await mkdir(journalPath, { recursive: true }); // a directory where the file should be → not-file
    const items = await discoveryErrorsBacklogItems({ repo: 'ashlrai/phantom', runsDir, now: new Date(NOW_MS) });
    expect(items).toHaveLength(1);
    expect(items[0]!.title).toContain('unreadable');
    expect(items[0]!.prompt).toContain('not-file');
  });

  it('malformed rows are skipped and counted, never folded', async () => {
    await writeJournal([
      await journalRow({ errors: ['aBacklogItems: real'] }),
      { v: 2, at: iso(NOW_MS), added: 0, errors: [] },
      { v: 1, at: 'not-a-date', added: 0, errors: [] },
      'not json at all',
      await journalRow({ errors: ['aBacklogItems: real2'] }),
      await journalRow({ at: iso(NOW_MS - DAY), errors: ['aBacklogItems: real3'] }),
    ]);
    const items = await discoveryErrorsBacklogItems({ repo: 'ashlrai/phantom', runsDir, now: new Date(NOW_MS) });
    // Only 3 valid in-window passes carry the source — exactly the bar.
    expect(items).toHaveLength(1);
    expect(items[0]!.prompt).toContain('3 malformed row(s) skipped');
  });

  it('errors below the recurring bars emit nothing', async () => {
    await writeJournal([
      await journalRow({ errors: ['oneOffBacklogItems: transient'] }),
      await journalRow({ at: iso(NOW_MS - DAY), errors: ['oneOffBacklogItems: transient'] }),
    ]);
    expect(await discoveryErrorsBacklogItems({ repo: 'ashlrai/phantom', runsDir, now: new Date(NOW_MS) })).toEqual([]);
  });

  it('item ids are stable per source across refreshes and dedupe downstream', async () => {
    for (let i = 0; i < DISCOVERY_ERRORS_MIN_PASSES; i++) {
      appendDiscoveryPass(['stableFeedBacklogItems: boom'], 0, new Date(NOW_MS - i * DAY), runsDir);
    }
    const first = await discoveryErrorsBacklogItems({ repo: 'ashlrai/phantom', runsDir, now: new Date(NOW_MS) });
    const second = await discoveryErrorsBacklogItems({ repo: 'ashlrai/phantom', runsDir, now: new Date(NOW_MS + HOUR) });
    expect(first[0]!.id).toBe(second[0]!.id);
    appendUserBacklogItems(first, new Date(NOW_MS));
    appendUserBacklogItems(second, new Date(NOW_MS + HOUR));
    expect(readUserBacklogItems().filter((i) => i.id === first[0]!.id)).toHaveLength(1);
  });

  it('limit caps emitted items', async () => {
    const rows: Record<string, unknown>[] = [];
    for (let s = 0; s < 10; s++) {
      for (let i = 0; i < DISCOVERY_ERRORS_MIN_PASSES; i++) {
        rows.push(await journalRow({ at: iso(NOW_MS - i * DAY), errors: [`feed${s}BacklogItems: err`] }));
      }
    }
    await writeJournal(rows);
    const items = await discoveryErrorsBacklogItems({ repo: 'ashlrai/phantom', runsDir, now: new Date(NOW_MS), limit: 3 });
    expect(items).toHaveLength(3);
    expect(items.length).toBeLessThanOrEqual(DISCOVERY_ERRORS_BACKLOG_MAX_ITEMS);
  });
});

describe('autoDiscover journals the pass', () => {
  let savedRunsDir: string | undefined;
  beforeEach(() => {
    savedRunsDir = process.env['ASHLR_RUNS_DIR'];
    process.env['ASHLR_RUNS_DIR'] = runsDir;
    resetAutoDiscoverForTests();
  });
  afterEach(() => {
    if (savedRunsDir === undefined) delete process.env['ASHLR_RUNS_DIR'];
    else process.env['ASHLR_RUNS_DIR'] = savedRunsDir;
  });

  it('appends one row per ran pass carrying added and errors; a not-due pass writes nothing', async () => {
    updateCloudBudget({ selfImprove: { enabled: true, repo: 'ashlrai/phantom' } });
    const ghFail = async () => ({ ok: false, stdout: '', stderr: 'HTTP 403' });
    const res = await autoDiscover({ gh: ghFail, proposals: [], now: () => new Date(NOW_MS), hasNext: () => false });
    expect(res.ran).toBe(true);
    expect(res.errors.length).toBeGreaterThan(0);
    const rows = (await import('node:fs/promises').then((fs) => fs.readFile(journalPath, 'utf8')))
      .trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(rows).toHaveLength(1);
    expect(rows[0]!['v']).toBe(1);
    expect(rows[0]!['errors']).toEqual(res.errors);
    expect(rows[0]!['added']).toBe(res.added);
    expect(typeof rows[0]!['at']).toBe('string');
    // Inside the due interval the scheduler does not run discovery — no second row.
    const again = await autoDiscover({ gh: ghFail, proposals: [], now: () => new Date(NOW_MS + 1000), hasNext: () => true });
    expect(again.ran).toBe(false);
    const after = (await import('node:fs/promises').then((fs) => fs.readFile(journalPath, 'utf8'))).trim().split('\n');
    expect(after).toHaveLength(1);
  });
});
