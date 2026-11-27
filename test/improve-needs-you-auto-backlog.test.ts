import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm, truncate } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  foldNeedsYouAutoRows,
  needsYouAutoBacklogItems,
  needsYouAutoCells,
  NEEDS_YOU_AUTO_MIN_DAYS,
  NEEDS_YOU_AUTO_READ_MAX,
  parseNeedsYouAutoJournal,
  parseNeedsYouAutoJournalEntry,
} from '../src/core/improve/needs-you-auto-backlog.js';
import { discoverBacklog } from '../src/core/improve/discover.js';
import { appendUserBacklogItems, readUserBacklogItems, validBacklogItem } from '../src/core/cloud/backlog.js';

const DAY = 86_400_000;
const HOUR = 3_600_000;
const J = (o: Record<string, unknown>): string => JSON.stringify(o);

/** Fixed evaluation instant; fixture timestamps are ISO-8601 UTC like the audit writer's `at`. */
const NOW_MS = Date.parse('2026-11-23T12:00:00.000Z');
const NOW = new Date(NOW_MS);
const iso = (ms: number): string => new Date(ms).toISOString();
const REPO = 'ashlrai/phantom';

let home: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'needs-you-auto-backlog-'));
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

/** One row in the writer's audit shape — resolveAutoNeedsYou emits {item:{id,title},action,at,reason} plus result/error on failures. */
function row(spec: {
  atMs?: number; itemId?: string; title?: string; action?: string; reason?: string;
  result?: string; error?: string; extra?: Record<string, unknown>;
}): string {
  const record: Record<string, unknown> = {
    item: { id: spec.itemId ?? 'nm-aaaabbbbcccc', title: spec.title ?? 'Restart the flaky lane' },
    action: spec.action ?? 'go ahead',
    at: iso(spec.atMs ?? NOW_MS),
    reason: spec.reason ?? 'outside the four hard limits',
  };
  if (spec.result !== undefined) record['result'] = spec.result;
  if (spec.error !== undefined) record['error'] = spec.error;
  return J({ ...record, ...spec.extra });
}

/** Write audit text to <home>/<runsDirName>/needs-you-auto.jsonl and return its path. */
function writeAudit(lines: string[], runsDirName = 'runs'): string {
  const dir = join(home, runsDirName);
  const file = join(dir, 'needs-you-auto.jsonl');
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, lines.join('\n') + '\n');
  return file;
}

describe('parseNeedsYouAutoJournalEntry', () => {
  it('accepts the writer contract and rejects off-contract rows', () => {
    expect(parseNeedsYouAutoJournalEntry({
      item: { id: 'nm-aaaabbbbcccc', title: 'Restart the flaky lane' },
      action: 'go ahead', at: iso(NOW_MS), reason: 'auto work',
    })).not.toBeNull();
    expect(parseNeedsYouAutoJournalEntry({
      item: { id: 'nm-aaaabbbbcccc', title: 'x' }, action: 'yes', at: iso(NOW_MS), reason: 'r',
      result: 'failed', error: 'bus refused',
    })).not.toBeNull();
    expect(parseNeedsYouAutoJournalEntry({
      item: { id: 'nm-aaaabbbbcccc', title: 'x' }, action: 'yes', at: iso(NOW_MS), reason: 'r',
      result: 'resolved',
    })).not.toBeNull();
    // Off-contract: bad at, missing fields, wrong result vocabulary, non-string error.
    expect(parseNeedsYouAutoJournalEntry({
      item: { id: 'nm-1', title: 'x' }, action: 'a', at: 'not-a-date', reason: 'r',
    })).toBeNull();
    expect(parseNeedsYouAutoJournalEntry({
      item: { id: 'nm-1', title: 'x' }, action: 'a', at: iso(NOW_MS), reason: 'r', result: 'maybe',
    })).toBeNull();
    expect(parseNeedsYouAutoJournalEntry({
      item: { id: 'nm-1', title: 'x' }, action: 'a', at: iso(NOW_MS), reason: 'r', error: 42,
    })).toBeNull();
    expect(parseNeedsYouAutoJournalEntry({ action: 'a', at: iso(NOW_MS), reason: 'r' })).toBeNull();
    expect(parseNeedsYouAutoJournalEntry({
      item: { id: 7, title: 'x' }, action: 'a', at: iso(NOW_MS), reason: 'r',
    })).toBeNull();
    expect(parseNeedsYouAutoJournalEntry('nope')).toBeNull();
    expect(parseNeedsYouAutoJournalEntry(null)).toBeNull();
  });

  it('counts malformed lines and off-contract rows without guessing', () => {
    const parsed = parseNeedsYouAutoJournal([
      'not json',
      row({ result: 'failed' }),
      J({ item: { id: 'nm-1' }, action: 'a', at: iso(NOW_MS), reason: 'r' }), // item.title missing
      '',
    ].join('\n'));
    expect(parsed.rows).toHaveLength(1);
    expect(parsed.invalidRows).toBe(2);
  });
});

