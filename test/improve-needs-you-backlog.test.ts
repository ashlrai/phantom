import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { discoverBacklog } from '../src/core/improve/discover.js';
import {
  foldNeedsYouAutoCells,
  needsYouAutoBacklogItems,
  NEEDS_YOU_AUTO_BACKLOG_MAX_ITEMS,
  NEEDS_YOU_AUTO_MIN_DAYS,
  NEEDS_YOU_AUTO_MIN_UNITS,
  parseNeedsYouAutoEntry,
  parseNeedsYouAutoText,
  type NeedsYouAutoRow,
} from '../src/core/improve/needs-you-backlog.js';
import { appendUserBacklogItems, readUserBacklogItems, validBacklogItem } from '../src/core/cloud/backlog.js';

let home: string;
let saved: { HOME?: string; ASHLR_HOME?: string; ASHLR_RUNS_DIR?: string };
beforeEach(() => {
  saved = { HOME: process.env.HOME, ASHLR_HOME: process.env.ASHLR_HOME, ASHLR_RUNS_DIR: process.env.ASHLR_RUNS_DIR };
  delete process.env.ASHLR_HOME;
  delete process.env.ASHLR_RUNS_DIR;
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'improve-needs-you-')));
  process.env.HOME = home;
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  fs.rmSync(home, { recursive: true, force: true });
});

const NOW = new Date('2026-11-25T12:00:00Z');
const NOW_MS = NOW.getTime();
/** ISO timestamp `days` before NOW (fractional hours allowed via `hours`). */
const at = (days: number, hours = 0): string =>
  new Date(NOW_MS - days * 86400_000 + hours * 3600_000).toISOString();

const REPO = 'ashlrai/phantom';
const AUTO_REASON = 'ordinary engineering work; the fleet goes ahead';

interface AuditRow {
  item?: { id?: string; title?: string };
  action?: string;
  at?: string;
  reason?: string;
  result?: string;
  error?: string;
}

/** One needs-you-auto.jsonl record under the writer's contract. */
const audit = (over: AuditRow = {}): AuditRow => ({
  item: { id: 'nm-aaaaaaaaaaaa', title: 'Retry the flaky deploy check' },
  action: 'go ahead',
  at: at(1),
  reason: AUTO_REASON,
  ...over,
});

/** A failed-attempt record: the writer's failure shape with a bounded scrubbed error. */
const failed = (over: AuditRow = {}): AuditRow => audit({ result: 'failed', error: 'The bus did not accept the resolution.', ...over });

const journal = (rows: Array<AuditRow | string>): string =>
  rows.map((r) => (typeof r === 'string' ? r : JSON.stringify(r))).join('\n') + '\n';

const writeJournal = (rows: Array<AuditRow | string> | string, name = 'needs-you-auto.jsonl'): string => {
  const dir = path.join(home, '.ashlr-runs');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  fs.writeFileSync(file, typeof rows === 'string' ? rows : journal(rows));
  return file;
};

const failRow = (error: string, daysAgo: number, itemId = 'nm-aaaaaaaaaaaa', title = 'Retry the flaky deploy check'): AuditRow =>
  failed({ error, at: at(daysAgo), item: { id: itemId, title } });

describe('parseNeedsYouAutoEntry / parseNeedsYouAutoText', () => {
  it('keeps contract records and skips malformed or off-contract lines', () => {
    const { rows, invalidRows } = parseNeedsYouAutoText(journal([
      'not json',
      '{"item":{"id":"nm-1","title":"x"},"action":"go ahead","at":"bad","reason":"r"}',
      '{"item":{"id":"nm-1"},"action":"go ahead","at":"2026-11-24T00:00:00Z","reason":"r"}', // title not a string
      '{"item":{"id":"nm-1","title":"x"},"action":"go ahead","at":"2026-11-24T00:00:00Z","reason":"r","result":"bogus"}',
      audit({ at: at(1) }),
      failed({ at: at(2) }),
      '{"item":{"id":"nm-2","title":"y"},"action":"go ahead","at":"2026-11-23T00:00:00Z","reason":"r","result":"failed","error":"boom","extra":"tolerated"}',
    ]));
    expect(invalidRows).toBe(4);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({ result: 'resolved', itemId: 'nm-aaaaaaaaaaaa' });
    expect(rows[1]).toMatchObject({ result: 'failed', error: 'The bus did not accept the resolution.' });
    expect(rows[2]).toMatchObject({ result: 'failed', error: 'boom' });
  });

  it('parseNeedsYouAutoEntry returns null for non-object and off-contract values', () => {
    expect(parseNeedsYouAutoEntry(null)).toBeNull();
    expect(parseNeedsYouAutoEntry('x')).toBeNull();
    expect(parseNeedsYouAutoEntry({ item: { id: 'nm-1', title: 'x' }, action: 'a', at: 'bad', reason: 'r' })).toBeNull();
    expect(parseNeedsYouAutoEntry(audit())).toMatchObject({ result: 'resolved' });
    // Legacy resolved rows carry no result field at all — audit() already omits it.
    expect(parseNeedsYouAutoEntry({ item: { id: 'nm-9', title: 'x' }, action: 'go ahead', at: '2026-11-24T00:00:00Z', reason: 'r' })).toMatchObject({ result: 'resolved' });
  });
});

