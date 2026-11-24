import { mkdtempSync, mkdirSync, rmSync, appendFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AUTOLAND_BACKLOG_MAX_ITEMS,
  AUTOLAND_MIN_DAYS,
  AUTOLAND_MIN_UNITS,
  AUTOLAND_WINDOW_HOURS,
  autolandBacklogItems,
  autolandCells,
  foldAutolandCells,
  foldAutolandRows,
} from '../src/core/improve/autoland-backlog.js';
import { validBacklogItem } from '../src/core/cloud/backlog.js';

const DAY = 86_400_000;
const HOUR = 3_600_000;

/** Fixed evaluation instant; the folds take it as an argument and never read the wall clock. */
const NOW_MS = Date.parse('2026-11-23T12:00:00.000Z');
const CUTOFF_MS = NOW_MS - AUTOLAND_WINDOW_HOURS * HOUR;
const iso = (ms: number): string => new Date(ms).toISOString();

/** One DevinAutolandDecision row exactly as runDevinAutoland's record() appends it. */
function decision(spec: {
  decision?: string;
  at?: number;
  passId?: string;
  sessionId?: string | null;
  pr?: string;
  supersededPr?: string;
  repo?: string;
  error?: string;
  mode?: string;
  reason?: string;
  /** Contract-breaking overrides, spelled out per test. */
  raw?: Record<string, unknown>;
} = {}): string {
  const row: Record<string, unknown> = {
    v: 1,
    kind: 'devin-autoland',
    at: iso(spec.at ?? NOW_MS - DAY),
    passId: spec.passId ?? 'pass-1',
    mode: spec.mode ?? 'apply',
    decision: spec.decision ?? 'land-failed',
    reason: spec.reason ?? 'The landing failed.',
  };
  if (spec.sessionId !== null && spec.sessionId !== undefined) row['sessionId'] = spec.sessionId;
  if (spec.pr !== undefined) row['pr'] = spec.pr;
  if (spec.supersededPr !== undefined) row['supersededPr'] = spec.supersededPr;
  if (spec.repo !== undefined) row['repo'] = spec.repo;
  if (spec.error !== undefined) row['error'] = spec.error;
  return JSON.stringify({ ...row, ...spec.raw });
}

/** n land-failed rows for one session on consecutive days ending `endDayOffset` days ago. */
function landingSeries(sessionId: string, days: number, endDayOffset: number, passId = 'pass-x'): string[] {
  const rows: string[] = [];
  for (let d = 0; d < days; d++) {
    rows.push(decision({
      decision: 'land-failed', sessionId, passId,
      at: NOW_MS - (endDayOffset + d) * DAY - HOUR,
      error: `bundle publish failed for ${sessionId}`,
    }));
  }
  return rows;
}

/**
 * Distinct sessions failing across two distinct UTC days — the
 * recurring landing fixture: two sessions on the recent day, a
 * different pair the day before, three units in all.
 */
function recurringLanding(sessions = ['devin-s1', 'devin-s2', 'devin-s3']): string[] {
  const rows: string[] = [];
  sessions.slice(0, 2).forEach((s, i) => rows.push(decision({
    decision: 'land-failed', sessionId: s, passId: `pass-a${i}`,
    at: NOW_MS - DAY - i * HOUR, error: `publish failed for ${s}`,
  })));
  sessions.slice(1).forEach((s, i) => rows.push(decision({
    decision: 'land-failed', sessionId: s, passId: `pass-b${i}`,
    at: NOW_MS - 2 * DAY - i * HOUR, error: `publish failed for ${s}`,
  })));
  return rows;
}

