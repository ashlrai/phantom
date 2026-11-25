import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm, truncate } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  foldLeaderReplyRows,
  leaderRepliesBacklogItems,
  leaderRepliesCells,
  LEADER_REPLIES_MIN_DAYS,
  LEADER_REPLIES_MIN_ORPHAN_DAYS,
  LEADER_REPLIES_WINDOW_MS,
  LEDGER_MAX_BYTES,
  parseLeaderReplyJournal,
  parseLeaderReplyJournalEntry,
} from '../src/core/improve/leader-replies-backlog.js';
import { discoverBacklog } from '../src/core/improve/discover.js';
import { appendUserBacklogItems, readUserBacklogItems, validBacklogItem } from '../src/core/cloud/backlog.js';

const DAY = 86_400_000;
const HOUR = 3_600_000;
const J = (o: Record<string, unknown>): string => JSON.stringify(o);

/** Fixed evaluation instant; fixture timestamps are ISO-8601 UTC like the ledger writer's `at`. */
const NOW_MS = Date.parse('2026-11-23T12:00:00.000Z');
const NOW = new Date(NOW_MS);
const iso = (ms: number): string => new Date(ms).toISOString();
const hashOf = (seed: string): string => seed.repeat(64).slice(0, 64);
const REPO = 'ashlrai/phantom';

let home: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'leader-replies-backlog-'));
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

/** One row in the writer's ledger shape — record() emits exactly {at, hash, status}. */
function row(spec: { atMs?: number; hash?: string; status?: string; extra?: Record<string, unknown> }): string {
  return J({
    at: iso(spec.atMs ?? NOW_MS),
    hash: spec.hash ?? hashOf('a'),
    status: spec.status ?? 'failed',
    ...spec.extra,
  });
}

/** Write ledger text to <home>/runs/imessage/leader-sent.jsonl and return its path. */
function writeLedger(lines: string[], runsDirName = 'runs'): string {
  const dir = join(home, runsDirName, 'imessage');
  const file = join(dir, 'leader-sent.jsonl');
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, lines.join('\n') + '\n');
  return file;
}

describe('parseLeaderReplyJournalEntry', () => {
  it('accepts the writer contract and rejects off-contract rows', () => {
    expect(parseLeaderReplyJournalEntry({ at: iso(NOW_MS), hash: hashOf('b'), status: 'failed' })).not.toBeNull();
    expect(parseLeaderReplyJournalEntry({ at: iso(NOW_MS), hash: 'start', status: 'baseline' })).not.toBeNull();
    expect(parseLeaderReplyJournalEntry({ at: 'not-a-date', hash: hashOf('b'), status: 'failed' })).toBeNull();
    expect(parseLeaderReplyJournalEntry({ at: iso(NOW_MS), hash: 'tooshort', status: 'failed' })).toBeNull();
    expect(parseLeaderReplyJournalEntry({ at: iso(NOW_MS), hash: hashOf('b'), status: 'maybe' })).toBeNull();
    expect(parseLeaderReplyJournalEntry({ at: iso(NOW_MS), status: 'failed' })).toBeNull();
    expect(parseLeaderReplyJournalEntry('nope')).toBeNull();
    expect(parseLeaderReplyJournalEntry(null)).toBeNull();
  });

  it('counts malformed lines and off-contract rows without guessing', () => {
    const parsed = parseLeaderReplyJournal([
      'not json',
      row({ status: 'failed' }),
      J({ at: iso(NOW_MS), hash: 'bad', status: 'failed' }),
      '',
    ].join('\n'));
    expect(parsed.rows).toHaveLength(1);
    expect(parsed.invalidRows).toBe(2);
  });
});

