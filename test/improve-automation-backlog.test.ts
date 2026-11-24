import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { KILL_REASON, NO_GRANT_REASON } from '../src/core/automations/lanes.js';
import {
  AUTOMATION_BACKLOG_MAX_ITEMS,
  AUTOMATION_MIN_UNITS,
  automationBacklogItems,
  foldAutomationCells,
  parseAutomationJournal,
  parseAutomationJournalEntry,
} from '../src/core/improve/automation-backlog.js';
import { discoverBacklog } from '../src/core/improve/discover.js';
import { appendUserBacklogItems, readUserBacklogItems, validBacklogItem } from '../src/core/cloud/backlog.js';

const NOW_MS = Date.parse('2026-12-01T12:00:00.000Z');
const DAY_MS = 24 * 60 * 60 * 1000;

let home: string;
let saved: Record<string, string | undefined>;
beforeEach(async () => {
  saved = { HOME: process.env.HOME, ASHLR_HOME: process.env.ASHLR_HOME };
  delete process.env.ASHLR_HOME;
  home = await mkdtemp(join(tmpdir(), 'improve-automation-'));
  process.env.HOME = home;
});
afterEach(async () => {
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  await rm(home, { recursive: true, force: true });
});

const row = (at: string, over: Record<string, unknown> = {}): string =>
  JSON.stringify({
    at,
    event: 'fired',
    automationId: 'au_nightly-flaky',
    firingId: 'af_20261128T080000_abc123',
    dedupeKey: 'ashlrai/phantom#42',
    repo: 'ashlrai/phantom',
    state: 'queued',
    lane: 'fleet',
    sourceUrl: null,
    laneRef: null,
    laneUrl: null,
    reason: 'Queued.',
    spendUsd: 0,
    ...over,
  });

const at = (day: string, hour = 8): string => `${day}T${String(hour).padStart(2, '0')}:00:00.000Z`;
const D1 = '2026-11-28';
const D2 = '2026-11-29';
const D3 = '2026-11-30';

/** Three rows across three UTC days with distinct dedupe keys — past both recurring bars for one cell. */
const recurring = (make: (day: string, n: number) => Record<string, unknown>): string[] =>
  [D1, D2, D3].map((day, i) => row(at(day), make(day, i)));

const refusedRow = (day: string, n: number): Record<string, unknown> => ({
  event: 'refused', state: 'refused', dedupeKey: `ashlrai/phantom#${100 + n}`, reason: 'The lane is off for this repo.', spendUsd: 0,
});
const failedRow = (day: string, n: number): Record<string, unknown> => ({
  event: 'settled', state: 'failed', dedupeKey: `ashlrai/phantom@${'a'.repeat(7)}${n}`, reason: "The lane's task ended without landing.", spendUsd: 1.5,
});
const droppedRow = (day: string, n: number): Record<string, unknown> => ({
  event: 'dropped', state: 'dropped', dedupeKey: `ci-red:ashlrai/phantom:${n}`, reason: "Dropped: this automation's queue is full (10 waiting).", spendUsd: 0,
});
const deferredRow = (day: string, n: number): Record<string, unknown> => ({
  event: 'deferred', state: 'queued', dedupeKey: `schedule:ashlrai/phantom:${n}`, reason: 'Waiting: the lane budget is exhausted.', spendUsd: 0,
});

const automationsDir = async (name: string, files: Record<string, string>): Promise<string> => {
  const dir = join(home, name);
  await mkdir(dir, { recursive: true });
  for (const [file, text] of Object.entries(files)) await writeFile(join(dir, file), text);
  return dir;
};