describe('foldAutolandRows', () => {
  it('keeps contract-valid adverse rows inside the window', () => {
    const { rows, invalid } = foldAutolandRows([
      decision({ decision: 'land-failed', sessionId: 'devin-s1' }),
      decision({ decision: 'pass-failed', at: NOW_MS - 2 * HOUR, error: 'listSessions exploded' }),
      decision({ decision: 'no-identity', at: NOW_MS - HOUR }),
    ].join('\n'), CUTOFF_MS, NOW_MS);
    expect(rows).toHaveLength(3);
    expect(invalid).toBe(0);
    expect(rows.map((r) => r.kind).sort()).toEqual(['identity', 'landing', 'pass']);
    // Pass-scoped rows fall back to the pass id as their unit.
    expect(rows.find((r) => r.kind === 'pass')?.unit).toBe('pass-1');
  });

  it('skips contract-valid success, pacing and deliberate-state rows without counting them invalid', () => {
    const decisions = [
      'landed', 'would-land', 'archived', 'would-archive', 'superseded',
      'would-close-superseded', 'already-landed', 'backoff', 'supersede-backoff',
      'cap-reached', 'killed', 'paused', 'scanned', 'a-future-decision',
    ];
    const { rows, invalid } = foldAutolandRows(
      decisions.map((d) => decision({ decision: d, sessionId: 'devin-s1' })).join('\n'),
      CUTOFF_MS, NOW_MS,
    );
    expect(rows).toEqual([]);
    // 'a-future-decision' is not in the recorded vocabulary: contract-valid
    // shape but an unknown decision is still skipped, not guessed — and not
    // counted as a malformed line either since decision is just a string.
    expect(invalid).toBe(0);
  });

  it('counts malformed lines and contract violations as invalid', () => {
    const { rows, invalid } = foldAutolandRows([
      'not json at all',
      JSON.stringify({ v: 1, kind: 'devin-autoland' }), // missing everything else
      decision({ raw: { v: 2 } }),
      decision({ raw: { kind: 'other-journal' } }),
      decision({ raw: { at: 'not-a-date' } }),
      decision({ raw: { passId: '' } }),
      decision({ raw: { passId: 42 } }),
      decision({ mode: 'bogus' }),
      decision({ raw: { decision: '' } }),
      decision({ raw: { reason: 7 } }),
      decision({ decision: 'land-failed', sessionId: 'devin-ok' }),
    ].join('\n'), CUTOFF_MS, NOW_MS);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.sessionId).toBe('devin-ok');
    expect(invalid).toBe(10);
  });

  it('drops rows outside the window and beyond the future skew', () => {
    const { rows, invalid } = foldAutolandRows([
      decision({ decision: 'land-failed', sessionId: 'devin-old', at: CUTOFF_MS - 1 }),
      decision({ decision: 'land-failed', sessionId: 'devin-far', at: NOW_MS + 2 * 60_000 }),
      decision({ decision: 'land-failed', sessionId: 'devin-edge', at: CUTOFF_MS }),
      decision({ decision: 'land-failed', sessionId: 'devin-skew', at: NOW_MS + 30_000 }),
    ].join('\n'), CUTOFF_MS, NOW_MS);
    expect(invalid).toBe(0);
    expect(rows.map((r) => r.sessionId).sort()).toEqual(['devin-edge', 'devin-skew']);
  });
});

