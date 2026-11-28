import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  WORKED_LEDGER_BACKLOG_MAX_ITEMS,
  WORKED_LEDGER_WINDOW_HOURS,
  foldWorkedLedger,
  workedLedgerBacklogItems,
  workedLedgerCells,
} from '../src/core/improve/worked-ledger-backlog.js';
import { discoverBacklog } from '../src/core/improve/discover.js';
import { appendUserBacklogItems, readUserBacklogItems, validBacklogItem } from '../src/core/cloud/backlog.js';
import type { WorkedEvent, WorkedLedgerReadResult, WorkedOutcome } from '../src/core/fleet/worked-ledger.js';

const HOUR = 3_600_000;
const DAY = 86_400_000;

/** Fixed reference instant; fixture timestamps are ISO-8601 UTC like the writer's. */
const NOW_MS = Date.parse('2026-11-23T12:00:00.000Z');
const WINDOW_MS = WORKED_LEDGER_WINDOW_HOURS * HOUR;
const iso = (ms: number): string => new Date(ms).toISOString();

/** One worked-ledger event in the writer's {itemId, outcome, ts} shape. */
function workedEvent(spec: {
  itemId?: string;
  outcome?: WorkedOutcome;
  atMs?: number;
  ts?: string | null;
  proposalId?: string;
} = {}): WorkedEvent {
  const atMs = spec.atMs ?? NOW_MS;
  const ts = spec.ts === undefined ? iso(atMs) : spec.ts;
  return {
    itemId: spec.itemId ?? 'scanner:ci:abc123',
    outcome: spec.outcome ?? 'empty',
    ts: ts as string,
    ...(spec.proposalId !== undefined ? { proposalId: spec.proposalId } : {}),
  };
}

/**
 * `count` distinct items hitting `outcome`, spread across `days` UTC days —
 * the recurring shape a cell needs. `base` anchors the series so callers
 * can place it relative to any clock.
 */
function outcomeSeries(
  outcome: WorkedOutcome,
  opts: { items?: number; days?: number; atMs?: number } = {},
): WorkedEvent[] {
  const items = opts.items ?? 3;
  const days = opts.days ?? 2;
  const base = opts.atMs ?? NOW_MS;
  const events: WorkedEvent[] = [];
  for (let i = 0; i < items; i++) {
    events.push(workedEvent({
      itemId: `item-${outcome}-${i}`,
      outcome,
      atMs: base - (i % days) * DAY - i * HOUR,
    }));
  }
  return events;
}

/** A healthy strict-read result wrapping the given events. */
function healthyRead(events: WorkedEvent[], bytesRead = 4096): WorkedLedgerReadResult {
  return {
    ledger: { events },
    sourceQuality: { sourceState: 'healthy', sourcePresent: true, complete: true, reasons: [], bytesRead },
  };
}