describe('foldNeedsYouAutoRows', () => {
  it('classes failed rows, resolved context and window edges', () => {
    const text = [
      row({ atMs: NOW_MS - DAY, itemId: 'nm-f1', result: 'failed', error: 'bus refused' }),
      row({ atMs: NOW_MS - DAY + HOUR, itemId: 'nm-r1' }), // resolved: result absent
      row({ atMs: NOW_MS - 2 * DAY, itemId: 'nm-f2', result: 'failed' }),
      row({ atMs: NOW_MS - 2 * DAY + HOUR, itemId: 'nm-r2', result: 'resolved' }),
      row({ atMs: NOW_MS - 10 * DAY, itemId: 'nm-f3', result: 'failed' }), // outside window
      row({ atMs: NOW_MS + 10 * DAY, itemId: 'nm-f4', result: 'failed' }), // future beyond skew
    ].join('\n');
    const fold = foldNeedsYouAutoRows(text, { nowMs: NOW_MS });
    expect(fold.rows).toBe(4);
    expect(fold.failedRows).toBe(2);
    expect(fold.failedDays.size).toBe(2);
    expect(fold.failedItems.size).toBe(2);
    expect(fold.failedItemAttempts.get('nm-f1')).toBe(1);
    expect(fold.resolvedRows).toBe(2);
    expect(fold.outsideWindow).toBe(2);
  });
});

describe('needsYouAutoCells', () => {
  it('emits failed-auto-resolve only at the recurring bars', () => {
    // 3 failed rows all on one UTC day → no cell
    const sameDay = [
      row({ atMs: Date.parse('2026-11-20T01:00:00Z'), itemId: 'nm-a', result: 'failed' }),
      row({ atMs: Date.parse('2026-11-20T05:00:00Z'), itemId: 'nm-b', result: 'failed' }),
      row({ atMs: Date.parse('2026-11-20T09:00:00Z'), itemId: 'nm-c', result: 'failed' }),
    ].join('\n');
    expect(needsYouAutoCells(foldNeedsYouAutoRows(sameDay, { nowMs: NOW_MS }))).toHaveLength(0);
    // 2 rows across 2 days → below MIN_ROWS
    const two = [
      row({ atMs: NOW_MS - DAY, itemId: 'nm-a', result: 'failed' }),
      row({ atMs: NOW_MS - 2 * DAY, itemId: 'nm-b', result: 'failed' }),
    ].join('\n');
    expect(needsYouAutoCells(foldNeedsYouAutoRows(two, { nowMs: NOW_MS }))).toHaveLength(0);
    // 3 rows across 2 days → cell
    const three = [
      row({ atMs: NOW_MS - DAY, itemId: 'nm-a', result: 'failed' }),
      row({ atMs: NOW_MS - 2 * DAY, itemId: 'nm-b', result: 'failed' }),
      row({ atMs: NOW_MS - 3 * DAY, itemId: 'nm-a', result: 'failed' }),
      row({ atMs: NOW_MS - DAY, itemId: 'nm-r', result: 'resolved' }),
    ].join('\n');
    const cells = needsYouAutoCells(foldNeedsYouAutoRows(three, { nowMs: NOW_MS }));
    expect(cells).toHaveLength(1);
    expect(cells[0]).toMatchObject({
      kind: 'failed-auto-resolve', rows: 3, items: 2, busiestItemAttempts: 2, resolvedContext: 1,
    });
    expect(cells[0]!.days.length).toBeGreaterThanOrEqual(NEEDS_YOU_AUTO_MIN_DAYS);
  });
});