describe('foldNeedsYouAutoCells', () => {
  const cellRow = (result: 'resolved' | 'failed', error: string, daysAgo: number, hours = 0, itemId = 'nm-1'): NeedsYouAutoRow => ({
    atMs: NOW_MS - daysAgo * 86400_000 + hours * 3600_000,
    utcDay: new Date(NOW_MS - daysAgo * 86400_000 + hours * 3600_000).toISOString().slice(0, 10),
    itemId, itemTitle: 't', action: 'go ahead', reason: AUTO_REASON, result, error,
  });

  it('keys failed cells on the normalized error class and counts resolved rows as context', () => {
    const { cells, resolvedRows, failedRows } = foldNeedsYouAutoCells([
      cellRow('failed', 'The Bus   Did Not Accept the Resolution.', 1),
      cellRow('failed', 'the bus did not accept the resolution.', 2),
      cellRow('failed', 'The bus did not accept the resolution.', 3),
      cellRow('failed', 'No such needs-you item.', 1),
      cellRow('resolved', '', 1),
      cellRow('resolved', '', 4),
    ], NOW_MS);
    expect(resolvedRows).toBe(2);
    expect(failedRows).toBe(4);
    // bus-error cell: 3 rows across 3 days; unknown-item cell: 1 row — under the bars.
    expect(cells.map((c) => [c.errorClass, c.rows, c.days.size, c.itemIds.size])).toEqual([
      ['the bus did not accept the resolution.', 3, 3, 1],
    ]);
  });

  it('drops rows outside the window and beyond the future-skew allowance', () => {
    const { cells, failedRows } = foldNeedsYouAutoCells([
      cellRow('failed', 'err', 8),
      cellRow('failed', 'err', 9),
      cellRow('failed', 'err', 10),
      cellRow('failed', 'err', -1),
      cellRow('failed', 'err', -1, 2),
      cellRow('failed', 'err', 1),
      cellRow('failed', 'err', 2),
    ], NOW_MS);
    expect(failedRows).toBe(2);
    expect(cells).toEqual([]);
  });
});

