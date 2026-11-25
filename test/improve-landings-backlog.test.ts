import { mkdtempSync, mkdirSync, rmSync, appendFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  LANDINGS_BACKLOG_MAX_ITEMS,
  LANDINGS_WINDOW_HOURS,
  foldLandingsCells,
  foldLandingsRows,
  landingsBacklogItems,
  landingsCells,
} from '../src/core/improve/landings-backlog.js';
import { validBacklogItem } from '../src/core/cloud/backlog.js';

const DAY = 86_400_000;
const HOUR = 3_600_000;

/** Fixed evaluation instant; the folds take it as an argument and never read the wall clock. */
const NOW_MS = Date.parse('2026-11-23T12:00:00.000Z');
const CUTOFF_MS = NOW_MS - LANDINGS_WINDOW_HOURS * HOUR;
const iso = (ms: number): string => new Date(ms).toISOString();

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const SHA_C = 'c'.repeat(40);
const BUNDLE = 'd'.repeat(64);
const PR_URL = 'https://github.com/ashlrai/phantom/pull/42';

/**
 * One devin-land row exactly as landDevinSession's appendLedger writes
 * it. `spec.raw` overrides are spelled out per test for contract breaks.
 */
function landRow(spec: {
  at?: number;
  sessionId?: string;
  repo?: string;
  job?: string;
  result?: string;
  pr?: string | null;
  autoMerge?: Record<string, unknown> | null;
  taskId?: string | null;
  commits?: number;
  raw?: Record<string, unknown>;
} = {}): string {
  const row: Record<string, unknown> = {
    v: 1,
    kind: 'devin-land',
    at: iso(spec.at ?? NOW_MS - DAY),
    sessionId: spec.sessionId ?? 'devin-s1',
    repo: spec.repo ?? 'ashlrai/phantom',
    job: spec.job ?? 'DEVIN-s1',
    branch: 'codex-bridge/DEVIN-s1',
    base: SHA_A,
    mergeBase: SHA_B,
    tip: SHA_C,
    commits: spec.commits ?? 2,
    bundleSha256: BUNDLE,
    result: spec.result ?? `RESULT PR ${PR_URL}`,
    pr: spec.pr === undefined ? PR_URL : spec.pr,
    autoMerge: spec.autoMerge === undefined ? { armed: true, detail: 'gh pr merge --auto --squash --match-head-commit' } : spec.autoMerge,
    taskId: spec.taskId === undefined ? 'task-1' : spec.taskId,
  };
  return JSON.stringify({ ...row, ...spec.raw });
}

/** A publish-* row: the mechanical land completed but no PR opened. */
function noPrRow(result: string, sessionId: string, at: number, job?: string): string {
  return landRow({ sessionId, at, job, result, pr: null, autoMerge: null, taskId: null });
}

/** A merge-* row: the PR opened; autoMerge carries the arm outcome. */
function mergeRow(autoMerge: Record<string, unknown>, sessionId: string, at: number, pr = PR_URL): string {
  return landRow({ sessionId, at, pr, autoMerge });
}

/**
 * n adverse rows for n distinct sessions across two distinct UTC days —
 * the recurring fixture: the first half on the recent day, the rest the
 * day before, every session distinct.
 */
function recurringRows(emit: (sessionId: string, at: number) => string, sessions = ['devin-s1', 'devin-s2', 'devin-s3']): string[] {
  const rows: string[] = [];
  sessions.slice(0, 2).forEach((s, i) => rows.push(emit(s, NOW_MS - DAY - i * HOUR)));
  sessions.slice(1).forEach((s, i) => rows.push(emit(s, NOW_MS - 2 * DAY - i * HOUR)));
  return rows;
}