describe('parseAutomationJournalEntry / parseAutomationJournal', () => {
  it('accepts the writer contract and drops off-contract rows and entries honestly', () => {
    const parsed = parseAutomationJournalEntry(JSON.parse(row(at(D1), {
      event: 'settled',
      state: 'failed',
      reason: 'The lane\'s task ended without landing.',
      spendUsd: 2.5,
      sourceUrl: 'https://github.com/ashlrai/phantom/issues/9',
      laneRef: 'task-1',
      laneUrl: 'https://example.test/task-1',
    })));
    expect(parsed).not.toBeNull();
    expect(parsed!.event).toBe('settled');
    expect(parsed!.state).toBe('failed');
    expect(parsed!.utcDay).toBe(D1);
    expect(parsed!.dedupeKey).toBe('ashlrai/phantom#42');

    // Rows written with null back-links are still on-contract.
    expect(parseAutomationJournalEntry(JSON.parse(row(at(D1))))).not.toBeNull();

    // Whole-row contract violations reject the record.
    for (const bad of [
      null, 'x', [],
      { ...JSON.parse(row(at(D1))), at: 'not-a-date' },
      { ...JSON.parse(row(at(D1))), event: 'bogus' },
      { ...JSON.parse(row(at(D1))), automationId: 'nightly' },
      { ...JSON.parse(row(at(D1))), automationId: 'au_X' },
      { ...JSON.parse(row(at(D1))), firingId: 'firing-1' },
      { ...JSON.parse(row(at(D1))), dedupeKey: '' },
      { ...JSON.parse(row(at(D1))), dedupeKey: 'x'.repeat(201) },
      { ...JSON.parse(row(at(D1))), repo: 'phantom' },
      { ...JSON.parse(row(at(D1))), repo: 'https://github.com/ashlrai/phantom' },
      { ...JSON.parse(row(at(D1))), state: 'exploded' },
      { ...JSON.parse(row(at(D1))), lane: 'rocket' },
      { ...JSON.parse(row(at(D1))), reason: 42 },
      { ...JSON.parse(row(at(D1))), spendUsd: 'free' },
      { ...JSON.parse(row(at(D1))), spendUsd: null },
    ]) {
      expect(parseAutomationJournalEntry(bad)).toBeNull();
    }
  });

  it('counts malformed and off-contract lines without guessing', () => {
    const { rows: parsed, invalidRows } = parseAutomationJournal([
      'not json',
      '{"at":"2026-11-28T08:00:00.000Z"}',
      row(at(D1)),
      '',
      row(at(D2), { event: 'bogus' }),
    ].join('\n'));
    expect(parsed).toHaveLength(1);
    expect(invalidRows).toBe(3);
  });
});