describe('needsYouAutoBacklogItems', () => {
  it('turns a recurring failed error class into a valid item', async () => {
    const items = await needsYouAutoBacklogItems({
      repo: REPO, now: NOW, journalPath: writeJournal([
        failRow('The bus did not accept the resolution.', 1),
        failRow('The bus did not accept the resolution.', 2, 'nm-bbbbbbbbbbbb', 'Land the docs refresh'),
        failRow('The bus did not accept the resolution.', 4, 'nm-cccccccccccc', 'Bump the router catalog'),
        failRow('The bus did not accept the resolution.', 5),
        audit({ at: at(3) }),
        audit({ at: at(6) }),
      ]),
    });
    expect(items).toHaveLength(1);
    const item = items[0]!;
    expect(validBacklogItem(item)).not.toBeNull();
    expect(item).toMatchObject({ priority: 3, repo: REPO, area: 'needs-you' });
    expect(item.id).toMatch(/^needs-you-auto-[0-9a-f]{16}$/);
    expect(item.title).toContain('The bus did not accept the resolution.');
    expect(item.title).toContain('4 failed attempt(s)');
    expect(item.prompt).toContain('needs-you-auto.jsonl');
    expect(item.prompt).toContain('4 failed auto-resolve row(s)');
    expect(item.prompt).toContain('distinct UTC day(s)');
    expect(item.prompt).toContain('3 distinct item id(s)');
    expect(item.prompt).toContain('2 successful auto-resolve row(s)');
    expect(item.prompt).toContain('no-change');
    expect(item.prompt).toContain('DATA');
  });

  it('emits nothing below the recurring bars of rows and distinct days', async () => {
    // Three rows but a single UTC day — under the days bar.
    const oneDay = writeJournal([
      failed({ error: 'err one', at: at(1, 0), item: { id: 'nm-a', title: 't' } }),
      failed({ error: 'err one', at: at(1, 3), item: { id: 'nm-b', title: 't' } }),
      failed({ error: 'err one', at: at(1, 6), item: { id: 'nm-c', title: 't' } }),
    ]);
    expect(await needsYouAutoBacklogItems({ repo: REPO, journalPath: oneDay, now: NOW })).toEqual([]);
    // Two rows across two days — under the units bar.
    const twoRows = writeJournal([
      failRow('err two', 1),
      failRow('err two', 3),
    ]);
    expect(await needsYouAutoBacklogItems({ repo: REPO, journalPath: twoRows, now: NOW })).toEqual([]);
    expect(NEEDS_YOU_AUTO_MIN_UNITS).toBe(3);
    expect(NEEDS_YOU_AUTO_MIN_DAYS).toBe(2);
  });

  it('yields nothing for a missing or malformed journal', async () => {
    expect(await needsYouAutoBacklogItems({ repo: REPO, journalPath: path.join(home, 'no-such.jsonl'), now: NOW })).toEqual([]);
    const file = writeJournal([
      'not json',
      '{"item":{"id":"nm-1","title":"x"},"action":"a","at":"bad","reason":"r"}',
      '{"item":{"id":"nm-1","title":"x"},"action":"a","at":"2026-11-24T00:00:00Z","reason":"r","result":"failed","error":"e"}',
    ]);
    expect(await needsYouAutoBacklogItems({ repo: REPO, journalPath: file, now: NOW })).toEqual([]);
    expect(await needsYouAutoBacklogItems({ repo: '', journalPath: file, now: NOW })).toEqual([]);
    expect(await needsYouAutoBacklogItems({ repo: 'not-a-repo', journalPath: file, now: NOW })).toEqual([]);
  });

  it('emits nothing for another repository or an empty repo', async () => {
    const file = writeJournal([
      failRow('err three', 1),
      failRow('err three', 3),
      failRow('err three', 5),
    ]);
    expect(await needsYouAutoBacklogItems({ repo: 'ashlrai/other', journalPath: file, now: NOW })).toEqual([]);
    expect(await needsYouAutoBacklogItems({ repo: 'AshlrAI/Phantom', journalPath: file, now: NOW })).toHaveLength(1);
  });

  it('drops rows outside the 7-day window and beyond the future-skew allowance', async () => {
    const stale = writeJournal([
      failRow('err four', 8),
      failRow('err four', 9),
      failRow('err four', 10),
    ]);
    expect(await needsYouAutoBacklogItems({ repo: REPO, journalPath: stale, now: NOW })).toEqual([]);
    const future = writeJournal([
      failRow('err five', -1),
      failRow('err five', -1, 'nm-b', 't'),
      failRow('err five', -1, 'nm-c', 't'),
    ]);
    expect(await needsYouAutoBacklogItems({ repo: REPO, journalPath: future, now: NOW })).toEqual([]);
  });

  it('states truncation as a lower bound in the prompt', async () => {
    const file = writeJournal([
      failRow('err six', 1),
      failRow('err six', 3),
      failRow('err six', 5),
    ]);
    // Pad the journal past the 256 KiB tail so the read reports truncated.
    fs.writeFileSync(file, 'x'.repeat(300 * 1024) + '\n' + fs.readFileSync(file, 'utf8'));
    const items = await needsYouAutoBacklogItems({ repo: REPO, journalPath: file, now: NOW });
    expect(items.length).toBeGreaterThan(0);
    for (const item of items) expect(item.prompt).toContain('lower bound');
  });

  it('derives stable ids so a refresh re-adds nothing', async () => {
    const rows = [
      failRow('err seven', 1),
      failRow('err seven', 3),
      failRow('err seven', 5),
    ];
    const file = writeJournal(rows);
    const first = await needsYouAutoBacklogItems({ repo: REPO, journalPath: file, now: NOW });
    const second = await needsYouAutoBacklogItems({ repo: REPO, journalPath: file, now: NOW });
    expect(first.length).toBeGreaterThan(0);
    expect(second.map((i) => i.id)).toEqual(first.map((i) => i.id));
    // Shifted tallies on the same cells re-derive the same ids.
    const grown = writeJournal([...rows, failRow('err seven', 6)]);
    const third = await needsYouAutoBacklogItems({ repo: REPO, journalPath: grown, now: NOW });
    expect(third.map((i) => i.id)).toEqual(first.map((i) => i.id));
    expect(first.length).toBeLessThanOrEqual(NEEDS_YOU_AUTO_BACKLOG_MAX_ITEMS);
  });

  it('reads the default journal path under the runs dir', async () => {
    // The writer's own layout: <runs dir>/needs-you-auto.jsonl.
    writeJournal([
      failRow('err eight', 1),
      failRow('err eight', 3),
      failRow('err eight', 5),
    ]);
    const items = await needsYouAutoBacklogItems({ repo: REPO, now: NOW });
    expect(items).toHaveLength(1);
    expect(items[0]!.id.startsWith('needs-you-auto-')).toBe(true);
  });

  it('appends needs-you items through discovery and dedupes on refresh', async () => {
    writeJournal([
      failRow('err nine', 1),
      failRow('err nine', 3),
      failRow('err nine', 5),
    ]);
    const greenGh = async (args: string[]) => {
      const p = args[4] ?? '';
      if (p === 'repos/ashlrai/phantom') return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n{"default_branch":"master"}', stderr: '' };
      return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n[]', stderr: '' };
    };
    const first = await discoverBacklog(REPO, { gh: greenGh });
    const autoItems = first.items.filter((i) => i.id.startsWith('needs-you-auto-'));
    expect(autoItems).toHaveLength(1);
    expect(first.items.every((i) => validBacklogItem(i) !== null)).toBe(true);
    expect(appendUserBacklogItems(autoItems)).toBe(autoItems.length);
    const second = await discoverBacklog(REPO, { gh: greenGh });
    expect(appendUserBacklogItems(second.items.filter((i) => i.id.startsWith('needs-you-auto-')))).toBe(0);
    expect(readUserBacklogItems().filter((i) => i.id.startsWith('needs-you-auto-'))).toHaveLength(autoItems.length);
  });
});
