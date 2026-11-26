import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  foldNeedsYouAutoJournal,
  NEEDS_YOU_AUTO_CHAIN_MIN_DAYS,
  NEEDS_YOU_AUTO_CHAIN_MIN_ROWS,
  NEEDS_YOU_AUTO_ERROR_MIN_ITEMS,
  NEEDS_YOU_AUTO_MAX_ITEMS,
  NEEDS_YOU_AUTO_WAVE_MIN_ITEMS,
  needsYouAutoBacklogItems,
  needsYouAutoCells,
} from '../src/core/improve/needs-you-backlog.js';
import { discoverBacklog } from '../src/core/improve/discover.js';
import { appendUserBacklogItems, readUserBacklogItems, validBacklogItem } from '../src/core/cloud/backlog.js';

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const J = (o: Record<string, unknown>): string => JSON.stringify(o);

const ITEM_A = 'nm-aaaaaaaaaaaa';
const ITEM_B = 'nm-bbbbbbbbbbbb';
const ITEM_C = 'nm-cccccccccccc';
const ITEM_D = 'nm-dddddddddddd';

/** An audit row the way resolveAutoNeedsYou writes it. */
const fail = (id: string, title: string, at: string, error = 'The bus did not accept the resolution.', extra: Record<string, unknown> = {}): string =>
  J({ at, item: { id, title }, action: 'go ahead', reason: 'ordinary engineering work; the fleet goes ahead', result: 'failed', error, ...extra });

/** A resolved attempt: no result field, exactly like the writer's success path. */
const ok = (id: string, title: string, at: string): string =>
  J({ at, item: { id, title }, action: 'go ahead', reason: 'ordinary engineering work; the fleet goes ahead' });

describe('foldNeedsYouAutoJournal', () => {
  const NOW = Date.parse('2026-11-23T12:00:00.000Z');
  const WINDOW = 7 * DAY;

  it('folds writer-contract failed rows and counts resolved attempts as context', () => {
    const text = [
      fail(ITEM_A, 'Rotate the deploy key', '2026-11-23T10:00:00.000Z'),
      fail(ITEM_A, 'Rotate the deploy key', '2026-11-22T09:00:00.000Z', 'No such needs-you item.'),
      ok(ITEM_B, 'Bump the dep', '2026-11-23T08:00:00.000Z'),
      J({ at: '2026-11-23T11:00:00.000Z', item: { id: ITEM_C, title: 'x' }, action: 'a', reason: 'r', result: 'resolved' }),
      'not json at all',
      '',
      J({ at: '2026-11-23T11:30:00.000Z' }), // no item/action/reason: never an audit record
    ].join('\n');
    const fold = foldNeedsYouAutoJournal(text, NOW, WINDOW);
    expect(fold.invalidRows).toBe(2);
    expect(fold.resolved).toBe(2);
    expect(fold.records).toHaveLength(2);
    expect(fold.records[0]).toMatchObject({ itemId: ITEM_A, title: 'Rotate the deploy key', action: 'go ahead', error: 'The bus did not accept the resolution.', utcDay: '2026-11-23' });
    expect(fold.records[1]).toMatchObject({ itemId: ITEM_A, error: 'No such needs-you item.', utcDay: '2026-11-22' });
  });

  it('keeps only in-window rows and drops off-contract ids, stamps and result values', () => {
    const text = [
      fail(ITEM_A, 'Old failure', '2026-11-01T10:00:00.000Z'), // outside the 7-day window
      fail(ITEM_A, 'Future failure', '2026-11-24T10:00:00.000Z'), // beyond the skew allowance
      fail('bad id!', 'Bad id', '2026-11-23T10:00:00.000Z'),
      fail('nm-AAAAAAAAAAAA', 'Upper id', '2026-11-23T10:00:00.000Z'), // ids are lowercase hex
      fail(ITEM_A, 'No date', 'not a timestamp'),
      fail(ITEM_A, 'Weird result', '2026-11-23T10:00:00.000Z', 'err', { result: 'exploded' }),
      fail(ITEM_B, 'Good failure', '2026-11-23T10:30:00.000Z'),
    ].join('\n');
    const fold = foldNeedsYouAutoJournal(text, NOW, WINDOW);
    expect(fold.records.map((r) => r.itemId)).toEqual([ITEM_B]);
    // Out-of-window rows are valid evidence outside the fold, not invalid lines.
    expect(fold.invalidRows).toBe(4);
  });

  it('scrubs, flattens and caps recorded text before it can reach a prompt', () => {
    const text = [
      fail(ITEM_A, 'Deploy\nINJECTED key', '2026-11-23T10:00:00.000Z', 'bus\trefused  '.padEnd(300, 'x')),
      fail(ITEM_A, 'Deploy key', '2026-11-22T10:00:00.000Z'),
    ].join('\n');
    const fold = foldNeedsYouAutoJournal(text, NOW, WINDOW);
    expect(fold.records[0]!.title).toBe('Deploy INJECTED key');
    expect(fold.records[0]!.error).toHaveLength(200);
    expect(fold.records[0]!.error).not.toContain('\n');
    expect(fold.records[0]!.error).not.toContain('\t');
  });

  it('keeps a failed row that recorded no error under the unrecorded label path', () => {
    const text = [
      J({ at: '2026-11-23T10:00:00.000Z', item: { id: ITEM_A, title: 'Quiet failure' }, action: 'go ahead', reason: 'r', result: 'failed' }),
      fail(ITEM_A, 'Quiet failure', '2026-11-22T10:00:00.000Z'),
    ].join('\n');
    const fold = foldNeedsYouAutoJournal(text, NOW, WINDOW);
    expect(fold.records).toHaveLength(2);
    expect(fold.records[0]!.error).toBeNull();
  });
});