describe('foldWorkedLedger', () => {
  it('folds contract-valid events per outcome inside the window', () => {
    const events = [
      workedEvent({ itemId: 'a', outcome: 'empty', atMs: NOW_MS - HOUR }),
      workedEvent({ itemId: 'b', outcome: 'empty', atMs: NOW_MS - DAY }),
      workedEvent({ itemId: 'c', outcome: 'diff', atMs: NOW_MS - 2 * HOUR }),
      workedEvent({ itemId: 'd', outcome: 'judged-decline', atMs: NOW_MS - 3 * HOUR, proposalId: 'prop-1' }),
      // Out of window — normal aging counts nowhere.
      workedEvent({ itemId: 'old', outcome: 'empty', atMs: NOW_MS - WINDOW_MS - DAY }),
      workedEvent({ itemId: 'future', outcome: 'empty', atMs: NOW_MS + HOUR }),
      // Undated or foreign — counted, never folded.
      workedEvent({ itemId: 'undated', outcome: 'empty', ts: 'not-a-date' }),
      workedEvent({ itemId: 'notstring', outcome: 'empty', ts: null }),
      workedEvent({ itemId: '', outcome: 'empty' }),
      workedEvent({ itemId: 'x'.repeat(300), outcome: 'empty' }),
      workedEvent({ itemId: 'ctrl\nchar', outcome: 'empty' }),
      workedEvent({ itemId: 'badoutcome', outcome: 'bogus' as WorkedOutcome }),
      'not-an-event' as unknown as WorkedEvent,
      null as unknown as WorkedEvent,
    ];
    const fold = foldWorkedLedger(events, NOW_MS, WINDOW_MS);
    const empty = fold.outcomes.get('empty')!;
    expect(empty.rows).toBe(2);
    expect(empty.itemIds.size).toBe(2);
    expect(empty.days.size).toBe(2);
    expect(empty.firstMs).toBe(NOW_MS - DAY);
    expect(empty.lastMs).toBe(NOW_MS - HOUR);
    const diff = fold.outcomes.get('diff')!;
    expect(diff.rows).toBe(1);
    const decline = fold.outcomes.get('judged-decline')!;
    expect(decline.proposalIds.size).toBe(1);
    expect(decline.proposalIds.has('prop-1')).toBe(true);
    // Eight rows failed shape or timestamp placement; the far-past and
    // future rows aged out of the window entirely and count nowhere.
    expect(fold.undated).toBe(8);
    expect(fold.markers).toBe(0);
    expect(fold.sweptProposals.size).toBe(0);
  });

  it('excludes swept-proposal markers as bookkeeping but keeps their proposal ids', () => {
    const events = [
      workedEvent({ itemId: 'real-item', outcome: 'judged-noise', atMs: NOW_MS - HOUR }),
      workedEvent({ itemId: '__swept_proposal__:prop-9', outcome: 'judged-noise', atMs: NOW_MS - HOUR, proposalId: 'prop-9' }),
      workedEvent({ itemId: '__swept_proposal__:prop-10', outcome: 'judged-decline', atMs: NOW_MS - 2 * DAY, proposalId: 'prop-10' }),
      // A marker outside the window contributes nothing.
      workedEvent({ itemId: '__swept_proposal__:prop-old', outcome: 'judged-noise', atMs: NOW_MS - WINDOW_MS - DAY, proposalId: 'prop-old' }),
      // A marker carrying no usable proposalId still counts as a marker only.
      workedEvent({ itemId: '__swept_proposal__:', outcome: 'judged-noise', atMs: NOW_MS - HOUR }),
    ];
    const fold = foldWorkedLedger(events, NOW_MS, WINDOW_MS);
    expect(fold.markers).toBe(3);
    expect(fold.sweptProposals.get('judged-noise')?.has('prop-9')).toBe(true);
    expect(fold.sweptProposals.get('judged-decline')?.has('prop-10')).toBe(true);
    expect(fold.sweptProposals.get('judged-noise')?.has('prop-old')).toBe(false);
    // The real item row is the only judged-noise outcome evidence; the
    // prop-10 marker leaves no judged-decline outcome row at all.
    const noise = fold.outcomes.get('judged-noise')!;
    expect(noise.rows).toBe(1);
    expect(noise.itemIds.size).toBe(1);
    expect(fold.outcomes.get('judged-decline')).toBeUndefined();
  });

  it('keeps example ids prompt-safe and bounded', () => {
    const events = [
      workedEvent({ itemId: 'safe-id-1', outcome: 'empty', atMs: NOW_MS - HOUR }),
      workedEvent({ itemId: 'has space', outcome: 'empty', atMs: NOW_MS - 2 * HOUR }),
      workedEvent({ itemId: 'safe-id-2', outcome: 'empty', atMs: NOW_MS - DAY }),
      workedEvent({ itemId: 'safe-id-3', outcome: 'empty', atMs: NOW_MS - 2 * DAY }),
      workedEvent({ itemId: 'safe-id-4', outcome: 'empty', atMs: NOW_MS - 3 * DAY }),
    ];
    const fold = foldWorkedLedger(events, NOW_MS, WINDOW_MS);
    const empty = fold.outcomes.get('empty')!;
    expect(empty.examples).toEqual(['safe-id-1', 'safe-id-2', 'safe-id-3']);
    expect(empty.itemIds.size).toBe(5);
  });
});