describe('foldLeaderReplyRows', () => {
  it('classes failed rows, orphans and healthy context inside the window', () => {
    const stalePending = NOW_MS - 2 * HOUR;
    const text = [
      row({ atMs: NOW_MS - DAY, hash: hashOf('1'), status: 'failed' }),
      row({ atMs: NOW_MS - DAY + HOUR, hash: hashOf('1'), status: 'sent' }),
      row({ atMs: NOW_MS - 2 * DAY, hash: hashOf('2'), status: 'failed' }),
      row({ atMs: stalePending, hash: hashOf('3'), status: 'pending' }), // orphan: last status, stale
      row({ atMs: NOW_MS - 3 * HOUR, hash: hashOf('4'), status: 'pending' }), // resolved below
      row({ atMs: NOW_MS - 3 * HOUR + 60_000, hash: hashOf('4'), status: 'sent' }),
      row({ atMs: NOW_MS - 10 * DAY, hash: hashOf('5'), status: 'failed' }), // outside window
      row({ atMs: NOW_MS - HOUR, hash: 'start', status: 'baseline' }),
    ].join('\n');
    const fold = foldLeaderReplyRows(text, { nowMs: NOW_MS });
    expect(fold.rows).toBe(7);
    expect(fold.failedRows).toBe(2);
    expect(fold.failedDays.size).toBe(2);
    expect(fold.failedHashes.get(hashOf('1'))).toBe(1);
    expect(fold.sentRows).toBe(2);
    expect(fold.pendingRows).toBe(2);
    expect(fold.baselineRows).toBe(1);
    expect(fold.orphans).toBe(1);
    expect(fold.outsideWindow).toBe(1);
  });

  it('does not orphan a fresh pending or a pending resolved by a later row', () => {
    const text = [
      row({ atMs: NOW_MS - 30 * 60_000, hash: hashOf('6'), status: 'pending' }), // in-flight: too fresh
      row({ atMs: NOW_MS - 5 * HOUR, hash: hashOf('7'), status: 'pending' }),
      row({ atMs: NOW_MS - 4 * HOUR, hash: hashOf('7'), status: 'failed' }), // resolved: last is failed
      row({ atMs: NOW_MS - 5 * HOUR, hash: hashOf('8'), status: 'pending' }),
      row({ atMs: NOW_MS - 4 * HOUR, hash: hashOf('8'), status: 'sent' }), // resolved: last is sent
    ].join('\n');
    const fold = foldLeaderReplyRows(text, { nowMs: NOW_MS });
    expect(fold.orphans).toBe(0);
    expect(fold.failedRows).toBe(1);
  });

  it('a stale pending outside the window is not an in-window orphan', () => {
    const text = [
      row({ atMs: NOW_MS - LEADER_REPLIES_WINDOW_MS - DAY, hash: hashOf('9'), status: 'pending' }),
    ].join('\n');
    const fold = foldLeaderReplyRows(text, { nowMs: NOW_MS });
    expect(fold.orphans).toBe(0);
  });
});

describe('leaderRepliesCells', () => {
  const failedRows = (count: number, dayOffsetStep = DAY): string[] => {
    const lines: string[] = [];
    for (let i = 0; i < count; i += 1) {
      lines.push(row({ atMs: NOW_MS - i * dayOffsetStep, hash: hashOf(`f${i}`), status: 'failed' }));
    }
    return lines;
  };

  it('emits failed-send only at the recurring bars', () => {
    // 3 rows but all on one UTC day → no cell
    const sameDay = [
      row({ atMs: Date.parse('2026-11-20T01:00:00Z'), hash: hashOf('a'), status: 'failed' }),
      row({ atMs: Date.parse('2026-11-20T05:00:00Z'), hash: hashOf('b'), status: 'failed' }),
      row({ atMs: Date.parse('2026-11-20T09:00:00Z'), hash: hashOf('c'), status: 'failed' }),
    ].join('\n');
    expect(leaderRepliesCells(foldLeaderReplyRows(sameDay, { nowMs: NOW_MS }))).toHaveLength(0);
    // 2 rows across 2 days → below MIN_ROWS
    const two = [
      row({ atMs: NOW_MS - DAY, hash: hashOf('a'), status: 'failed' }),
      row({ atMs: NOW_MS - 2 * DAY, hash: hashOf('b'), status: 'failed' }),
    ].join('\n');
    expect(leaderRepliesCells(foldLeaderReplyRows(two, { nowMs: NOW_MS }))).toHaveLength(0);
    // 3 rows across 2 days → cell
    const three = failedRows(3).join('\n');
    const cells = leaderRepliesCells(foldLeaderReplyRows(three, { nowMs: NOW_MS }));
    expect(cells).toHaveLength(1);
    expect(cells[0]).toMatchObject({ kind: 'failed-send', rows: 3 });
    expect(cells[0]!.days.length).toBeGreaterThanOrEqual(LEADER_REPLIES_MIN_DAYS);
  });

  it('emits orphaned-pending at stale dead letters across distinct days', () => {
    const stale = NOW_MS - 2 * HOUR;
    const text = [
      row({ atMs: stale, hash: hashOf('a'), status: 'pending' }),
      row({ atMs: NOW_MS - 2 * DAY - HOUR, hash: hashOf('b'), status: 'pending' }),
      row({ atMs: NOW_MS - 5 * DAY - HOUR, hash: hashOf('c'), status: 'pending' }),
    ].join('\n');
    const cells = leaderRepliesCells(foldLeaderReplyRows(text, { nowMs: NOW_MS }));
    const orphan = cells.find((c) => c.kind === 'orphaned-pending');
    expect(orphan).toBeDefined();
    expect(orphan!.rows).toBe(3);
    expect(orphan!.days.length).toBeGreaterThanOrEqual(LEADER_REPLIES_MIN_ORPHAN_DAYS);
  });

  it('two orphans on the same UTC day do not emit', () => {
    const stale = NOW_MS - 2 * HOUR;
    const text = [
      row({ atMs: stale, hash: hashOf('a'), status: 'pending' }),
      row({ atMs: stale + 60_000, hash: hashOf('b'), status: 'pending' }),
    ].join('\n');
    const fold = foldLeaderReplyRows(text, { nowMs: NOW_MS });
    expect(fold.orphans).toBe(2);
    expect(leaderRepliesCells(fold)).toHaveLength(0);
  });
});

