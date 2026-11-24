import { mkdtempSync, mkdirSync, rmSync, appendFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { JudgeTrace, JudgeTracesReadResult } from '../src/core/fleet/judge-trace.js';
import {
  foldJudgeTraces,
  JUDGE_MIN_DAYS,
  JUDGE_SHIP_ADVERSE_MIN,
  JUDGE_WINDOW_MS,
  judgeAdverseCells,
  judgeBacklogItems,
} from '../src/core/improve/judge-backlog.js';
import { validBacklogItem } from '../src/core/cloud/backlog.js';

const DAY = 86_400_000;
const HOUR = 3_600_000;

/** Fixed evaluation instant for the injected-read tests; the fold never reads the wall clock. */
const NOW_MS = Date.parse('2026-11-23T12:00:00.000Z');
const iso = (ms: number): string => new Date(ms).toISOString();

/** One materialized trace in the reader's output shape; valid unless a field breaks the contract. */
function trace(spec: {
  engine?: string;
  verdict?: JudgeTrace['verdict'];
  ts?: string;
  outcome?: JudgeTrace['outcome'];
  outcomeBasis?: JudgeTrace['outcomeBasis'];
  outcomeAt?: string;
  proposalId?: string;
} = {}): JudgeTrace {
  return {
    schemaVersion: 2,
    traceId: `jt-${spec.proposalId ?? 'p'}-${spec.ts ?? NOW_MS}-${spec.engine ?? 'e'}`,
    proposalId: spec.proposalId ?? 'p-1',
    judgeEngine: spec.engine ?? 'engine-a',
    verdict: spec.verdict ?? 'ship',
    scores: { value: 4, correctness: 4, scope: 4, alignment: 4 },
    fullReasoning: '',
    promptContext: '',
    reasoningState: 'not-persisted',
    promptContextState: 'not-persisted',
    ts: spec.ts ?? iso(NOW_MS - DAY),
    ...(spec.outcome !== undefined ? { outcome: spec.outcome } : {}),
    ...(spec.outcomeBasis !== undefined ? { outcomeBasis: spec.outcomeBasis } : {}),
    ...(spec.outcomeAt !== undefined ? { outcomeAt: spec.outcomeAt } : {}),
  };
}

/** n rejected ship verdicts for one engine spread across `days` distinct UTC days ending NOW_MS. */
function rejectedSeries(engine: string, days: number, perDay: number, verdict: JudgeTrace['verdict'] = 'ship'): JudgeTrace[] {
  const rows: JudgeTrace[] = [];
  for (let d = 0; d < days; d++) {
    for (let i = 0; i < perDay; i++) {
      const at = NOW_MS - d * DAY - i * HOUR;
      rows.push(trace({
        engine,
        verdict,
        proposalId: `p-${engine}-${d}-${i}`,
        ts: iso(at - HOUR),
        outcome: 'rejected',
        outcomeAt: iso(at),
      }));
    }
  }
  return rows;
}

function readResult(traces: JudgeTrace[], overrides: Partial<JudgeTracesReadResult> = {}): JudgeTracesReadResult {
  return {
    sourceState: 'healthy',
    sourcePresent: true,
    complete: true,
    stopReasons: [],
    filesRead: 1,
    bytesRead: 1024,
    rowsScanned: traces.length,
    invalidRows: 0,
    unreadableFiles: 0,
    traces,
    ...overrides,
  };
}

const inject = (traces: JudgeTrace[], overrides: Partial<JudgeTracesReadResult> = {}) =>
  () => readResult(traces, overrides);

describe('foldJudgeTraces', () => {
  it('folds qualified outcomes per engine and anchors the window on outcomeAt ?? ts', () => {
    const folds = foldJudgeTraces([
      // Ship verdict judged 10 days ago, rejected yesterday: outcomeAt anchors it inside the window.
      trace({ engine: 'old-judge', ts: iso(NOW_MS - 10 * DAY), outcome: 'rejected', outcomeAt: iso(NOW_MS - DAY) }),
      // Ship verdict judged yesterday, rejected 10 days ago: outcomeAt anchors it outside.
      trace({ engine: 'stale', ts: iso(NOW_MS - DAY), outcome: 'rejected', outcomeAt: iso(NOW_MS - 10 * DAY) }),
      // No outcome: counts as a trace but never resolved.
      trace({ engine: 'old-judge', ts: iso(NOW_MS - HOUR) }),
    ], NOW_MS, JUDGE_WINDOW_MS);

    const oldJudge = folds.get('old-judge');
    expect(oldJudge?.traces).toBe(2);
    expect(oldJudge?.resolved).toBe(1);
    expect(oldJudge?.shipRejected).toBe(1);
    expect(oldJudge?.adverseDays.size).toBe(1);
    expect(folds.has('stale')).toBe(false);
  });

  it('skips unqualified outcomes and empty engines without guessing', () => {
    const folds = foldJudgeTraces([
      // 'merged' without released credit is unqualified: no outcome tallies at all.
      trace({ engine: 'e', outcome: 'merged', outcomeBasis: 'realized-merge-v1', outcomeAt: iso(NOW_MS - HOUR) }),
      // 'merged' with released basis still needs the signed credit token; the bare label never qualifies.
      trace({ engine: 'e', outcome: 'merged', outcomeBasis: 'post-merge-credit-release-v1', outcomeAt: iso(NOW_MS - HOUR) }),
      // Incompatible basis is unqualified.
      trace({ engine: 'e', outcome: 'rejected', outcomeBasis: 'post-merge-observation-v1', outcomeAt: iso(NOW_MS - HOUR) }),
      // Rejected with the proposal-rejection basis qualifies.
      trace({ engine: 'e', outcome: 'rejected', outcomeBasis: 'proposal-rejection-v1', outcomeAt: iso(NOW_MS - HOUR) }),
      // Reverted with the observation basis qualifies; without a basis it also qualifies (legacy rows).
      trace({ engine: 'e', outcome: 'reverted', outcomeBasis: 'post-merge-observation-v1', outcomeAt: iso(NOW_MS - HOUR) }),
      trace({ engine: 'e', outcome: 'followed-up', outcomeAt: iso(NOW_MS - HOUR) }),
      // Blank engine contributes nothing.
      trace({ engine: '   ', outcome: 'rejected', outcomeAt: iso(NOW_MS - HOUR) }),
      // Undated trace (no outcomeAt, unparsable ts) contributes nothing.
      trace({ engine: 'e', outcome: 'rejected', ts: 'not-a-date' }),
    ], NOW_MS, JUDGE_WINDOW_MS);

    const cell = folds.get('e');
    expect(cell?.traces).toBe(6);
    expect(cell?.resolved).toBe(3);
    expect(cell?.shipReverted).toBe(1);
    expect(cell?.shipFollowedUp).toBe(1);
    expect(cell?.shipRejected).toBe(1);
    expect(cell?.nonShipResolved).toBe(0);
  });

  it('tallies non-ship verdict outcomes as context, never the adverse cell', () => {
    const folds = foldJudgeTraces([
      ...rejectedSeries('engine-a', 2, JUDGE_SHIP_ADVERSE_MIN).slice(0, JUDGE_SHIP_ADVERSE_MIN),
      trace({ engine: 'engine-a', verdict: 'review', outcome: 'rejected', outcomeAt: iso(NOW_MS - HOUR) }),
      trace({ engine: 'engine-a', verdict: 'noise', outcome: 'rejected', outcomeAt: iso(NOW_MS - 2 * HOUR) }),
    ], NOW_MS, JUDGE_WINDOW_MS);

    const cell = folds.get('engine-a');
    expect(cell?.shipRejected).toBe(JUDGE_SHIP_ADVERSE_MIN);
    expect(cell?.nonShipResolved).toBe(2);
  });
});

describe('judgeAdverseCells', () => {
  it('emits only at the recurring bars: enough adverse outcomes across enough distinct days', () => {
    // Count bar: two adverse outcomes across two days is still below the minimum.
    const underCount = foldJudgeTraces(
      rejectedSeries('engine-a', JUDGE_MIN_DAYS, 1),
      NOW_MS,
      JUDGE_WINDOW_MS,
    );
    expect(judgeAdverseCells(underCount)).toEqual([]);
    // Day bar: the minimum count recorded on a single UTC day is not recurring.
    const underDays = foldJudgeTraces(
      rejectedSeries('engine-a', 1, JUDGE_SHIP_ADVERSE_MIN),
      NOW_MS,
      JUDGE_WINDOW_MS,
    );
    expect(judgeAdverseCells(underDays)).toEqual([]);

    const across = foldJudgeTraces(
      rejectedSeries('engine-a', JUDGE_MIN_DAYS, Math.ceil(JUDGE_SHIP_ADVERSE_MIN / JUDGE_MIN_DAYS))
        .slice(0, JUDGE_SHIP_ADVERSE_MIN),
      NOW_MS,
      JUDGE_WINDOW_MS,
    );
    const cells = judgeAdverseCells(across);
    expect(cells).toHaveLength(1);
    expect(cells[0]?.engine).toBe('engine-a');
    expect(cells[0]?.shipAdverse).toBe(JUDGE_SHIP_ADVERSE_MIN);
    expect(cells[0]?.days).toHaveLength(JUDGE_MIN_DAYS);
    expect(cells[0]?.firstSeen).not.toBeNull();
    expect(cells[0]?.lastSeen).not.toBeNull();
  });

  it('sorts worst-first and keeps engines without adverse outcomes out', () => {
    const folds = foldJudgeTraces([
      // engine-b: 6 adverse across 2 days.
      ...rejectedSeries('engine-b', 2, 3),
      // engine-a: exactly the minimum adverse count across the minimum days
      // (two on the first day, one on the second).
      ...rejectedSeries('engine-a', 2, 2).slice(0, JUDGE_SHIP_ADVERSE_MIN),
      // engine-c: plenty of traces and one resolved review rejection — validated
      // caution, never the adverse cell.
      ...Array.from({ length: 6 }, (_, i) => trace({
        engine: 'engine-c', verdict: 'ship', proposalId: `pc-${i}`, ts: iso(NOW_MS - i * HOUR),
      })),
      trace({ engine: 'engine-c', verdict: 'review', outcome: 'rejected', outcomeAt: iso(NOW_MS - HOUR) }),
    ], NOW_MS, JUDGE_WINDOW_MS);
    const cells = judgeAdverseCells(folds);
    expect(cells.map((c) => c.engine)).toEqual(['engine-b', 'engine-a']);
    expect(cells[0]?.shipAdverse).toBe(6);
    expect(cells[1]?.shipAdverse).toBe(JUDGE_SHIP_ADVERSE_MIN);
  });
});

describe('judgeBacklogItems', () => {
  it('emits nothing for another repository, a missing ledger, or a degraded/incomplete read', async () => {
    const rows = rejectedSeries('engine-a', JUDGE_MIN_DAYS, JUDGE_SHIP_ADVERSE_MIN);
    expect(await judgeBacklogItems({ repo: 'ashlrai/other-repo', now: NOW_MS, readTraces: inject(rows) })).toEqual([]);
    expect(await judgeBacklogItems({
      repo: 'ashlrai/phantom', now: NOW_MS,
      readTraces: () => readResult([], { sourceState: 'missing', sourcePresent: false }),
    })).toEqual([]);
    expect(await judgeBacklogItems({
      repo: 'ashlrai/phantom', now: NOW_MS,
      readTraces: inject(rows, { sourceState: 'degraded', complete: false, invalidRows: 2 }),
    })).toEqual([]);
    expect(await judgeBacklogItems({
      repo: 'ashlrai/phantom', now: NOW_MS,
      readTraces: inject(rows, { complete: false, stopReasons: ['row-limit'] }),
    })).toEqual([]);
    expect(await judgeBacklogItems({
      repo: 'ashlrai/phantom', now: NOW_MS,
      readTraces: () => { throw new Error('boom'); },
    })).toEqual([]);
  });

  it('emits one stable item per recurring adverse engine with recorded detail', async () => {
    const rows = [
      ...rejectedSeries('engine-a', JUDGE_MIN_DAYS, JUDGE_SHIP_ADVERSE_MIN),
      ...rejectedSeries('engine-b', JUDGE_MIN_DAYS, JUDGE_SHIP_ADVERSE_MIN),
    ];
    const items = await judgeBacklogItems({ repo: 'ashlrai/phantom', now: NOW_MS, readTraces: inject(rows) });
    expect(items).toHaveLength(2);
    for (const item of items) {
      expect(validBacklogItem(item)).not.toBeNull();
      expect(item.repo).toBe('ashlrai/phantom');
      expect(item.area).toBe('judge-verdicts');
      expect(item.priority).toBe(3);
      expect(item.prompt).toContain('judge-traces');
      expect(item.prompt).toContain('judge-health');
    }
    const again = await judgeBacklogItems({ repo: 'ashlrai/phantom', now: NOW_MS, readTraces: inject(rows) });
    expect(again.map((i) => i.id)).toEqual(items.map((i) => i.id));
    const engineA = items.find((i) => i.title.includes('engine-a'));
    expect(engineA?.prompt).toContain(`'engine-a'`);
    // Two days at three rejections each: six adverse of six resolved ship verdicts.
    expect(engineA?.prompt).toContain('6 of 6');
    // Counts are quoted, never invented: the prompt names the window and the UTC days.
    expect(engineA?.prompt).toContain('7-day window');
    expect(engineA?.prompt).toMatch(/UTC day\(s\) \(/);
  });

  it('respects the item limit and never emits below the recurring bars', async () => {
    const rows = rejectedSeries('engine-a', JUDGE_MIN_DAYS, JUDGE_SHIP_ADVERSE_MIN);
    const few = await judgeBacklogItems({ repo: 'ashlrai/phantom', now: NOW_MS, limit: 1, readTraces: inject(rows) });
    // Only one engine qualifies anyway; build two engines to prove the cap.
    const two = await judgeBacklogItems({
      repo: 'ashlrai/phantom', now: NOW_MS, limit: 1,
      readTraces: inject([...rows, ...rejectedSeries('engine-b', JUDGE_MIN_DAYS, JUDGE_SHIP_ADVERSE_MIN)]),
    });
    expect(two).toHaveLength(1);
    expect(few).toHaveLength(1);
    const singleDay = await judgeBacklogItems({
      repo: 'ashlrai/phantom', now: NOW_MS,
      readTraces: inject(rejectedSeries('engine-a', 1, JUDGE_SHIP_ADVERSE_MIN * 2)),
    });
    expect(singleDay).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// End-to-end: real day files through readJudgeTracesDetailed
// ---------------------------------------------------------------------------

const origHome = process.env.HOME;
const origAshlrHome = process.env.ASHLR_HOME;
let tmpHome: string;

beforeEach(() => {
  tmpHome = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'ashlr-judge-backlog-')));
  process.env.HOME = tmpHome;
  process.env.ASHLR_HOME = path.join(tmpHome, '.ashlr');
});

afterEach(() => {
  rmSync(tmpHome, { recursive: true, force: true });
  process.env.HOME = origHome;
  if (origAshlrHome === undefined) delete process.env.ASHLR_HOME;
  else process.env.ASHLR_HOME = origAshlrHome;
});

function traceDir(): string {
  const dir = path.join(tmpHome, '.ashlr', 'judge-traces');
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** One schema-v2 base trace row in the file named for its ts date (the writer's layout). */
function writeBase(engine: string, verdict: JudgeTrace['verdict'], tsMs: number, proposalId: string, traceId: string): void {
  const ts = iso(tsMs);
  appendFileSync(path.join(traceDir(), `${ts.slice(0, 10)}.jsonl`), `${JSON.stringify({
    schemaVersion: 2,
    traceId,
    proposalId,
    judgeEngine: engine,
    verdict,
    scores: { value: 4, correctness: 4, scope: 4, alignment: 4 },
    reasoningState: 'not-persisted',
    promptContextState: 'not-persisted',
    ts,
  })}\n`, 'utf8');
}

/** One schema-v2 outcome patch row in the file named for its outcomeAt date, exactly as linkOutcomeResult writes it. */
function writePatch(engine: string, verdict: JudgeTrace['verdict'], tsMs: number, outcomeAtMs: number, proposalId: string, traceId: string, outcome: JudgeTrace['outcome']): void {
  const outcomeAt = iso(outcomeAtMs);
  appendFileSync(path.join(traceDir(), `${outcomeAt.slice(0, 10)}.jsonl`), `${JSON.stringify({
    schemaVersion: 2,
    proposalId,
    judgeEngine: engine,
    verdict,
    scores: { value: 4, correctness: 4, scope: 4, alignment: 4 },
    reasoningState: 'not-persisted',
    promptContextState: 'not-persisted',
    ts: iso(tsMs),
    outcome,
    outcomeAt,
    _patchForTraceId: traceId,
  })}\n`, 'utf8');
}

describe('judgeBacklogItems end-to-end', () => {
  it('folds real day files: recurring rejected ship verdicts become one item, resolved ones do not', async () => {
    const now = Date.now();
    // engine-a: three ship verdicts rejected across two UTC days (real clock, inside the window).
    const adverse: Array<[number, number]> = [
      [now - 3 * DAY - 2 * HOUR, now - 3 * DAY - HOUR],
      [now - 2 * DAY - 2 * HOUR, now - 2 * DAY - HOUR],
      [now - DAY - 2 * HOUR, now - DAY - HOUR],
    ];
    adverse.forEach(([verdictMs, outcomeMs], i) => {
      const id = `pa-${i}`;
      const tid = `jt-pa-${i}`;
      writeBase('engine-a', 'ship', verdictMs, id, tid);
      writePatch('engine-a', 'ship', verdictMs, outcomeMs, id, tid, 'rejected');
    });
    // engine-b: ship verdicts with no outcome — never adverse.
    writeBase('engine-b', 'ship', now - DAY, 'pb-1', 'jt-pb-1');
    // engine-c: review verdicts rejected — validated caution, not the adverse cell.
    writeBase('engine-c', 'review', now - DAY - HOUR, 'pc-1', 'jt-pc-1');
    writePatch('engine-c', 'review', now - DAY - HOUR, now - HOUR, 'pc-1', 'jt-pc-1', 'rejected');

    const items = await judgeBacklogItems({ repo: 'ashlrai/phantom' });
    expect(items).toHaveLength(1);
    expect(items[0]?.title).toContain('engine-a');
    expect(items[0]?.prompt).toContain(`'engine-a'`);
    expect(validBacklogItem(items[0])).not.toBeNull();
  });

  it('emits nothing when the ledger directory is absent', async () => {
    const items = await judgeBacklogItems({ repo: 'ashlrai/phantom' });
    expect(items).toEqual([]);
  });
});