describe('foldAutomationCells', () => {
  const rowsOf = (lines: readonly string[]) => parseAutomationJournal(lines.join('\n')).rows;

  it('folds each adverse kind at the recurring bars and ignores non-adverse rows', () => {
    const lines = [
      ...recurring(refusedRow),
      ...recurring(failedRow),
      ...recurring(droppedRow),
      ...recurring(deferredRow),
      // Non-adverse rows: valid records that never join a cell.
      ...recurring(() => ({ event: 'fired', state: 'queued', dedupeKey: 'ashlrai/phantom#7' })),
      ...recurring(() => ({ event: 'dispatched', state: 'dispatched', dedupeKey: 'ashlrai/phantom#8' })),
      ...recurring(() => ({ event: 'settled', state: 'succeeded', dedupeKey: 'ashlrai/phantom#9', reason: 'Done: the lane finished the task.' })),
      ...recurring(() => ({ event: 'reviewed', state: 'rejected', dedupeKey: 'ashlrai/phantom#10', reason: 'Rejected in Needs-you.' })),
      // Deliberate global holds: deferred rows on KILL and no-grant never count.
      ...recurring(() => ({ event: 'deferred', state: 'queued', dedupeKey: 'ashlrai/phantom#11', reason: `Waiting: ${KILL_REASON}` })),
      ...recurring(() => ({ event: 'deferred', state: 'queued', dedupeKey: 'ashlrai/phantom#12', reason: `Waiting: ${NO_GRANT_REASON}` })),
    ];
    const folded = foldAutomationCells(rowsOf(lines), { nowMs: NOW_MS, repo: 'ashlrai/phantom' });
    expect(folded.map((c) => `${c.automationId}:${c.kind}`).sort()).toEqual([
      'au_nightly-flaky:deferred',
      'au_nightly-flaky:dropped',
      'au_nightly-flaky:failed',
      'au_nightly-flaky:refused',
    ]);
    const failed = folded.find((c) => c.kind === 'failed')!;
    expect(failed.units).toBe(AUTOMATION_MIN_UNITS);
    expect(failed.days.size).toBe(3);
    expect(failed.rows).toBe(3);
    expect(failed.lanes).toEqual([{ text: 'fleet', count: 3 }]);
    expect(failed.reasons[0]!.text).toContain("task ended without landing");
    expect(failed.examples).toHaveLength(3);
  });

  it('keeps sub-bar cells visible to the fold while the items layer applies the recurring bars', () => {
    // Three distinct events on ONE UTC day: a real cell, but under the days bar.
    const oneDay = foldAutomationCells(rowsOf([
      row(at('2026-11-30'), failedRow('2026-11-30', 0)),
      row(at('2026-11-30', 9), failedRow('2026-11-30', 1)),
      row(at('2026-11-30', 18), failedRow('2026-11-30', 2)),
    ]), { nowMs: NOW_MS, repo: 'ashlrai/phantom' });
    expect(oneDay).toHaveLength(1);
    expect(oneDay[0]!.units).toBe(3);
    expect(oneDay[0]!.days.size).toBe(1);

    // One dedupe key across many rows: a single stuck firing folds to one unit.
    const stuck = foldAutomationCells(rowsOf(
      Array.from({ length: 30 }, (_, i) => row(at(D1, i % 24), {
        event: 'deferred', state: 'queued', dedupeKey: 'schedule:ashlrai/phantom:stuck', reason: 'Waiting: the lane budget is exhausted.',
      })),
    ), { nowMs: NOW_MS, repo: 'ashlrai/phantom' });
    expect(stuck).toHaveLength(1);
    expect(stuck[0]!.units).toBe(1);
    expect(stuck[0]!.rows).toBe(30);

    // Rows outside the 7-day window never count.
    const ancient = foldAutomationCells(rowsOf([
      row(at('2026-11-01'), failedRow('2026-11-01', 0)),
      row(at('2026-11-02'), failedRow('2026-11-02', 1)),
      row(at('2026-11-03'), failedRow('2026-11-03', 2)),
    ]), { nowMs: NOW_MS, repo: 'ashlrai/phantom' });
    expect(ancient).toEqual([]);

    // Another repository's firings never join this target's cells.
    const other = foldAutomationCells(rowsOf(recurring((d, n) => ({ ...failedRow(d, n), repo: 'ashlrai/other' }))),
      { nowMs: NOW_MS, repo: 'ashlrai/phantom' });
    expect(other).toEqual([]);
    // Case-insensitive owner/name still matches.
    const cased = foldAutomationCells(rowsOf(recurring((d, n) => ({ ...failedRow(d, n), repo: 'AshlrAI/Phantom' }))),
      { nowMs: NOW_MS, repo: 'ashlrai/phantom' });
    expect(cased.map((c) => c.kind)).toEqual(['failed']);
  });
});