describe('leaderRepliesBacklogItems', () => {
  const failedRows = (): string[] => [
    row({ atMs: NOW_MS - DAY, hash: hashOf('1'), status: 'failed' }),
    row({ atMs: NOW_MS - 2 * DAY, hash: hashOf('2'), status: 'failed' }),
    row({ atMs: NOW_MS - 3 * DAY, hash: hashOf('3'), status: 'failed' }),
    row({ atMs: NOW_MS - DAY, hash: hashOf('9'), status: 'sent' }),
  ];

  it('emits a failed-send item for the fleet repo only', async () => {
    const file = writeLedger(failedRows());
    expect(await leaderRepliesBacklogItems({ repo: 'someone/else', journalPath: file, now: NOW })).toEqual([]);
    const items = await leaderRepliesBacklogItems({ repo: 'AshlrAI/Phantom', journalPath: file, now: NOW });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ repo: 'AshlrAI/Phantom', area: 'leader-replies-failed', priority: 3 });
    expect(items[0]!.id).toMatch(/^leader-replies-failed-send-/);
    expect(validBacklogItem(items[0]!)).not.toBeNull();
  });

  it('never emits reply digests or other ledger strings into prompts', async () => {
    const file = writeLedger(failedRows());
    const items = await leaderRepliesBacklogItems({ repo: REPO, journalPath: file, now: NOW });
    expect(items).toHaveLength(1);
    for (const seed of ['1', '2', '3', '9']) {
      expect(items[0]!.prompt).not.toContain(hashOf(seed));
    }
    expect(items[0]!.prompt).toContain('3 distinct reply digest(s)');
  });

  it('yields nothing for a missing or malformed journal', async () => {
    expect(await leaderRepliesBacklogItems({ repo: REPO, journalPath: join(home, 'nope.jsonl'), now: NOW })).toEqual([]);
    const file = writeLedger(['not json', '{"at":"x"}']);
    expect(await leaderRepliesBacklogItems({ repo: REPO, journalPath: file, now: NOW })).toEqual([]);
  });

  it('emits an oversize item when the ledger passes the writer read bound', async () => {
    const file = writeLedger(failedRows());
    await truncate(file, LEDGER_MAX_BYTES + 16);
    const items = await leaderRepliesBacklogItems({ repo: REPO, journalPath: file, now: NOW });
    const oversize = items.find((i) => i.area === 'leader-replies-oversize');
    expect(oversize).toBeDefined();
    expect(oversize!.prompt).toContain('read bound');
    // Non-fleet repos never see install-wide journal health either.
    expect(await leaderRepliesBacklogItems({ repo: 'someone/else', journalPath: file, now: NOW })).toEqual([]);
  });

  it('derives stable ids so a refresh re-adds nothing', async () => {
    const file = writeLedger(failedRows());
    const first = await leaderRepliesBacklogItems({ repo: REPO, journalPath: file, now: NOW });
    const second = await leaderRepliesBacklogItems({ repo: REPO, journalPath: file, now: NOW });
    expect(first).toHaveLength(1);
    expect(second.map((i) => i.id)).toEqual(first.map((i) => i.id));
  });

  it('reads the default journal path under the runs dir', async () => {
    writeLedger(failedRows(), 'custom-runs');
    const items = await leaderRepliesBacklogItems({ repo: REPO, runsDir: join(home, 'custom-runs'), now: NOW });
    expect(items).toHaveLength(1);
  });

  it('appends leader-replies items through discovery and dedupes on refresh', async () => {
    process.env.ASHLR_RUNS_DIR = join(home, 'runs');
    writeLedger(failedRows());
    const greenGh = async (args: string[]) => {
      const p = args[4] ?? '';
      if (p === 'repos/ashlrai/phantom') return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n{"default_branch":"master"}', stderr: '' };
      return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n[]', stderr: '' };
    };
    const first = await discoverBacklog(REPO, { gh: greenGh });
    const landed = first.items.filter((i) => i.id.startsWith('leader-replies-'));
    expect(landed.length).toBeGreaterThanOrEqual(1);
    expect(first.items.every((i) => validBacklogItem(i) !== null)).toBe(true);
    expect(appendUserBacklogItems(landed)).toBe(landed.length);
    const second = await discoverBacklog(REPO, { gh: greenGh });
    expect(appendUserBacklogItems(second.items.filter((i) => i.id.startsWith('leader-replies-')))).toBe(0);
    expect(readUserBacklogItems().filter((i) => i.id.startsWith('leader-replies-'))).toHaveLength(landed.length);
  });
});
