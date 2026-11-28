import { mkdirSync, statSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  COS_RECONCILE_MIN_DAYS,
  COS_RECONCILE_MIN_IDS,
  COS_RECONCILE_MIN_RETRIES,
  COS_RECONCILE_TAIL_BYTES,
  cosReconcileBacklogItems,
  cosReconcileCells,
  foldCosReconcileRows,
  parseCosReconcileJournal,
  parseCosReconcileJournalEntry,
} from '../src/core/improve/cos-reconcile-backlog.js';
import { discoverBacklog } from '../src/core/improve/discover.js';
import { appendUserBacklogItems, readUserBacklogItems, validBacklogItem } from '../src/core/cloud/backlog.js';

const DAY = 86_400_000;
const HOUR = 3_600_000;
const J = (o: Record<string, unknown>): string => JSON.stringify(o);

/** Fixed evaluation instant; fixture timestamps are ISO-8601 UTC like the ledger writer's `at`. */
const NOW_MS = Date.parse('2026-11-23T12:00:00.000Z');
const NOW = new Date(NOW_MS);
const iso = (ms: number): string => new Date(ms).toISOString();
const REPO = 'ashlrai/phantom';

let home: string;
let savedHome: string | undefined;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'cos-reconcile-backlog-'));
  savedHome = process.env['HOME'];
});
afterEach(async () => {
  if (savedHome === undefined) delete process.env['HOME'];
  else process.env['HOME'] = savedHome;
  await rm(home, { recursive: true, force: true });
});

/** One row in the writer's ledger shape — reconcileCosDelivery emits {at, id, from, verdict}. */
function row(spec: {
  atMs?: number;
  id?: string;
  from?: string;
  verdict?: string;
  extra?: Record<string, unknown>;
}): string {
  const o: Record<string, unknown> = {
    at: iso(spec.atMs ?? NOW_MS),
    id: spec.id ?? 'd1',
    from: spec.from ?? 'uncertain',
    verdict: spec.verdict ?? 'retry',
    ...spec.extra,
  };
  return J(o);
}

/** Write ledger text to <home>/<runsDirName>/cos/reconcile.jsonl and return its path. */
function writeLedger(lines: string[], runsDirName = 'runs'): string {
  const dir = join(home, runsDirName, 'cos');
  const file = join(dir, 'reconcile.jsonl');
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, lines.join('\n') + '\n');
  return file;
}

/** Three 'retry' rows on 'uncertain' deliveries across three UTC days and three distinct ids — the recurring cell. */
function recurringRetry(from = 'uncertain'): string[] {
  return [
    row({ atMs: NOW_MS - DAY, id: 'd11', from }),
    row({ atMs: NOW_MS - 2 * DAY, id: 'd12', from }),
    row({ atMs: NOW_MS - 3 * DAY, id: 'd13', from }),
  ];
}

describe('parseCosReconcileJournalEntry', () => {
  it('accepts the writer contract and rejects off-contract rows', () => {
    expect(parseCosReconcileJournalEntry({ at: iso(NOW_MS), id: 'd1', from: 'uncertain', verdict: 'retry' })).not.toBeNull();
    expect(parseCosReconcileJournalEntry({ at: iso(NOW_MS), id: 'd1', from: 'sending', verdict: 'delivered' })).not.toBeNull();
    expect(parseCosReconcileJournalEntry({ at: 'not-a-date', id: 'd1', from: 'uncertain', verdict: 'retry' })).toBeNull();
    expect(parseCosReconcileJournalEntry({ at: iso(NOW_MS), id: 'd1', from: 'maybe', verdict: 'retry' })).toBeNull();
    expect(parseCosReconcileJournalEntry({ at: iso(NOW_MS), id: 'd1', from: 'uncertain', verdict: 'maybe' })).toBeNull();
    expect(parseCosReconcileJournalEntry({ at: iso(NOW_MS), id: '', from: 'uncertain', verdict: 'retry' })).toBeNull();
    expect(parseCosReconcileJournalEntry({ at: iso(NOW_MS), from: 'uncertain', verdict: 'retry' })).toBeNull();
    expect(parseCosReconcileJournalEntry('nope')).toBeNull();
    expect(parseCosReconcileJournalEntry(null)).toBeNull();
  });

  it('counts malformed lines and off-contract rows without guessing', () => {
    const parsed = parseCosReconcileJournal([
      'not json',
      row({}),
      J({ at: iso(NOW_MS), id: 'd1', from: 'pigeon', verdict: 'retry' }),
      '',
    ].join('\n'));
    expect(parsed.rows).toHaveLength(1);
    expect(parsed.invalidRows).toBe(2);
  });
});