describe('workedLedgerCells', () => {
  it('emits only at the distinct-item and distinct-day bars', () => {
    // Below bars: too few distinct items even across enough days.
    const twoItems = [
      workedEvent({ itemId: 'i1', outcome: 'empty', atMs: NOW_MS - DAY }),
      workedEvent({ itemId: 'i2', outcome: 'empty', atMs: NOW_MS - 2 * DAY }),
      workedEvent({ itemId: 'i1', outcome: 'empty', atMs: NOW_MS - 3 * DAY }),
    ];
    expect(workedLedgerCells(foldWorkedLedger(twoItems, NOW_MS, WINDOW_MS))).toEqual([]);

    // Below bars: enough distinct items but all on one UTC day.
    const sameDay = [
      workedEvent({ itemId: 'i1', outcome: 'dispatch-blocked', atMs: NOW_MS - HOUR }),
      workedEvent({ itemId: 'i2', outcome: 'dispatch-blocked', atMs: NOW_MS - 2 * HOUR }),
      workedEvent({ itemId: 'i3', outcome: 'dispatch-blocked', atMs: NOW_MS - 3 * HOUR }),
    ];
    const sameDayFold = foldWorkedLedger(sameDay, NOW_MS, WINDOW_MS);
    expect(sameDayFold.outcomes.get('dispatch-blocked')!.days.size).toBe(1);
    expect(workedLedgerCells(sameDayFold)).toEqual([]);

    // At the bars: emits one cell per qualifying adverse outcome.
    const events = [
      ...outcomeSeries('empty', { items: 3, days: 2 }),
      ...outcomeSeries('judged-decline', { items: 4, days: 2 }),
      workedEvent({ itemId: 'healthy', outcome: 'diff', atMs: NOW_MS - HOUR }),
    ];
    const cells = workedLedgerCells(foldWorkedLedger(events, NOW_MS, WINDOW_MS));
    expect(cells.map((c) => c.outcome).sort()).toEqual(['empty', 'judged-decline']);
    const decline = cells.find((c) => c.outcome === 'judged-decline')!;
    expect(decline.items).toBe(4);
    expect(decline.days).toBe(2);
    expect(decline.sweptProposals).toBe(0);
    expect(decline.sweptExamples).toEqual([]);
    // 'diff' never cells — it is the healthy contrast.
    expect(cells.some((c) => (c.outcome as WorkedOutcome) === 'diff')).toBe(false);
  });
});