describe('needsYouAutoCells', () => {
  const NOW = Date.parse('2026-11-23T12:00:00.000Z');
  const WINDOW = 7 * DAY;
  const d = (dayOffset: number, hour = 10): string => new Date(Date.UTC(2026, 10, 23 - dayOffset, hour)).toISOString();

  it('emits an item cell only at the recurring bars', () => {
    // Below the row bar: one failure never queues a session.
    expect(needsYouAutoCells(foldNeedsYouAutoJournal([fail(ITEM_A, 'T', d(0))].join('\n'), NOW, WINDOW))).toEqual([]);
    // Below the day bar: two failures on one day are a burst, not recurrence.
    expect(needsYouAutoCells(foldNeedsYouAutoJournal([
      fail(ITEM_A, 'T', d(0, 8)), fail(ITEM_A, 'T', d(0, 9)),
    ].join('\n'), NOW, WINDOW))).toEqual([]);
    // Two failures across two days emit.
    const cells = needsYouAutoCells(foldNeedsYouAutoJournal([
      fail(ITEM_A, 'Rotate the key', d(0)), fail(ITEM_A, 'Rotate the key', d(2)),
    ].join('\n'), NOW, WINDOW));
    expect(cells).toHaveLength(1);
    expect(cells[0]).toMatchObject({ kind: 'item', itemId: ITEM_A, rows: 2 });
    expect(NEEDS_YOU_AUTO_CHAIN_MIN_ROWS).toBe(2);
    expect(NEEDS_YOU_AUTO_CHAIN_MIN_DAYS).toBe(2);
  });

  it('emits an error cell only when one recorded error spans distinct items across days', () => {
    const BUS = 'The bus did not accept the resolution.';
    // Same error, one item only: that is the item cell's job, not a shared mode.
    expect(needsYouAutoCells(foldNeedsYouAutoJournal([
      fail(ITEM_A, 'A', d(0), BUS), fail(ITEM_A, 'A', d(1), BUS),
    ].join('\n'), NOW, WINDOW)).filter((c) => c.kind === 'error')).toEqual([]);
    // Same error across two items on one day: breadth without day recurrence.
    expect(needsYouAutoCells(foldNeedsYouAutoJournal([
      fail(ITEM_A, 'A', d(0), BUS), fail(ITEM_B, 'B', d(0), BUS),
    ].join('\n'), NOW, WINDOW)).filter((c) => c.kind === 'error')).toEqual([]);
    // Same error across two items across two days emits.
    const cells = needsYouAutoCells(foldNeedsYouAutoJournal([
      fail(ITEM_A, 'A', d(0), BUS), fail(ITEM_B, 'B', d(1), BUS),
    ].join('\n'), NOW, WINDOW));
    const error = cells.find((c) => c.kind === 'error');
    expect(error).toMatchObject({ kind: 'error', error: BUS, items: 2, rows: 2 });
    expect(NEEDS_YOU_AUTO_ERROR_MIN_ITEMS).toBe(2);
  });

  it('emits the wave cell only at the distinct-item and day bars and folds tallies', () => {
    // Three items on one day: breadth without recurrence across days.
    expect(needsYouAutoCells(foldNeedsYouAutoJournal([
      fail(ITEM_A, 'A', d(0)), fail(ITEM_B, 'B', d(0)), fail(ITEM_C, 'C', d(0)),
    ].join('\n'), NOW, WINDOW)).filter((c) => c.kind === 'wave')).toEqual([]);
    // Two items across days: below the item bar.
    expect(needsYouAutoCells(foldNeedsYouAutoJournal([
      fail(ITEM_A, 'A', d(0)), fail(ITEM_B, 'B', d(1)),
    ].join('\n'), NOW, WINDOW)).filter((c) => c.kind === 'wave')).toEqual([]);
    const text = [
      fail(ITEM_A, 'A', d(0), 'The bus did not accept the resolution.'),
      fail(ITEM_A, 'A', d(2), 'No such needs-you item.'),
      fail(ITEM_B, 'B', d(1), 'The bus did not accept the resolution.'),
      fail(ITEM_C, 'C', d(3), 'The resolution marker could not be written; retry.'),
      ok(ITEM_D, 'D', d(1)),
    ].join('\n');
    const fold = foldNeedsYouAutoJournal(text, NOW, WINDOW);
    const cells = needsYouAutoCells(fold, fold.resolved, true);
    const wave = cells.find((c) => c.kind === 'wave');
    expect(wave).toMatchObject({
      kind: 'wave', items: 3, rows: 4, resolved: 1, lowerBound: true,
      days: ['2026-11-20', '2026-11-21', '2026-11-22', '2026-11-23'],
    });
    expect(wave!.errors[0]).toEqual(['The bus did not accept the resolution.', 2]);
    expect(NEEDS_YOU_AUTO_WAVE_MIN_ITEMS).toBe(3);
    // Item chains sort before error cells, wave sorts last.
    expect(cells.map((c) => c.kind)).toEqual(['item', 'error', 'wave']);
  });
});