describe('foldCosReconcileRows', () => {
  it('classes retry cells by from state and keeps delivered and outside rows as context', () => {
    const text = [
      row({ atMs: NOW_MS - DAY, id: 'd1', from: 'uncertain' }),
      row({ atMs: NOW_MS - DAY + HOUR, id: 'd2', from: 'uncertain', verdict: 'delivered' }),
      row({ atMs: NOW_MS - 2 * DAY, id: 'd3', from: 'sending' }),
      row({ atMs: NOW_MS - 30 * DAY, id: 'd4', from: 'uncertain' }), // outside window
      'not json',
    ].join('\n');
    const fold = foldCosReconcileRows(text, { nowMs: NOW_MS });
    expect(fold.rows).toBe(3); // dated in-window on-contract rows
    expect(fold.deliveredRows).toBe(1);
    expect(fold.outsideWindow).toBe(1);
    expect(fold.invalidRows).toBe(1);
    expect(fold.cells.size).toBe(2);
    expect(fold.cells.get('uncertain')).toMatchObject({ from: 'uncertain', rows: 1 });
    expect(fold.cells.get('sending')).toMatchObject({ from: 'sending', rows: 1 });
  });
});

describe('cosReconcileCells', () => {
  it('emits a cell only at the row, day and distinct-id bars', () => {
    // 3 rows, 2 days, but all one delivery id → below the distinct-id bar
    const sameId = [
      row({ atMs: NOW_MS - DAY, id: 'd1', from: 'uncertain' }),
      row({ atMs: NOW_MS - DAY + HOUR, id: 'd1', from: 'uncertain' }),
      row({ atMs: NOW_MS - 2 * DAY, id: 'd1', from: 'uncertain' }),
    ].join('\n');
    expect(cosReconcileCells(foldCosReconcileRows(sameId, { nowMs: NOW_MS }))).toHaveLength(0);
    // 3 rows across 3 days and 3 deliveries → cell
    const cells = cosReconcileCells(foldCosReconcileRows(recurringRetry().join('\n'), { nowMs: NOW_MS }));
    expect(cells).toHaveLength(1);
    expect(cells[0]).toMatchObject({
      from: 'uncertain', rows: COS_RECONCILE_MIN_RETRIES,
      ids: COS_RECONCILE_MIN_IDS + 1,
      records: COS_RECONCILE_MIN_RETRIES, deliveredContext: 0,
    });
    expect(cells[0]!.days.length).toBeGreaterThanOrEqual(COS_RECONCILE_MIN_DAYS);
    // 3 rows all on one UTC day → below the day bar
    const sameDay = [
      row({ atMs: Date.parse('2026-11-20T01:00:00Z'), id: 'd1' }),
      row({ atMs: Date.parse('2026-11-20T05:00:00Z'), id: 'd2' }),
      row({ atMs: Date.parse('2026-11-20T09:00:00Z'), id: 'd3' }),
    ].join('\n');
    expect(cosReconcileCells(foldCosReconcileRows(sameDay, { nowMs: NOW_MS }))).toHaveLength(0);
    // 2 rows across 2 days → below MIN_RETRIES
    const two = [
      row({ atMs: NOW_MS - DAY, id: 'd1' }),
      row({ atMs: NOW_MS - 2 * DAY, id: 'd2' }),
    ].join('\n');
    expect(cosReconcileCells(foldCosReconcileRows(two, { nowMs: NOW_MS }))).toHaveLength(0);
  });

  it('splits cells by from state and never emits delivered verdicts', () => {
    const text = [
      ...recurringRetry('uncertain'),
      ...recurringRetry('sending'),
      // A delivered-verdict storm never forms a cell.
      row({ atMs: NOW_MS - DAY, id: 'd21', verdict: 'delivered' }),
      row({ atMs: NOW_MS - 2 * DAY, id: 'd22', verdict: 'delivered' }),
      row({ atMs: NOW_MS - 3 * DAY, id: 'd23', verdict: 'delivered' }),
    ].join('\n');
    const cells = cosReconcileCells(foldCosReconcileRows(text, { nowMs: NOW_MS }));
    expect(cells.map((c) => c.from)).toEqual(['sending', 'uncertain']);
    expect(cells[0]!.deliveredContext).toBe(3);
    expect(cells[0]!.records).toBe(9);
  });

  it('marks cells lowerBound when told the tail truncated', () => {
    const fold = foldCosReconcileRows(recurringRetry().join('\n'), { nowMs: NOW_MS });
    expect(cosReconcileCells(fold, true)[0]!.lowerBound).toBe(true);
    expect(cosReconcileCells(fold, false)[0]!.lowerBound).toBe(false);
  });
});