describe('workedLedgerBacklogItems', () => {
  let home: string;
  let saved: { HOME?: string; ASHLR_HOME?: string; ASHLR_RUNS_DIR?: string };

  beforeEach(async () => {
    saved = { HOME: process.env.HOME, ASHLR_HOME: process.env.ASHLR_HOME, ASHLR_RUNS_DIR: process.env.ASHLR_RUNS_DIR };
    delete process.env.ASHLR_HOME;
    delete process.env.ASHLR_RUNS_DIR;
    home = await mkdtemp(join(tmpdir(), 'worked-ledger-backlog-'));
    process.env.HOME = home;
  });
  afterEach(async () => {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    await rm(home, { recursive: true, force: true });
  });

  const opts = { repo: 'ashlrai/phantom', now: new Date(NOW_MS) };

  it('emits one grounded item per recurring adverse outcome', async () => {
    const events = [
      ...outcomeSeries('empty', { items: 4, days: 3 }),
      ...outcomeSeries('judged-noise', { items: 3, days: 2 }),
      // A regular item row carrying a proposal id — item evidence, not a marker.
      workedEvent({ itemId: 'noise-extra', outcome: 'judged-noise', atMs: NOW_MS - DAY, proposalId: 'prop-x' }),
      // Its sweep dedup marker: bookkeeping, never a fourth item.
      workedEvent({ itemId: '__swept_proposal__:prop-x', outcome: 'judged-noise', atMs: NOW_MS - DAY, proposalId: 'prop-x' }),
      workedEvent({ itemId: 'healthy-1', outcome: 'diff', atMs: NOW_MS - HOUR }),
      workedEvent({ itemId: 'aged-out-row', outcome: 'empty', atMs: NOW_MS - WINDOW_MS - DAY }),
    ];
    const items = await workedLedgerBacklogItems({ ...opts, ledger: () => healthyRead(events) });
    expect(items).toHaveLength(2);
    const empty = items.find((i) => i.title.includes("'empty'"))!;
    const noise = items.find((i) => i.title.includes('noise'))!;
    expect(empty).toMatchObject({ area: 'worked-outcomes', priority: 3, repo: 'ashlrai/phantom' });
    expect(validBacklogItem(empty)).not.toBeNull();
    expect(validBacklogItem(noise)).not.toBeNull();
    expect(empty.id).toMatch(/^fleet-worked-[0-9a-f]{16}$/);
    expect(empty.prompt).toContain('worked.json');
    expect(empty.prompt).toContain('recordOutcome');
    expect(empty.prompt).toContain('sweepJudgedProposals');
    expect(empty.prompt).toContain('no-change');
    expect(empty.prompt).toContain('distinct item(s)');
    // Yield context: the diff row is quoted as the healthy contrast.
    expect(empty.prompt).toContain("'diff'");
    // Marker bookkeeping is named, and the swept proposal id is quoted.
    expect(noise.prompt).toContain('marker row(s)');
    expect(noise.prompt).toContain('prop-x');
    // The out-of-window row never reaches the prompt's counts.
    expect(empty.prompt).not.toContain('aged-out-row');
  });

  it('emits nothing for missing, foreign-repo, below-bar or healthy-only evidence', async () => {
    const missing: WorkedLedgerReadResult = {
      ledger: { events: [] },
      sourceQuality: { sourceState: 'missing', sourcePresent: false, complete: false, reasons: ['source-missing'], bytesRead: 0 },
    };
    expect(await workedLedgerBacklogItems({ ...opts, ledger: () => missing })).toEqual([]);

    const belowBar = healthyRead(outcomeSeries('empty', { items: 2, days: 3 }));
    expect(await workedLedgerBacklogItems({ ...opts, ledger: () => belowBar })).toEqual([]);

    const diffsOnly = healthyRead(outcomeSeries('diff', { items: 5, days: 3 }));
    expect(await workedLedgerBacklogItems({ ...opts, ledger: () => diffsOnly })).toEqual([]);

    const foreign = await workedLedgerBacklogItems({
      ...opts, repo: 'ashlrai/lexicon',
      ledger: () => healthyRead(outcomeSeries('empty', { items: 4, days: 3 })),
    });
    expect(foreign).toEqual([]);
    expect(await workedLedgerBacklogItems({ ...opts, repo: '', ledger: () => healthyRead([]) })).toEqual([]);
  });

  it('emits one degraded item naming the recorded reasons', async () => {
    const degraded: WorkedLedgerReadResult = {
      ledger: { events: [] },
      sourceQuality: { sourceState: 'degraded', sourcePresent: true, complete: false, reasons: ['invalid-ledger'], bytesRead: 0 },
    };
    const items = await workedLedgerBacklogItems({ ...opts, ledger: () => degraded });
    expect(items).toHaveLength(1);
    const item = items[0]!;
    expect(item).toMatchObject({ area: 'worked-ledger', priority: 3, repo: 'ashlrai/phantom' });
    expect(validBacklogItem(item)).not.toBeNull();
    expect(item.id).toMatch(/^fleet-worked-[0-9a-f]{16}$/);
    expect(item.prompt).toContain('degraded');
    expect(item.prompt).toContain('invalid-ledger');
    expect(item.prompt).toContain('worked.json');
    expect(item.prompt).toContain('loadWorkedLedgerDetailed');
    expect(item.prompt).toContain('no-change');

    // An incomplete healthy read degrades the same way — never a partial fold.
    const incomplete: WorkedLedgerReadResult = {
      ledger: { events: outcomeSeries('empty', { items: 5, days: 3 }) },
      sourceQuality: { sourceState: 'healthy', sourcePresent: true, complete: false, reasons: ['unstable-read'], bytesRead: 0 },
    };
    const incompleteItems = await workedLedgerBacklogItems({ ...opts, ledger: () => incomplete });
    expect(incompleteItems).toHaveLength(1);
    expect(incompleteItems[0]!.area).toBe('worked-ledger');
    expect(incompleteItems[0]!.prompt).not.toContain("'empty' outcomes");
  });

  it('reports undated events honestly inside the prompt', async () => {
    const events = [
      ...outcomeSeries('empty', { items: 3, days: 2 }),
      workedEvent({ itemId: 'undated-1', outcome: 'empty', ts: 'garbage' }),
    ];
    const items = await workedLedgerBacklogItems({ ...opts, ledger: () => healthyRead(events) });
    expect(items).toHaveLength(1);
    expect(items[0]!.prompt).toContain('no parseable timestamp');
  });

  it('derives stable ids and honours the limit', async () => {
    const read = () => healthyRead([
      ...outcomeSeries('empty', { items: 4, days: 3 }),
      ...outcomeSeries('judged-decline', { items: 4, days: 2 }),
      ...outcomeSeries('dispatch-blocked', { items: 3, days: 2 }),
    ]);
    const first = await workedLedgerBacklogItems({ ...opts, ledger: read });
    const second = await workedLedgerBacklogItems({ ...opts, ledger: read });
    expect(first.length).toBeGreaterThan(1);
    expect(second.map((i) => i.id)).toEqual(first.map((i) => i.id));
    const limited = await workedLedgerBacklogItems({ ...opts, ledger: read, limit: 1 });
    expect(limited).toHaveLength(1);
    expect(limited[0]!.id).toBe(first[0]!.id);
    const hard = await workedLedgerBacklogItems({ ...opts, ledger: read, limit: WORKED_LEDGER_BACKLOG_MAX_ITEMS });
    expect(hard.length).toBeLessThanOrEqual(WORKED_LEDGER_BACKLOG_MAX_ITEMS);
  });

  it('is total: a throwing reader or malformed read yields no items', async () => {
    expect(await workedLedgerBacklogItems({ ...opts, ledger: () => { throw new Error('boom'); } })).toEqual([]);
    expect(await workedLedgerBacklogItems({ ...opts, ledger: () => ({ ledger: null, sourceQuality: null }) as unknown as WorkedLedgerReadResult })).toEqual([]);
  });

  it('reads the real ledger file under the relocated home', async () => {
    // workedLedgerPath() resolves ~/.ashlr/fleet/worked.json through
    // homedir(), which the relocated HOME above controls; default perms
    // satisfy the custody checks (regular file, no group/other write).
    const dir = join(home, '.ashlr', 'fleet');
    await mkdir(dir, { recursive: true });
    const events = [
      ...outcomeSeries('empty', { items: 4, days: 3 }),
      workedEvent({ itemId: 'diff-row', outcome: 'diff', atMs: NOW_MS - HOUR }),
    ];
    await writeFile(join(dir, 'worked.json'), JSON.stringify({ events }));
    const items = await workedLedgerBacklogItems({ repo: 'ashlrai/phantom', now: new Date(NOW_MS) });
    expect(items).toHaveLength(1);
    expect(items[0]!.area).toBe('worked-outcomes');
    expect(items[0]!.prompt).toContain('worked.json');
  });

  it('emits the degraded item for a corrupt real ledger', async () => {
    const dir = join(home, '.ashlr', 'fleet');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'worked.json'), '{"events": "not-an-array"}');
    const items = await workedLedgerBacklogItems({ repo: 'ashlrai/phantom' });
    expect(items).toHaveLength(1);
    expect(items[0]!.area).toBe('worked-ledger');
    expect(items[0]!.prompt).toContain('invalid-ledger');
  });

  it('emits nothing for a missing real ledger', async () => {
    expect(await workedLedgerBacklogItems({ repo: 'ashlrai/phantom' })).toEqual([]);
  });

  it('appends worked-ledger items through discovery and dedupes on refresh', async () => {
    // discoverBacklog has no clock option, so the fixture anchors on the
    // real now — the fold's window must still contain it whenever this
    // suite runs.
    const base = Date.now();
    const events = [0, 1, 2, 3].map((i) => workedEvent({
      itemId: `dyn-empty-${i}`,
      outcome: 'empty',
      atMs: base - (i % 3) * DAY - i * HOUR,
    }));
    const dir = join(home, '.ashlr', 'fleet');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'worked.json'), JSON.stringify({ events }));
    const greenGh = async (args: string[]) => {
      const p = args[4] ?? '';
      if (p === 'repos/ashlrai/phantom') return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n{"default_branch":"master"}', stderr: '' };
      return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n[]', stderr: '' };
    };
    const first = await discoverBacklog('ashlrai/phantom', { gh: greenGh });
    const workedItems = first.items.filter((i) => i.id.startsWith('fleet-worked-'));
    expect(workedItems).toHaveLength(1);
    expect(workedItems[0]!.area).toBe('worked-outcomes');
    expect(first.items.every((i) => validBacklogItem(i) !== null)).toBe(true);
    expect(appendUserBacklogItems(workedItems)).toBe(1);
    const second = await discoverBacklog('ashlrai/phantom', { gh: greenGh });
    expect(appendUserBacklogItems(second.items.filter((i) => i.id.startsWith('fleet-worked-')))).toBe(0);
    expect(readUserBacklogItems().filter((i) => i.id.startsWith('fleet-worked-'))).toHaveLength(1);
  });
});