describe('foldLandingsRows', () => {
  it('keeps contract-valid in-window rows and classifies adverse vs context', () => {
    const { rows, invalid } = foldLandingsRows([
      noPrRow('RESULT EMPTY', 'devin-e1', NOW_MS - DAY),
      mergeRow({ armed: false, reasonCode: 'arm-refused', detail: 'arm-refused: publish result head SHA is unknown; left for the next guarded pass.' }, 'devin-m1', NOW_MS - 2 * DAY),
      mergeRow({ armed: true, detail: 'gh pr merge --auto --squash --match-head-commit' }, 'devin-ok1', NOW_MS - HOUR),
      mergeRow({ armed: false, detail: 'publish.sh flagged sensitive paths (src/secrets); left for Security review' }, 'devin-hold1', NOW_MS - HOUR),
    ].join('\n'), CUTOFF_MS, NOW_MS);
    expect(invalid).toBe(0);
    expect(rows).toHaveLength(4);
    const bySession = new Map(rows.map((r) => [r.sessionId, r]));
    expect(bySession.get('devin-e1')?.kind).toBe('publish-empty');
    expect(bySession.get('devin-m1')?.kind).toBe('arm-refused');
    // Healthy arm and the sensitive-paths designed hold are context: kind null.
    expect(bySession.get('devin-ok1')?.kind).toBeNull();
    expect(bySession.get('devin-hold1')?.kind).toBeNull();
  });

  it('classifies every adverse kind and the publish result split', () => {
    const parsed = (line: string) => {
      const { rows } = foldLandingsRows(line, CUTOFF_MS, NOW_MS);
      return rows[0]?.kind ?? null;
    };
    // publish-* split on the RESULT head.
    expect(parsed(noPrRow('RESULT EMPTY', 'devin-p1', NOW_MS - DAY))).toBe('publish-empty');
    expect(parsed(noPrRow('RESULT ABORT gate refused', 'devin-p2', NOW_MS - DAY))).toBe('publish-refused');
    expect(parsed(noPrRow('RESULT DENIED policy', 'devin-p3', NOW_MS - DAY))).toBe('publish-refused');
    expect(parsed(noPrRow('', 'devin-p4', NOW_MS - DAY))).toBe('publish-unparsed');
    expect(parsed(noPrRow('RESULT PR https://github.com/ashlrai/other-repo/pull/9', 'devin-p5', NOW_MS - DAY))).toBe('publish-unparsed');
    // merge-* split on the recorded arm detail.
    expect(parsed(mergeRow({ armed: false, reasonCode: 'arm-refused', detail: 'arm-refused: head SHA unknown' }, 'devin-m1', NOW_MS - DAY))).toBe('arm-refused');
    expect(parsed(mergeRow({ armed: false, detail: 'gh pr merge failed: HTTP 403' }, 'devin-m2', NOW_MS - DAY))).toBe('gh-merge-failed');
    expect(parsed(mergeRow({ armed: false, detail: 'quota exhausted on the connected account' }, 'devin-m3', NOW_MS - DAY))).toBe('merge-unclassified');
    // Designed holds and healthy arms are context.
    expect(parsed(mergeRow({ armed: false, detail: 'NOTE AUTO_MERGE skipped: red CI' }, 'devin-h1', NOW_MS - DAY))).toBeNull();
    expect(parsed(mergeRow({ armed: false, detail: 'NOTE AUTO_MERGE deferred to arm_gate.py' }, 'devin-h2', NOW_MS - DAY))).toBeNull();
    expect(parsed(mergeRow({ armed: true, detail: 'already armed by publish.sh' }, 'devin-h3', NOW_MS - DAY))).toBeNull();
  });

  it('skips out-of-window and future-skewed rows without counting them invalid', () => {
    const { rows, invalid } = foldLandingsRows([
      noPrRow('RESULT EMPTY', 'devin-old', NOW_MS - LANDINGS_WINDOW_HOURS * HOUR - DAY),
      noPrRow('RESULT EMPTY', 'devin-future', NOW_MS + 2 * 60_000),
      noPrRow('RESULT EMPTY', 'devin-in', NOW_MS - DAY),
    ].join('\n'), CUTOFF_MS, NOW_MS);
    expect(rows.map((r) => r.sessionId)).toEqual(['devin-in']);
    expect(invalid).toBe(0);
  });

  it('counts malformed lines and contract violations as invalid', () => {
    const { rows, invalid } = foldLandingsRows([
      'not json at all',
      JSON.stringify({ v: 2, kind: 'devin-land' }),
      landRow({ sessionId: 'not a devin id!!', raw: {} }),
      landRow({ raw: { pr: 42 } }),
      landRow({ raw: { autoMerge: { armed: 'yes', detail: 'x' } } }),
      noPrRow('RESULT EMPTY', 'devin-ok', NOW_MS - DAY),
    ].join('\n'), CUTOFF_MS, NOW_MS);
    expect(rows).toHaveLength(1);
    expect(invalid).toBe(5);
  });
});