describe('needsYouAutoBacklogItems', () => {
  const failedRows = (): string[] => [
    row({ atMs: NOW_MS - DAY, itemId: 'nm-f1', result: 'failed', error: 'bus refused', title: 'SECRET-TITLE-ONE', action: 'SECRET-ACTION' }),
    row({ atMs: NOW_MS - 2 * DAY, itemId: 'nm-f2', result: 'failed', error: 'ledger locked', reason: 'SECRET-REASON' }),
    row({ atMs: NOW_MS - 3 * DAY, itemId: 'nm-f1', result: 'failed' }),
    row({ atMs: NOW_MS - DAY, itemId: 'nm-r1' }),
  ];

  it('emits a failed-auto-resolve item for the fleet repo only', async () => {
    const file = writeAudit(failedRows());
    expect(await needsYouAutoBacklogItems({ repo: 'someone/else', journalPath: file, now: NOW })).toEqual([]);
    const items = await needsYouAutoBacklogItems({ repo: 'AshlrAI/Phantom', journalPath: file, now: NOW });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ repo: 'AshlrAI/Phantom', area: 'needs-you-auto-failed', priority: 3 });
    expect(items[0]!.id).toMatch(/^needs-you-auto-failed-auto-resolve-/);
    expect(validBacklogItem(items[0]!)).not.toBeNull();
  });

  it('never emits item ids, titles, actions, reasons or error text into prompts', async () => {
    const file = writeAudit(failedRows());
    const items = await needsYouAutoBacklogItems({ repo: REPO, journalPath: file, now: NOW });
    expect(items).toHaveLength(1);
    const prompt = items[0]!.prompt;
    for (const secret of ['nm-f1', 'nm-f2', 'nm-r1', 'SECRET-TITLE-ONE', 'SECRET-ACTION', 'SECRET-REASON', 'bus refused', 'ledger locked']) {
      expect(prompt).not.toContain(secret);
    }
    expect(prompt).toContain('3');
    expect(prompt).toContain('2 distinct ledger item(s)');
  });

  it('yields nothing for a missing or malformed journal', async () => {
    expect(await needsYouAutoBacklogItems({ repo: REPO, journalPath: join(home, 'nope.jsonl'), now: NOW })).toEqual([]);
    const file = writeAudit(['not json', '{"item":{"id":"nm-1"}}']);
    expect(await needsYouAutoBacklogItems({ repo: REPO, journalPath: file, now: NOW })).toEqual([]);
  });

  it('states truncation as a lower bound, never an oversize item', async () => {
    // Enough failed rows that the retained tail still clears the bars after
    // the bounded read drops the file's first (partial) line.
    const deep = [
      row({ atMs: NOW_MS - DAY, itemId: 'nm-t1', result: 'failed' }),
      row({ atMs: NOW_MS - 2 * DAY, itemId: 'nm-t2', result: 'failed' }),
      row({ atMs: NOW_MS - 3 * DAY, itemId: 'nm-t3', result: 'failed' }),
      row({ atMs: NOW_MS - 4 * DAY, itemId: 'nm-t4', result: 'failed' }),
      row({ atMs: NOW_MS - 5 * DAY, itemId: 'nm-t5', result: 'failed' }),
      row({ atMs: NOW_MS - DAY, itemId: 'nm-tr', result: 'resolved' }),
    ];
    const file = writeAudit(deep);
    await truncate(file, NEEDS_YOU_AUTO_READ_MAX + 16);
    const items = await needsYouAutoBacklogItems({ repo: REPO, journalPath: file, now: NOW });
    const cell = items.find((i) => i.id.startsWith('needs-you-auto-failed-auto-resolve-'));
    expect(cell).toBeDefined();
    expect(cell!.prompt).toContain('lower bound');
    expect(items.every((i) => i.area !== 'needs-you-auto-oversize')).toBe(true);
    // Non-fleet repos never see install-wide journal health either.
    expect(await needsYouAutoBacklogItems({ repo: 'someone/else', journalPath: file, now: NOW })).toEqual([]);
  });

  it('derives stable ids so a refresh re-adds nothing', async () => {
    const file = writeAudit(failedRows());
    const first = await needsYouAutoBacklogItems({ repo: REPO, journalPath: file, now: NOW });
    const second = await needsYouAutoBacklogItems({ repo: REPO, journalPath: file, now: NOW });
    expect(first).toHaveLength(1);
    expect(second.map((i) => i.id)).toEqual(first.map((i) => i.id));
  });

  it('reads the default journal path under the runs dir', async () => {
    writeAudit(failedRows(), 'custom-runs');
    const items = await needsYouAutoBacklogItems({ repo: REPO, runsDir: join(home, 'custom-runs'), now: NOW });
    expect(items).toHaveLength(1);
  });

  it('appends needs-you-auto items through discovery and dedupes on refresh', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    try {
      process.env.ASHLR_RUNS_DIR = join(home, 'runs');
      writeAudit(failedRows());
      const greenGh = async (args: string[]) => {
        const p = args[4] ?? '';
        if (p === 'repos/ashlrai/phantom') return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n{"default_branch":"master"}', stderr: '' };
        return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n[]', stderr: '' };
      };
      const first = await discoverBacklog(REPO, { gh: greenGh });
      const landed = first.items.filter((i) => i.id.startsWith('needs-you-auto-'));
      expect(landed.length).toBeGreaterThanOrEqual(1);
      expect(first.items.every((i) => validBacklogItem(i) !== null)).toBe(true);
      expect(appendUserBacklogItems(landed)).toBe(landed.length);
      const second = await discoverBacklog(REPO, { gh: greenGh });
      expect(appendUserBacklogItems(second.items.filter((i) => i.id.startsWith('needs-you-auto-')))).toBe(0);
      expect(readUserBacklogItems().filter((i) => i.id.startsWith('needs-you-auto-'))).toHaveLength(landed.length);
    } finally {
      vi.useRealTimers();
    }
  });
});