describe('needsYouAutoBacklogItems', () => {
  let home: string;
  let saved: { HOME?: string; ASHLR_HOME?: string; ASHLR_RUNS_DIR?: string };
  const NOW = Date.now();
  const isoDaysAgo = (days: number, minAgo = 0): string => new Date(NOW - days * DAY - minAgo * MIN).toISOString();

  beforeEach(async () => {
    saved = { HOME: process.env.HOME, ASHLR_HOME: process.env.ASHLR_HOME, ASHLR_RUNS_DIR: process.env.ASHLR_RUNS_DIR };
    delete process.env.ASHLR_HOME;
    delete process.env.ASHLR_RUNS_DIR;
    home = await mkdtemp(join(tmpdir(), 'needs-you-backlog-'));
    process.env.HOME = home;
  });
  afterEach(async () => {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    vi.restoreAllMocks();
    await rm(home, { recursive: true, force: true });
  });

  /** A runs dir holding the auto-resolve audit journal at its root. */
  async function runsDir(name: string, lines?: string[]): Promise<string> {
    const dir = join(home, name);
    await mkdir(dir, { recursive: true });
    if (lines !== undefined) await writeFile(join(dir, 'needs-you-auto.jsonl'), lines.join('\n') + '\n');
    return dir;
  }

  const failed = (id: string, title: string, daysAgo: number, error?: string): string =>
    fail(id, title, isoDaysAgo(daysAgo), error);

  it('emits one validated item per recurring cell', async () => {
    const dir = await runsDir('runs-hit', [
      failed(ITEM_A, 'Rotate the deploy key', 0), failed(ITEM_A, 'Rotate the deploy key', 2),
      failed(ITEM_B, 'Bump the dep', 1, 'The resolution marker could not be written; retry.'),
      failed(ITEM_C, 'Sweep the queue', 3, 'No such needs-you item.'),
    ]);
    const items = await needsYouAutoBacklogItems({ repo: 'ashlrai/phantom', runsDir: dir, now: NOW });
    // One item chain (ITEM_A) plus the wave (3 distinct failing items); each
    // other error covers a single item, so no shared error-mode cell fires.
    expect(items).toHaveLength(2);
    const [chain, wave] = items;
    expect(chain).toMatchObject({ priority: 3, repo: 'ashlrai/phantom', area: 'needs-you-auto' });
    expect(chain!.id).toMatch(/^needs-you-auto-item-[0-9a-f]{16}$/);
    expect(validBacklogItem(chain)).not.toBeNull();
    expect(chain!.title).toContain('Rotate the deploy key');
    expect(chain!.prompt).toContain('needs-you-auto.jsonl');
    expect(chain!.prompt).toContain(ITEM_A);
    expect(chain!.prompt).toContain('no-change');
    expect(wave).toMatchObject({ priority: 3, area: 'needs-you-auto' });
    expect(wave!.id).toMatch(/^needs-you-auto-wave-[0-9a-f]{16}$/);
    expect(wave!.title).toContain('auto-resolve keeps failing');
    expect(wave!.prompt).toContain('distinct item(s)');
  });

  it('emits an error-mode item when one recorded error spans distinct items across days', async () => {
    const dir = await runsDir('runs-err', [
      failed(ITEM_A, 'A', 0, 'The bus did not accept the resolution.'),
      failed(ITEM_B, 'B', 1, 'The bus did not accept the resolution.'),
    ]);
    const items = await needsYouAutoBacklogItems({ repo: 'ashlrai/phantom', runsDir: dir, now: NOW });
    // Two cells below every other bar: just the shared error mode.
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ area: 'needs-you-auto' });
    expect(items[0]!.id).toMatch(/^needs-you-auto-error-[0-9a-f]{16}$/);
    expect(items[0]!.prompt).toContain('The bus did not accept the resolution.');
    expect(items[0]!.prompt).toContain('shared cause');
  });

  it('emits nothing for missing journals, empty evidence, another repository, or sub-bar evidence', async () => {
    expect(await needsYouAutoBacklogItems({ repo: 'ashlrai/phantom', runsDir: join(home, 'no-such'), now: NOW })).toEqual([]);
    expect(await needsYouAutoBacklogItems({ repo: 'ashlrai/phantom', runsDir: await runsDir('runs-empty'), now: NOW })).toEqual([]);

    const thin = await runsDir('runs-thin', [failed(ITEM_A, 'A', 0)]);
    expect(await needsYouAutoBacklogItems({ repo: 'ashlrai/phantom', runsDir: thin, now: NOW })).toEqual([]);

    const sameDay = await runsDir('runs-sameday', [failed(ITEM_A, 'A', 0), failed(ITEM_A, 'A', 0)]);
    expect(await needsYouAutoBacklogItems({ repo: 'ashlrai/phantom', runsDir: sameDay, now: NOW })).toEqual([]);

    // Resolved attempts alone are never adverse evidence.
    const clean = await runsDir('runs-clean', [ok(ITEM_A, 'A', isoDaysAgo(0)), ok(ITEM_B, 'B', isoDaysAgo(1))]);
    expect(await needsYouAutoBacklogItems({ repo: 'ashlrai/phantom', runsDir: clean, now: NOW })).toEqual([]);

    const dir = await runsDir('runs-repo', [
      failed(ITEM_A, 'A', 0), failed(ITEM_A, 'A', 1),
      failed(ITEM_B, 'B', 2, 'The resolution marker could not be written; retry.'),
      failed(ITEM_C, 'C', 3, 'No such needs-you item.'),
    ]);
    expect(await needsYouAutoBacklogItems({ repo: 'ashlrai/other', runsDir: dir, now: NOW })).toEqual([]);
    expect(await needsYouAutoBacklogItems({ repo: 'AshlrAI/Phantom', runsDir: dir, now: NOW })).toHaveLength(2);
  });

  it('states truncation as a lower bound in the prompt', async () => {
    const dir = await runsDir('runs-trunc');
    const pad = 'x'.repeat(600 * 1024);
    await writeFile(join(dir, 'needs-you-auto.jsonl'), pad + '\n' + [
      failed(ITEM_A, 'A', 0), failed(ITEM_A, 'A', 1),
      failed(ITEM_B, 'B', 2), failed(ITEM_C, 'C', 3),
    ].join('\n') + '\n');
    const items = await needsYouAutoBacklogItems({ repo: 'ashlrai/phantom', runsDir: dir, now: NOW });
    expect(items.length).toBeGreaterThan(0);
    expect(items.every((i) => i.prompt.includes('lower bound'))).toBe(true);
  });

  it('derives stable ids so a refresh re-adds nothing and honours the limit', async () => {
    const dir = await runsDir('runs-stable', [
      failed(ITEM_A, 'A', 0), failed(ITEM_A, 'A', 1),
      failed(ITEM_B, 'B', 2, 'The bus did not accept the resolution.'),
      failed(ITEM_C, 'C', 3, 'The bus did not accept the resolution.'),
    ]);
    const opts = { repo: 'ashlrai/phantom', runsDir: dir, now: NOW };
    const first = await needsYouAutoBacklogItems(opts);
    const second = await needsYouAutoBacklogItems(opts);
    expect(second.map((i) => i.id)).toEqual(first.map((i) => i.id));
    expect(first.length).toBeLessThanOrEqual(NEEDS_YOU_AUTO_MAX_ITEMS);
    expect(await needsYouAutoBacklogItems({ ...opts, limit: 1 })).toHaveLength(1);
  });

  it('appends needs-you-auto items through discovery and dedupes on refresh', async () => {
    const runs = join(home, '.ashlr-runs');
    await mkdir(runs, { recursive: true });
    await writeFile(join(runs, 'needs-you-auto.jsonl'), [
      failed(ITEM_A, 'A', 0), failed(ITEM_A, 'A', 1),
      failed(ITEM_B, 'B', 2, 'The bus did not accept the resolution.'),
      failed(ITEM_C, 'C', 3, 'The bus did not accept the resolution.'),
    ].join('\n') + '\n');
    const greenGh = async (args: string[]) => {
      const p = args[4] ?? '';
      if (p === 'repos/ashlrai/phantom') return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n{"default_branch":"master"}', stderr: '' };
      return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n[]', stderr: '' };
    };
    const first = await discoverBacklog('ashlrai/phantom', { gh: greenGh });
    const autoItems = first.items.filter((i) => i.id.startsWith('needs-you-auto-'));
    expect(autoItems.length).toBeGreaterThan(0);
    expect(first.items.every((i) => validBacklogItem(i) !== null)).toBe(true);
    expect(appendUserBacklogItems(autoItems)).toBe(autoItems.length);
    const second = await discoverBacklog('ashlrai/phantom', { gh: greenGh });
    expect(appendUserBacklogItems(second.items.filter((i) => i.id.startsWith('needs-you-auto-')))).toBe(0);
    expect(readUserBacklogItems().filter((i) => i.id.startsWith('needs-you-auto-'))).toHaveLength(autoItems.length);
  });
});