describe('landingsCells', () => {
  it('emits only at the distinct-session and distinct-day bars', () => {
    const foldOf = (lines: string[]) => foldLandingsCells(foldLandingsRows(lines.join('\n'), CUTOFF_MS, NOW_MS).rows);
    // Two sessions across two days: under the unit bar.
    expect(landingsCells(foldOf(recurringRows(
      (s, at) => noPrRow('RESULT EMPTY', s, at), ['devin-a', 'devin-b'],
    )))).toEqual([]);
    // Three rows but one session: retries of one session are one unit.
    const sameSession = [0, 1, 2].map((i) => noPrRow('RESULT EMPTY', 'devin-solo', NOW_MS - (i + 1) * DAY));
    expect(landingsCells(foldOf(sameSession))).toEqual([]);
    // Three sessions across two days: emits.
    const cells = landingsCells(foldOf(recurringRows(
      (s, at) => noPrRow('RESULT EMPTY', s, at),
    )));
    expect(cells).toHaveLength(1);
    expect(cells[0]?.kind).toBe('publish-empty');
    expect(cells[0]?.units).toBe(3);
    expect(cells[0]?.days).toEqual([iso(NOW_MS - 2 * DAY).slice(0, 10), iso(NOW_MS - DAY).slice(0, 10)]);
    expect(cells[0]?.lowerBound).toBe(false);
    expect(cells[0]?.invalid).toBe(0);
  });

  it('keeps the kinds separate and sorts worst-first', () => {
    const lines = [
      ...recurringRows((s, at) => noPrRow('RESULT EMPTY', s, at)),
      ...recurringRows((s, at) => mergeRow({ armed: false, detail: 'gh pr merge failed: HTTP 403' }, s, at), ['devin-g1', 'devin-g2', 'devin-g3']),
    ];
    const cells = landingsCells(foldLandingsCells(foldLandingsRows(lines.join('\n'), CUTOFF_MS, NOW_MS).rows));
    expect(cells.map((c) => c.kind).sort()).toEqual(['gh-merge-failed', 'publish-empty']);
  });
});