describe('autolandCells', () => {
  it('emits only at the recurring bars: distinct units across distinct UTC days', () => {
    const text = (lines: string[]) => lines.join('\n');
    // Below the unit bar: two sessions across two days.
    const underUnits = foldAutolandRows(text([
      ...landingSeries('devin-s1', 1, 1),
      ...landingSeries('devin-s2', 1, 2),
    ]), CUTOFF_MS, NOW_MS);
    expect(autolandCells(foldAutolandCells(underUnits.rows))).toEqual([]);
    // Below the day bar: three sessions, all on one UTC day.
    const underDays = foldAutolandRows(text([
      decision({ decision: 'land-failed', sessionId: 'devin-s1', at: NOW_MS - DAY - HOUR }),
      decision({ decision: 'land-failed', sessionId: 'devin-s2', at: NOW_MS - DAY - 2 * HOUR }),
      decision({ decision: 'land-failed', sessionId: 'devin-s3', at: NOW_MS - DAY - 3 * HOUR }),
    ]), CUTOFF_MS, NOW_MS);
    expect(autolandCells(foldAutolandCells(underDays.rows))).toEqual([]);
    // At the bars: three sessions across two days.
    const across = foldAutolandRows(text(recurringLanding()), CUTOFF_MS, NOW_MS);
    const cells = autolandCells(foldAutolandCells(across.rows));
    expect(cells).toHaveLength(1);
    expect(cells[0]?.kind).toBe('landing');
    expect(cells[0]?.units).toBe(AUTOLAND_MIN_UNITS);
    expect(cells[0]?.days).toHaveLength(AUTOLAND_MIN_DAYS);
    expect(cells[0]?.firstSeen).not.toBeNull();
    expect(cells[0]?.lastSeen).not.toBeNull();
  });

  it('folds terminal gave-up rows into their path cell with their own tally', () => {
    const rows = foldAutolandRows([
      decision({ decision: 'land-failed', sessionId: 'devin-s1', at: NOW_MS - DAY - HOUR, error: 'e1' }),
      decision({ decision: 'gave-up', sessionId: 'devin-s2', at: NOW_MS - 2 * DAY - HOUR }),
      decision({ decision: 'land-failed', sessionId: 'devin-s3', at: NOW_MS - 2 * DAY - 2 * HOUR, error: 'e2' }),
    ].join('\n'), CUTOFF_MS, NOW_MS);
    const cells = autolandCells(foldAutolandCells(rows.rows));
    expect(cells).toHaveLength(1);
    expect(cells[0]?.kind).toBe('landing');
    expect(cells[0]?.rows).toBe(3);
    expect(cells[0]?.units).toBe(3);
    expect(cells[0]?.terminal).toBe(1);
  });

  it('counts pass ids as the unit for pass-scoped kinds', () => {
    const rows = foldAutolandRows([
      decision({ decision: 'pass-failed', passId: 'pass-1', at: NOW_MS - DAY - HOUR, error: 'boom-1' }),
      decision({ decision: 'pass-failed', passId: 'pass-1', at: NOW_MS - DAY - 2 * HOUR, error: 'boom-1' }),
      decision({ decision: 'pass-failed', passId: 'pass-2', at: NOW_MS - 2 * DAY - HOUR, error: 'boom-2' }),
      decision({ decision: 'pass-failed', passId: 'pass-3', at: NOW_MS - 2 * DAY - 2 * HOUR, error: 'boom-3' }),
    ].join('\n'), CUTOFF_MS, NOW_MS);
    const cells = autolandCells(foldAutolandCells(rows.rows));
    expect(cells).toHaveLength(1);
    expect(cells[0]?.kind).toBe('pass');
    expect(cells[0]?.rows).toBe(4);
    expect(cells[0]?.units).toBe(3);
    expect(cells[0]?.sessions).toEqual([]);
  });

  it('keeps supersede-close evidence with its repo and PR references', () => {
    const rows = foldAutolandRows([
      decision({
        decision: 'pending-supersede', sessionId: 'devin-s1', passId: 'p1',
        pr: '#9002', supersededPr: '#8990', repo: 'phantom',
        at: NOW_MS - DAY - HOUR, error: 'gh pr close failed: protected branch',
      }),
      decision({
        decision: 'supersede-gave-up', sessionId: 'devin-s2', passId: 'p2',
        pr: '#9003', supersededPr: '#8991', repo: 'phantom',
        at: NOW_MS - 2 * DAY - HOUR,
      }),
      decision({
        decision: 'pending-supersede', sessionId: 'devin-s3', passId: 'p3',
        pr: '#9004', supersededPr: '#8992', repo: 'phantom',
        at: NOW_MS - 2 * DAY - 2 * HOUR, error: 'gh pr close failed: HTTP 502',
      }),
    ].join('\n'), CUTOFF_MS, NOW_MS);
    const cells = autolandCells(foldAutolandCells(rows.rows));
    expect(cells).toHaveLength(1);
    const cell = cells[0];
    expect(cell?.kind).toBe('supersede-close');
    expect(cell?.terminal).toBe(1);
    expect(cell?.repos).toEqual([{ text: 'phantom', count: 3 }]);
    // The close target (supersededPr) is quoted before the replacement pr.
    expect(cell?.prs[0]).toBe('#8990');
    expect(cell?.prs).toContain('#8991');
    expect(cell?.errors).toContain('gh pr close failed: protected branch');
  });

  it('sorts emitted cells worst-first and marks a truncated tail a lower bound', () => {
    const rows = foldAutolandRows([
      // landing: 4 rows / 3 units / 2 days.
      ...recurringLanding(),
      // pass: 5 rows / 4 units / 2 days — strictly worse, sorts first.
      decision({ decision: 'pass-failed', passId: 'pass-1', at: NOW_MS - DAY - HOUR, error: 'a' }),
      decision({ decision: 'pass-failed', passId: 'pass-1', at: NOW_MS - DAY - 2 * HOUR, error: 'a' }),
      decision({ decision: 'pass-failed', passId: 'pass-2', at: NOW_MS - 2 * DAY - HOUR, error: 'b' }),
      decision({ decision: 'pass-failed', passId: 'pass-3', at: NOW_MS - 2 * DAY - 2 * HOUR, error: 'c' }),
      decision({ decision: 'pass-failed', passId: 'pass-4', at: NOW_MS - 2 * DAY - 3 * HOUR, error: 'd' }),
    ].join('\n'), CUTOFF_MS, NOW_MS);
    const folds = foldAutolandCells(rows.rows);
    const cells = autolandCells(folds);
    expect(cells.map((c) => c.kind)).toEqual(['pass', 'landing']);
    expect(cells[0]?.lowerBound).toBe(false);
    expect(autolandCells(folds, true).every((c) => c.lowerBound)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// autolandBacklogItems — journalPath-injected
// ---------------------------------------------------------------------------

describe('autolandBacklogItems', () => {
  let journalDir: string;
  let journalPath: string;

  beforeEach(() => {
    journalDir = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'ashlr-autoland-backlog-')));
    journalPath = path.join(journalDir, 'autoland.jsonl');
  });

  afterEach(() => {
    rmSync(journalDir, { recursive: true, force: true });
  });

  function writeJournal(lines: string[]): void {
    writeFileSync(journalPath, `${lines.join('\n')}\n`, 'utf8');
  }

  it('emits nothing for another repository, a missing journal, or an unreadable path', async () => {
    writeJournal(recurringLanding());
    expect(await autolandBacklogItems({ repo: 'ashlrai/other-repo', now: NOW_MS, journalPath })).toEqual([]);
    expect(await autolandBacklogItems({ repo: 'ashlrai/phantom', now: NOW_MS, journalPath: path.join(journalDir, 'absent.jsonl') })).toEqual([]);
    // A directory where the journal should be is 'not-file': fail closed.
    expect(await autolandBacklogItems({ repo: 'ashlrai/phantom', now: NOW_MS, journalPath: journalDir })).toEqual([]);
    expect(await autolandBacklogItems({ repo: '', now: NOW_MS, journalPath })).toEqual([]);
  });

  it('emits nothing when no cell reaches the recurring bars', async () => {
    writeJournal([
      ...landingSeries('devin-s1', 2, 1),
      decision({ decision: 'landed', sessionId: 'devin-s1', passId: 'p', pr: '#1' }),
      decision({ decision: 'killed', passId: 'p2' }),
    ]);
    expect(await autolandBacklogItems({ repo: 'ashlrai/phantom', now: NOW_MS, journalPath })).toEqual([]);
  });

  it('emits one stable item per recurring cell with recorded detail', async () => {
    writeJournal([
      ...recurringLanding(),
      // A second kind at the bars: three sessions missing attachments across two days.
      decision({ decision: 'missing-attachments', sessionId: 'devin-m1', passId: 'p1', at: NOW_MS - DAY - HOUR }),
      decision({ decision: 'missing-attachments', sessionId: 'devin-m2', passId: 'p2', at: NOW_MS - DAY - 2 * HOUR }),
      decision({ decision: 'missing-attachments', sessionId: 'devin-m3', passId: 'p3', at: NOW_MS - 2 * DAY - HOUR }),
    ]);
    const items = await autolandBacklogItems({ repo: 'ashlrai/phantom', now: NOW_MS, journalPath });
    expect(items).toHaveLength(2);
    for (const item of items) {
      expect(validBacklogItem(item)).not.toBeNull();
      expect(item.repo).toBe('ashlrai/phantom');
      expect(item.area).toBe('devin-autoland');
      expect(item.priority).toBe(3);
      expect(item.prompt).toContain('autoland.jsonl');
      expect(item.prompt).toContain('7-day window');
    }
    // Stable ids: a refresh re-derives the same items.
    const again = await autolandBacklogItems({ repo: 'ashlrai/phantom', now: NOW_MS, journalPath });
    expect(again.map((i) => i.id)).toEqual(items.map((i) => i.id));
    const landing = items.find((i) => i.title.includes('land'));
    expect(landing?.prompt).toContain('devin-s1');
    expect(landing?.prompt).toContain('publish failed for devin-s1');
    const missing = items.find((i) => i.title.includes('attachments'));
    expect(missing?.prompt).toContain('devin-m1');
    expect(missing?.prompt).toContain('missing-attachments');
  });

  it('respects the item limit', async () => {
    const lines: string[] = [...recurringLanding()];
    // pass: 5 rows / 4 units / 2 days — more rows than landing's 4, sorts first.
    lines.push(
      decision({ decision: 'pass-failed', passId: 'pass-1', at: NOW_MS - DAY - HOUR, error: 'a' }),
      decision({ decision: 'pass-failed', passId: 'pass-1', at: NOW_MS - DAY - 2 * HOUR, error: 'a' }),
      decision({ decision: 'pass-failed', passId: 'pass-2', at: NOW_MS - 2 * DAY - HOUR, error: 'b' }),
      decision({ decision: 'pass-failed', passId: 'pass-3', at: NOW_MS - 2 * DAY - 2 * HOUR, error: 'c' }),
      decision({ decision: 'pass-failed', passId: 'pass-4', at: NOW_MS - 2 * DAY - 3 * HOUR, error: 'd' }),
    );
    writeJournal(lines);
    const capped = await autolandBacklogItems({ repo: 'ashlrai/phantom', now: NOW_MS, journalPath, limit: 1 });
    expect(capped).toHaveLength(1);
    expect(capped[0]?.title).toContain('pass');
    const all = await autolandBacklogItems({ repo: 'ashlrai/phantom', now: NOW_MS, journalPath });
    expect(all).toHaveLength(2);
  });

  it('scrubs secret-shaped text out of quoted errors', async () => {
    const token = `ghp_${'a1b2c3d4e5f6'.repeat(3)}`;
    writeJournal([
      decision({ decision: 'land-failed', sessionId: 'devin-s1', at: NOW_MS - DAY - HOUR, error: `auth failed with ${token}` }),
      decision({ decision: 'land-failed', sessionId: 'devin-s2', at: NOW_MS - DAY - 2 * HOUR, error: `auth failed with ${token}` }),
      decision({ decision: 'land-failed', sessionId: 'devin-s3', at: NOW_MS - 2 * DAY - HOUR, error: `auth failed with ${token}` }),
    ]);
    const items = await autolandBacklogItems({ repo: 'ashlrai/phantom', now: NOW_MS, journalPath });
    expect(items).toHaveLength(1);
    expect(items[0]?.prompt).toContain('[REDACTED]');
    expect(items[0]?.prompt).not.toContain(token);
  });

  it('emits one item for every adverse kind at the bars', async () => {
    // One emitter per cell kind; session-scoped kinds key on sessionId,
    // pass-scoped kinds (pass, identity) key on passId.
    const emitters: Record<string, (unit: string, at: number) => string> = {
      landing: (u, at) => decision({ decision: 'land-failed', sessionId: u, passId: 'px', at, error: 'e' }),
      'supersede-close': (u, at) => decision({ decision: 'pending-supersede', sessionId: u, passId: 'px', at, pr: '#9', supersededPr: '#8', repo: 'phantom', error: 'e' }),
      archive: (u, at) => decision({ decision: 'archive-failed', sessionId: u, passId: 'px', at, error: 'e' }),
      attachments: (u, at) => decision({ decision: 'missing-attachments', sessionId: u, passId: 'px', at }),
      session: (u, at) => decision({ decision: 'session-failed', sessionId: u, passId: 'px', at, error: 'e' }),
      pass: (u, at) => decision({ decision: 'pass-failed', passId: u, at, error: 'e' }),
      identity: (u, at) => decision({ decision: 'no-identity', passId: u, at }),
    };
    const lines: string[] = [];
    for (const [kind, emit] of Object.entries(emitters)) {
      const units = [`${kind}-a`, `${kind}-b`, `${kind}-c`];
      units.slice(0, 2).forEach((u, i) => lines.push(emit(u, NOW_MS - DAY - i * HOUR)));
      units.slice(1).forEach((u, i) => lines.push(emit(u, NOW_MS - 2 * DAY - i * HOUR)));
    }
    writeJournal(lines);
    const items = await autolandBacklogItems({ repo: 'ashlrai/phantom', now: NOW_MS, journalPath });
    expect(items).toHaveLength(Object.keys(emitters).length);
    expect(items.length).toBeLessThanOrEqual(AUTOLAND_BACKLOG_MAX_ITEMS);
    expect(new Set(items.map((i) => i.title)).size).toBe(items.length);
    for (const item of items) {
      expect(validBacklogItem(item)).not.toBeNull();
      expect(item.area).toBe('devin-autoland');
      expect(item.priority).toBe(3);
    }
  });
});

// ---------------------------------------------------------------------------
// End-to-end: the real devinHome() path under a relocated ASHLR_HOME
// ---------------------------------------------------------------------------

const origHome = process.env.HOME;
const origAshlrHome = process.env.ASHLR_HOME;
let tmpHome: string;

beforeEach(() => {
  tmpHome = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'ashlr-autoland-e2e-')));
  process.env.HOME = tmpHome;
  process.env.ASHLR_HOME = path.join(tmpHome, '.ashlr');
});