describe('cosReconcileBacklogItems', () => {
  it('emits an item for the fleet repo only', async () => {
    const file = writeLedger(recurringRetry());
    expect(await cosReconcileBacklogItems({ repo: 'someone/else', journalPath: file, now: NOW })).toEqual([]);
    const items = await cosReconcileBacklogItems({ repo: 'AshlrAI/Phantom', journalPath: file, now: NOW });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ repo: 'AshlrAI/Phantom', area: 'cos-reconcile-uncertain', priority: 3 });
    expect(items[0]!.id).toMatch(/^cos-reconcile-uncertain-/);
    expect(validBacklogItem(items[0]!)).not.toBeNull();
  });

  it('never emits delivery ids into prompts', async () => {
    const file = writeLedger(recurringRetry());
    const items = await cosReconcileBacklogItems({ repo: REPO, journalPath: file, now: NOW });
    expect(items).toHaveLength(1);
    for (const id of ['d11', 'd12', 'd13']) {
      expect(items[0]!.prompt).not.toContain(id);
    }
    expect(items[0]!.prompt).toContain('3 distinct delivery(ies)');
    expect(items[0]!.prompt).toContain("'uncertain'");
  });

  it('yields nothing for a missing or malformed journal', async () => {
    expect(await cosReconcileBacklogItems({ repo: REPO, journalPath: join(home, 'nope.jsonl'), now: NOW })).toEqual([]);
    const file = writeLedger(['not json', '{"id":"d1"}']);
    expect(await cosReconcileBacklogItems({ repo: REPO, journalPath: file, now: NOW })).toEqual([]);
  });

  it('states a lower bound when the byte tail truncated the ledger', async () => {
    // Pad the ledger past the 256 KiB read bound with healthy rows, then
    // append the recurring retry cell inside the retained tail.
    const noise: string[] = [];
    for (let i = 0; i < 3200; i += 1) {
      noise.push(row({ atMs: NOW_MS - HOUR, id: `n${i}`, verdict: 'delivered' }));
    }
    const file = writeLedger([...noise, ...recurringRetry()]);
    expect(statSync(file).size).toBeGreaterThan(COS_RECONCILE_TAIL_BYTES);
    const items = await cosReconcileBacklogItems({ repo: REPO, journalPath: file, now: NOW });
    const cell = items.find((i) => i.area === 'cos-reconcile-uncertain');
    expect(cell).toBeDefined();
    expect(cell!.prompt).toContain('lower bound');
  });

  it('derives stable ids so a refresh re-adds nothing', async () => {
    const file = writeLedger(recurringRetry());
    const first = await cosReconcileBacklogItems({ repo: REPO, journalPath: file, now: NOW });
    const second = await cosReconcileBacklogItems({ repo: REPO, journalPath: file, now: NOW });
    expect(first).toHaveLength(1);
    expect(second.map((i) => i.id)).toEqual(first.map((i) => i.id));
  });

  it('reads the default ledger path under the runs dir', async () => {
    writeLedger(recurringRetry(), 'custom-runs');
    const items = await cosReconcileBacklogItems({ repo: REPO, runsDir: join(home, 'custom-runs'), now: NOW });
    expect(items).toHaveLength(1);
  });

  it('appends cos-reconcile items through discovery and dedupes on refresh', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    try {
      // discoverBacklog calls the feed with no path overrides, so the feed
      // resolves <realHome()>/.ashlr-runs — under vitest the process-home
      // fixture makes realHome() follow process.env.HOME, so relocate HOME
      // to this test's temp dir and place the ledger at .ashlr-runs/cos.
      process.env['HOME'] = home;
      const dir = join(home, '.ashlr-runs', 'cos');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'reconcile.jsonl'), recurringRetry().join('\n') + '\n');
      const greenGh = async (args: string[]) => {
        const p = args[4] ?? '';
        if (p === 'repos/ashlrai/phantom') return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n{"default_branch":"master"}', stderr: '' };
        return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n[]', stderr: '' };
      };
      const first = await discoverBacklog(REPO, { gh: greenGh });
      const landed = first.items.filter((i) => i.id.startsWith('cos-reconcile-'));
      expect(landed.length).toBeGreaterThanOrEqual(1);
      expect(first.items.every((i) => validBacklogItem(i) !== null)).toBe(true);
      expect(appendUserBacklogItems(landed)).toBe(landed.length);
      const second = await discoverBacklog(REPO, { gh: greenGh });
      expect(appendUserBacklogItems(second.items.filter((i) => i.id.startsWith('cos-reconcile-')))).toBe(0);
      expect(readUserBacklogItems().filter((i) => i.id.startsWith('cos-reconcile-'))).toHaveLength(landed.length);
    } finally {
      vi.useRealTimers();
    }
  });
});