describe('landingsBacklogItems', () => {
  let journalDir: string;
  let journalPath: string;

  beforeEach(() => {
    journalDir = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'ashlr-landings-backlog-')));
    journalPath = path.join(journalDir, 'landings.jsonl');
  });

  afterEach(() => {
    rmSync(journalDir, { recursive: true, force: true });
  });

  function writeJournal(lines: string[]): void {
    writeFileSync(journalPath, `${lines.join('\n')}\n`, 'utf8');
  }

  it('emits nothing for another repository, a missing journal, or an unreadable path', async () => {
    writeJournal(recurringRows((s, at) => noPrRow('RESULT EMPTY', s, at)));
    expect(await landingsBacklogItems({ repo: 'ashlrai/other-repo', now: NOW_MS, journalPath })).toEqual([]);
    expect(await landingsBacklogItems({ repo: 'ashlrai/phantom', now: NOW_MS, journalPath: path.join(journalDir, 'absent.jsonl') })).toEqual([]);
    // A directory where the journal should be is 'not-file': fail closed.
    expect(await landingsBacklogItems({ repo: 'ashlrai/phantom', now: NOW_MS, journalPath: journalDir })).toEqual([]);
    expect(await landingsBacklogItems({ repo: '', now: NOW_MS, journalPath })).toEqual([]);
  });

  it('emits nothing when no cell reaches the recurring bars', async () => {
    writeJournal([
      ...recurringRows((s, at) => noPrRow('RESULT EMPTY', s, at), ['devin-a', 'devin-b']),
      mergeRow({ armed: true, detail: 'gh pr merge --auto --squash --match-head-commit' }, 'devin-ok', NOW_MS - DAY),
      mergeRow({ armed: false, detail: 'publish.sh flagged sensitive paths (x)' }, 'devin-hold', NOW_MS - DAY),
    ]);
    expect(await landingsBacklogItems({ repo: 'ashlrai/phantom', now: NOW_MS, journalPath })).toEqual([]);
  });

  it('emits one stable item per recurring cell with recorded detail', async () => {
    writeJournal([
      ...recurringRows((s, at) => noPrRow('RESULT EMPTY', s, at)),
      ...recurringRows(
        (s, at) => mergeRow({ armed: false, reasonCode: 'arm-refused', detail: 'arm-refused: publish result head SHA is unknown; left for the next guarded pass.' }, s, at),
        ['devin-r1', 'devin-r2', 'devin-r3'],
      ),
    ]);
    const items = await landingsBacklogItems({ repo: 'ashlrai/phantom', now: NOW_MS, journalPath });
    expect(items).toHaveLength(2);
    for (const item of items) {
      expect(validBacklogItem(item)).not.toBeNull();
      expect(item.repo).toBe('ashlrai/phantom');
      expect(item.area).toBe('devin-landings');
      expect(item.priority).toBe(3);
      expect(item.prompt).toContain('landings.jsonl');
      expect(item.prompt).toContain('7-day window');
    }
    // Stable ids: a refresh re-derives the same items.
    const again = await landingsBacklogItems({ repo: 'ashlrai/phantom', now: NOW_MS, journalPath });
    expect(again.map((i) => i.id)).toEqual(items.map((i) => i.id));
    const publish = items.find((i) => i.title.includes('publishing empty'));
    expect(publish?.prompt).toContain('RESULT EMPTY');
    expect(publish?.prompt).toContain('devin-s1');
    const arm = items.find((i) => i.title.includes('head SHA'));
    expect(arm?.prompt).toContain('arm-refused');
    expect(arm?.prompt).toContain(PR_URL);
  });

  it('respects the item limit', async () => {
    const lines: string[] = [
      ...recurringRows((s, at) => noPrRow('RESULT EMPTY', s, at)),
      ...recurringRows((s, at) => mergeRow({ armed: false, detail: 'gh pr merge failed: HTTP 403' }, s, at), ['devin-g1', 'devin-g2', 'devin-g3']),
      ...recurringRows((s, at) => mergeRow({ armed: false, detail: 'quota exhausted' }, s, at), ['devin-u1', 'devin-u2', 'devin-u3']),
    ];
    writeJournal(lines);
    const capped = await landingsBacklogItems({ repo: 'ashlrai/phantom', now: NOW_MS, journalPath, limit: 1 });
    expect(capped).toHaveLength(1);
    const all = await landingsBacklogItems({ repo: 'ashlrai/phantom', now: NOW_MS, journalPath });
    expect(all).toHaveLength(3);
    expect(all.length).toBeLessThanOrEqual(LANDINGS_BACKLOG_MAX_ITEMS);
  });

  it('scrubs secret-shaped text out of quoted details', async () => {
    const token = `ghp_${'a1b2c3d4e5f6'.repeat(3)}`;
    writeJournal(recurringRows(
      (s, at) => mergeRow({ armed: false, detail: `gh pr merge failed: auth ${token}` }, s, at),
      ['devin-sec1', 'devin-sec2', 'devin-sec3'],
    ));
    const items = await landingsBacklogItems({ repo: 'ashlrai/phantom', now: NOW_MS, journalPath });
    expect(items).toHaveLength(1);
    expect(items[0]?.prompt).toContain('[REDACTED]');
    expect(items[0]?.prompt).not.toContain(token);
  });

  it('emits one item for every adverse kind at the bars', async () => {
    const emitters: Record<string, (s: string, at: number) => string> = {
      'publish-empty': (s, at) => noPrRow('RESULT EMPTY', s, at),
      'publish-refused': (s, at) => noPrRow('RESULT ABORT gate', s, at),
      'publish-unparsed': (s, at) => noPrRow('', s, at),
      'arm-refused': (s, at) => mergeRow({ armed: false, reasonCode: 'arm-refused', detail: 'arm-refused: no head SHA' }, s, at),
      'gh-merge-failed': (s, at) => mergeRow({ armed: false, detail: 'gh pr merge failed: boom' }, s, at),
      'merge-unclassified': (s, at) => mergeRow({ armed: false, detail: 'some future hold reason' }, s, at),
    };
    const lines: string[] = [];
    for (const [kind, emit] of Object.entries(emitters)) {
      // Session ids must satisfy the writer's Devin pattern (devin-* or 32-hex).
      lines.push(...recurringRows(emit, [`devin-${kind}-a`, `devin-${kind}-b`, `devin-${kind}-c`]));
    }
    writeJournal(lines);
    const items = await landingsBacklogItems({ repo: 'ashlrai/phantom', now: NOW_MS, journalPath });
    expect(items).toHaveLength(Object.keys(emitters).length);
    expect(new Set(items.map((i) => i.title)).size).toBe(items.length);
    for (const item of items) {
      expect(validBacklogItem(item)).not.toBeNull();
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
  tmpHome = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'ashlr-landings-e2e-')));
  process.env.HOME = tmpHome;
  process.env.ASHLR_HOME = path.join(tmpHome, '.ashlr');
});