afterEach(() => {
  rmSync(tmpHome, { recursive: true, force: true });
  process.env.HOME = origHome;
  if (origAshlrHome === undefined) delete process.env.ASHLR_HOME;
  else process.env.ASHLR_HOME = origAshlrHome;
});

describe('autolandBacklogItems end-to-end', () => {
  it('reads devin/autoland.jsonl under ASHLR_HOME without a path override', async () => {
    const dir = path.join(tmpHome, '.ashlr', 'devin');
    mkdirSync(dir, { recursive: true });
    const now = Date.now();
    const rows = [0, 1, 2].flatMap((i) => [
      decision({ decision: 'archive-failed', sessionId: `devin-e2e-${i}`, passId: `pe${i}`, at: now - DAY - i * HOUR, error: 'terminate refused' }),
      decision({ decision: 'archive-failed', sessionId: `devin-e2e-${i}`, passId: `pe${i}`, at: now - 2 * DAY - i * HOUR, error: 'terminate refused' }),
    ]);
    appendFileSync(path.join(dir, 'autoland.jsonl'), `${rows.join('\n')}\n`, 'utf8');
    const items = await autolandBacklogItems({ repo: 'ashlrai/phantom' });
    expect(items).toHaveLength(1);
    expect(items[0]?.title).toContain('archive');
    expect(validBacklogItem(items[0])).not.toBeNull();
  });

  it('emits nothing when the devin directory is absent', async () => {
    const items = await autolandBacklogItems({ repo: 'ashlrai/phantom' });
    expect(items).toEqual([]);
  });
});