describe('automationBacklogItems', () => {
  it('emits one item per recurring cell with stable ids, prompts and metadata', async () => {
    const lines = [
      ...recurring(refusedRow),
      ...recurring(failedRow),
      ...recurring(droppedRow),
      ...recurring(deferredRow),
      row(at(D1)),
    ];
    const dir = await automationsDir('au-all', { 'firings.jsonl': lines.join('\n') + '\n' });
    const items = await automationBacklogItems({ repo: 'ashlrai/phantom', automationsDir: dir, now: new Date(NOW_MS) });
    expect(items).toHaveLength(4);
    const kinds = items.map((i) => i.id.split('-')[1]).sort();
    expect(kinds).toEqual(['deferred', 'dropped', 'failed', 'refused']);
    for (const item of items) {
      expect(item.id).toMatch(/^automation-(refused|failed|dropped|deferred)-[0-9a-f]{16}$/);
      expect(item.priority).toBe(3);
      expect(item.area).toBe('automations');
      expect(item.repo).toBe('ashlrai/phantom');
      expect(validBacklogItem(item)).not.toBeNull();
      expect(item.prompt).toContain('au_nightly-flaky');
      expect(item.prompt).toContain('firings.jsonl');
      expect(item.prompt).toContain('no-change');
    }
    const failed = items.find((i) => i.id.startsWith('automation-failed-'))!;
    expect(failed.prompt).toContain("task ended without landing");
    const deferred = items.find((i) => i.id.startsWith('automation-deferred-'))!;
    expect(deferred.prompt).toContain('lane budget is exhausted');
    expect(deferred.prompt).toContain('KILL');
    const dropped = items.find((i) => i.id.startsWith('automation-dropped-'))!;
    expect(dropped.prompt).toContain('queue is full');
    // Deterministic cap respected.
    expect(items.length).toBeLessThanOrEqual(Math.min(AUTOMATION_BACKLOG_MAX_ITEMS, 25));
    const limited = await automationBacklogItems({ repo: 'ashlrai/phantom', automationsDir: dir, now: new Date(NOW_MS), limit: 2 });
    expect(limited).toHaveLength(2);
  });

  it('reads the rotated firings.1.jsonl generation alongside the live file', async () => {
    // Older adverse rows in the rotated file, newer ones live — one cell spans both.
    const dir = await automationsDir('au-rotated', {
      'firings.1.jsonl': [row(at(D1), failedRow(D1, 0)), row(at(D2), failedRow(D2, 1))].join('\n') + '\n',
      'firings.jsonl': [row(at(D3), failedRow(D3, 2))].join('\n') + '\n',
    });
    const items = await automationBacklogItems({ repo: 'ashlrai/phantom', automationsDir: dir, now: new Date(NOW_MS) });
    expect(items).toHaveLength(1);
    expect(items[0]!.id.startsWith('automation-failed-')).toBe(true);
    expect(items[0]!.prompt).toContain('3 distinct event(s)');
  });

  it('emits nothing below the bars, on missing or unreadable journals, or for another repository', async () => {
    // Below the units bar: two events across two days.
    const few = await automationsDir('au-few', { 'firings.jsonl': [row(at(D1), failedRow(D1, 0)), row(at(D2), failedRow(D2, 1))].join('\n') + '\n' });
    expect(await automationBacklogItems({ repo: 'ashlrai/phantom', automationsDir: few, now: new Date(NOW_MS) })).toEqual([]);

    // Below the days bar: three events on one UTC day.
    const oneDay = await automationsDir('au-oneday', {
      'firings.jsonl': [
        row(at('2026-11-30'), failedRow('2026-11-30', 0)),
        row(at('2026-11-30', 9), failedRow('2026-11-30', 1)),
        row(at('2026-11-30', 18), failedRow('2026-11-30', 2)),
      ].join('\n') + '\n',
    });
    expect(await automationBacklogItems({ repo: 'ashlrai/phantom', automationsDir: oneDay, now: new Date(NOW_MS) })).toEqual([]);

    // One dedupe key across many rows: a single stuck firing is not recurrence.
    const stuck = await automationsDir('au-stuck', {
      'firings.jsonl': Array.from({ length: 30 }, (_, i) => row(at(D1, i % 24), {
        event: 'deferred', state: 'queued', dedupeKey: 'schedule:ashlrai/phantom:stuck', reason: 'Waiting: the lane budget is exhausted.',
      })).join('\n') + '\n',
    });
    expect(await automationBacklogItems({ repo: 'ashlrai/phantom', automationsDir: stuck, now: new Date(NOW_MS) })).toEqual([]);

    // Missing dir and missing journal.
    const empty = await automationsDir('au-empty', {});
    expect(await automationBacklogItems({ repo: 'ashlrai/phantom', automationsDir: empty, now: new Date(NOW_MS) })).toEqual([]);
    expect(await automationBacklogItems({ repo: 'ashlrai/phantom', automationsDir: join(home, 'no-such'), now: new Date(NOW_MS) })).toEqual([]);

    // A directory where the journal should be is not a file.
    const dirAsFile = join(home, 'au-dirfile');
    await mkdir(join(dirAsFile, 'firings.jsonl'), { recursive: true });
    expect(await automationBacklogItems({ repo: 'ashlrai/phantom', automationsDir: dirAsFile, now: new Date(NOW_MS) })).toEqual([]);

    // Garbage lines are not evidence.
    const junk = await automationsDir('au-junk', { 'firings.jsonl': 'not json\n{"at":"x"}\n' });
    expect(await automationBacklogItems({ repo: 'ashlrai/phantom', automationsDir: junk, now: new Date(NOW_MS) })).toEqual([]);

    // Another repository never inherits this install's evidence.
    const dir = await automationsDir('au-repo', { 'firings.jsonl': recurring(failedRow).join('\n') + '\n' });
    expect(await automationBacklogItems({ repo: 'ashlrai/other', automationsDir: dir, now: new Date(NOW_MS) })).toEqual([]);
    expect(await automationBacklogItems({ repo: 'not-a-repo', automationsDir: dir, now: new Date(NOW_MS) })).toEqual([]);
  });

  it('states truncated tails as lower bounds and scrubs journal strings in prompts', async () => {
    // >4 MiB of retained rows: the bounded tail drops the oldest bytes.
    const filler: string[] = [];
    for (let i = 0; i < 4000; i += 1) {
      filler.push(row(at(D1, i % 24), {
        event: 'fired', state: 'queued', dedupeKey: `pad-${i}`, repo: 'ashlrai/other', reason: `pad-${'x'.repeat(900)}-${i}`,
      }));
    }
    const dir = await automationsDir('au-big', { 'firings.jsonl': [...filler, ...recurring(failedRow)].join('\n') + '\n' });
    const items = await automationBacklogItems({ repo: 'ashlrai/phantom', automationsDir: dir, now: new Date(NOW_MS) });
    expect(items.length).toBeGreaterThan(0);
    expect(items.some((i) => i.prompt.includes('lower bound'))).toBe(true);
  }, 30_000);

  it('scrubs secret-shaped text out of journal reasons before it reaches a prompt', async () => {
    const token = '123456789:AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHHJ';
    const dir = await automationsDir('au-secret', {
      'firings.jsonl': recurring((d, n) => ({
        event: 'settled', state: 'failed', dedupeKey: `ashlrai/phantom#${200 + n}`, reason: `fetch failed ${token}`,
      })).join('\n') + '\n',
    });
    const items = await automationBacklogItems({ repo: 'ashlrai/phantom', automationsDir: dir, now: new Date(NOW_MS) });
    expect(items).toHaveLength(1);
    expect(items[0]!.prompt).not.toContain(token);
    expect(items[0]!.prompt).toContain('[REDACTED]');
  });

  it('derives stable ids so a refresh re-adds nothing', async () => {
    const dir = await automationsDir('au-stable', { 'firings.jsonl': [...recurring(failedRow), ...recurring(droppedRow)].join('\n') + '\n' });
    const opts = { repo: 'ashlrai/phantom', automationsDir: dir, now: new Date(NOW_MS) };
    const first = await automationBacklogItems(opts);
    const second = await automationBacklogItems(opts);
    expect(second.map((i) => i.id)).toEqual(first.map((i) => i.id));
  });

  it('appends automation items through discovery and dedupes on refresh', async () => {
    // discoverBacklog anchors the evidence window on the wall clock, so
    // the fixtures use days relative to real now — three distinct UTC
    // days inside the window, like the fixed-date fixtures above.
    const dayAgo = (days: number): string => new Date(Date.now() - days * DAY_MS).toISOString().slice(0, 10);
    const recent = (make: (day: string, n: number) => Record<string, unknown>): string[] =>
      [1, 2, 3].map((d, i) => row(`${dayAgo(d)}T08:00:00.000Z`, make(`${dayAgo(d)}T08:00:00.000Z`, i)));
    const failedLines = recent((iso, n) => ({
      event: 'settled', state: 'failed', dedupeKey: `ashlrai/phantom#${300 + n}`, reason: "The lane's task ended without landing.",
    }));
    const dir = join(home, '.ashlr', 'automations');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'firings.jsonl'), failedLines.join('\n') + '\n');
    const greenGh = async (args: string[]) => {
      const p = args[4] ?? '';
      if (p === 'repos/ashlrai/phantom') return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n{"default_branch":"master"}', stderr: '' };
      return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n[]', stderr: '' };
    };
    const first = await discoverBacklog('ashlrai/phantom', { gh: greenGh });
    const automationItems = first.items.filter((i) => i.id.startsWith('automation-'));
    expect(automationItems).toHaveLength(1);
    expect(automationItems[0]!.id.startsWith('automation-failed-')).toBe(true);
    expect(first.items.every((i) => validBacklogItem(i) !== null)).toBe(true);
    expect(appendUserBacklogItems(automationItems)).toBe(1);
    const second = await discoverBacklog('ashlrai/phantom', { gh: greenGh });
    expect(appendUserBacklogItems(second.items.filter((i) => i.id.startsWith('automation-')))).toBe(0);
    expect(readUserBacklogItems().filter((i) => i.id.startsWith('automation-'))).toHaveLength(1);
  });
});