afterEach(() => {
  rmSync(tmpHome, { recursive: true, force: true });
  process.env.HOME = origHome;
  if (origAshlrHome === undefined) delete process.env.ASHLR_HOME;
  else process.env.ASHLR_HOME = origAshlrHome;
});

describe('landingsBacklogItems end-to-end', () => {
  it('reads devin/landings.jsonl under ASHLR_HOME without a path override', async () => {
    const dir = path.join(tmpHome, '.ashlr', 'devin');
    mkdirSync(dir, { recursive: true });
    const now = Date.now();
    const rows = recurringRows(
      (s, at) => noPrRow('RESULT ABORT publish gate', s, at),
      ['devin-e2e-1', 'devin-e2e-2', 'devin-e2e-3'],
    ).map((line, i) => {
      // Re-stamp onto the live clock so the e2e window sees them.
      const row = JSON.parse(line) as Record<string, unknown>;
      row['at'] = new Date(now - (i < 2 ? DAY : 2 * DAY) - i * HOUR).toISOString();
      return JSON.stringify(row);
    });
    appendFileSync(path.join(dir, 'landings.jsonl'), `${rows.join('\n')}\n`, 'utf8');
    const items = await landingsBacklogItems({ repo: 'ashlrai/phantom' });
    expect(items).toHaveLength(1);
    expect(items[0]?.title).toContain('refused');
    expect(validBacklogItem(items[0])).not.toBeNull();
  });

  it('emits nothing when the devin directory is absent', async () => {
    const items = await landingsBacklogItems({ repo: 'ashlrai/phantom' });
    expect(items).toEqual([]);
  });
});
