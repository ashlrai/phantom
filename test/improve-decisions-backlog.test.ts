import { mkdtempSync, mkdirSync, rmSync, appendFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DecisionEntry } from '../src/core/types.js';
import type { DecisionsReadResult } from '../src/core/fleet/decisions-ledger.js';
import {
  classifyDecisionFailure,
  classifyEscalatedReason,
  DECISIONS_FAILURE_MIN_RECORDS,
  DECISIONS_MIN_DAYS,
  DECISIONS_WINDOW_MS,
  decisionsBacklogItems,
  foldJudgeFailureCells,
  judgeFailureCells,
} from '../src/core/improve/decisions-backlog.js';
import { validBacklogItem } from '../src/core/cloud/backlog.js';

const DAY = 86_400_000;
const HOUR = 3_600_000;

/** Fixed evaluation instant for the injected-read tests; the fold never reads the wall clock. */
const NOW_MS = Date.parse('2026-12-01T12:00:00.000Z');
const iso = (ms: number): string => new Date(ms).toISOString();

/** One validated decision row in the reader's output shape; valid unless a field breaks the contract. */
function decision(spec: {
  action?: DecisionEntry['action'];
  ts?: string;
  proposalId?: string;
  engine?: string;
  model?: string;
  verdict?: string;
  judgeReasonCode?: DecisionEntry['judgeReasonCode'];
  reason?: string;
  detail?: string;
} = {}): DecisionEntry {
  return {
    ts: spec.ts ?? iso(NOW_MS - DAY),
    proposalId: spec.proposalId ?? 'p-1',
    action: spec.action ?? 'judged',
    ...(spec.engine !== undefined ? { engine: spec.engine } : {}),
    ...(spec.model !== undefined ? { model: spec.model } : {}),
    ...(spec.verdict !== undefined ? { verdict: spec.verdict } : {}),
    ...(spec.judgeReasonCode !== undefined ? { judgeReasonCode: spec.judgeReasonCode } : {}),
    ...(spec.reason !== undefined ? { reason: spec.reason } : {}),
    ...(spec.detail !== undefined ? { detail: spec.detail } : {}),
  };
}

/** n parse-failure judged rows for one engine spread across `days` distinct UTC days. */
function failureSeries(kind: 'judge-parse-failure' | 'judge-network-failure', engine: string, days: number, perDay: number, proposalsPerDay = 1): DecisionEntry[] {
  const rows: DecisionEntry[] = [];
  for (let d = 0; d < days; d++) {
    for (let i = 0; i < perDay; i++) {
      rows.push(decision({
        action: 'judged',
        engine: 'fleet-judge',
        model: engine,
        verdict: 'review',
        judgeReasonCode: kind,
        proposalId: `p-${kind}-${engine}-${d}-${i % proposalsPerDay}`,
        ts: iso(NOW_MS - d * DAY - i * HOUR),
      }));
    }
  }
  return rows;
}

function readResult(decisions: DecisionEntry[], overrides: Partial<DecisionsReadResult> = {}): DecisionsReadResult {
  return {
    decisions,
    sourceState: 'healthy',
    sourcePresent: true,
    complete: true,
    stopReasons: [],
    filesRead: 1,
    bytesRead: 1024,
    rowsScanned: decisions.length,
    invalidRows: 0,
    unreadableFiles: 0,
    ...overrides,
  };
}

const inject = (decisions: DecisionEntry[], overrides: Partial<DecisionsReadResult> = {}) =>
  () => readResult(decisions, overrides);

describe('classifyEscalatedReason / classifyDecisionFailure', () => {
  it('classifies only the two producer judge-unavailable reason strings', () => {
    expect(classifyEscalatedReason('manager-judge-unavailable')).toBe('judge-unavailable');
    expect(classifyEscalatedReason('manager judge unavailable — gate 7 fail closed')).toBe('judge-unavailable');
    // Designed holds and anything else never classify.
    expect(classifyEscalatedReason('manager gate held: verdict=\'review\', wouldMerge=false, reasonCode=judge-review')).toBeNull();
    expect(classifyEscalatedReason('self-target: auto-merge of own code requires allowSelfMerge=true')).toBeNull();
    expect(classifyEscalatedReason('some future free-text reason')).toBeNull();
    expect(classifyEscalatedReason(undefined)).toBeNull();
  });

  it('classifies judged rows by the reader-recomputed judgeReasonCode and escalated rows by reason', () => {
    const parse = classifyDecisionFailure(decision({
      action: 'judged', engine: 'claude', model: 'claude-opus-4-5',
      verdict: 'review', judgeReasonCode: 'judge-parse-failure',
    }));
    expect(parse).toEqual({ kind: 'judge-parse-failure', engine: 'claude-opus-4-5' });

    const network = classifyDecisionFailure(decision({
      action: 'judged', model: 'codex:gpt-5.5', judgeReasonCode: 'judge-network-failure',
    }));
    expect(network).toEqual({ kind: 'judge-network-failure', engine: 'codex:gpt-5.5' });

    // Real judgments and other reason codes are never failure evidence.
    for (const code of ['judge-review', 'judge-ship-would-merge', 'judge-ship-review-required', 'judge-noise', 'judge-harmful', 'judge-verdict-unrecognized'] as const) {
      expect(classifyDecisionFailure(decision({ action: 'judged', judgeReasonCode: code }))).toBeNull();
    }
    // A judged row with no reason code (legacy or injected) never guesses.
    expect(classifyDecisionFailure(decision({ action: 'judged', verdict: 'review' }))).toBeNull();

    // Escalated judge-unavailable rows classify; engine falls back model → engine → 'unknown'.
    expect(classifyDecisionFailure(decision({
      action: 'escalated', engine: 'claude', model: 'claude-opus-4-5', reason: 'manager-judge-unavailable',
    }))).toEqual({ kind: 'judge-unavailable', engine: 'claude-opus-4-5' });
    expect(classifyDecisionFailure(decision({
      action: 'escalated', reason: 'manager judge unavailable — gate 7 fail closed',
    }))).toEqual({ kind: 'judge-unavailable', engine: 'unknown' });
    expect(classifyDecisionFailure(decision({
      action: 'escalated', reason: 'manager gate held: verdict=\'ship\'', detail: 'gate-held',
    }))).toBeNull();

    // Non-judged, non-escalated actions never classify.
    for (const action of ['proposed', 'verified', 'merge-authorized', 'merged', 'handoff', 'rejected', 'self-improve:written', 'skill-library:written'] as const) {
      expect(classifyDecisionFailure(decision({ action, judgeReasonCode: 'judge-parse-failure' }))).toBeNull();
    }
  });

  it('sanitizes the recorded engine label before it can reach a prompt', () => {
    const hit = classifyDecisionFailure(decision({
      action: 'judged', model: 'evil\nengine  with   spaces', judgeReasonCode: 'judge-network-failure',
    }));
    expect(hit?.engine).toBe('evil engine with spaces');
    expect(hit?.engine).not.toContain('\n');
  });
});

describe('foldJudgeFailureCells / judgeFailureCells', () => {
  it('folds failure records per (kind, engine) inside the window only', () => {
    const folds = foldJudgeFailureCells([
      decision({ action: 'judged', model: 'engine-a', judgeReasonCode: 'judge-parse-failure', proposalId: 'p1', ts: iso(NOW_MS - DAY) }),
      decision({ action: 'judged', model: 'engine-a', judgeReasonCode: 'judge-parse-failure', proposalId: 'p2', ts: iso(NOW_MS - 2 * DAY) }),
      // Outside the window: never joins.
      decision({ action: 'judged', model: 'engine-a', judgeReasonCode: 'judge-parse-failure', proposalId: 'p3', ts: iso(NOW_MS - DECISIONS_WINDOW_MS - DAY) }),
      // Past the one-minute future-skew tolerance: never joins.
      decision({ action: 'judged', model: 'engine-a', judgeReasonCode: 'judge-parse-failure', proposalId: 'p4', ts: iso(NOW_MS + 2 * 60_000) }),
      // Different kind and engine fold into their own cells.
      decision({ action: 'judged', model: 'engine-b', judgeReasonCode: 'judge-network-failure', proposalId: 'p5', ts: iso(NOW_MS - HOUR) }),
      decision({ action: 'escalated', reason: 'manager-judge-unavailable', proposalId: 'p6', ts: iso(NOW_MS - HOUR) }),
      // Real judgments and designed holds contribute nothing.
      decision({ action: 'judged', model: 'engine-a', judgeReasonCode: 'judge-review', verdict: 'review', proposalId: 'p7', ts: iso(NOW_MS - HOUR) }),
      decision({ action: 'escalated', reason: 'manager gate held: verdict=\'review\'', detail: 'gate-held', proposalId: 'p8', ts: iso(NOW_MS - HOUR) }),
      decision({ action: 'merged', proposalId: 'p9', ts: iso(NOW_MS - HOUR) }),
    ], { nowMs: NOW_MS });

    const parse = folds.get('judge-parse-failure|engine-a');
    expect(parse?.records).toBe(2);
    expect(parse?.proposals.size).toBe(2);
    expect(parse?.days.size).toBe(2);
    expect(folds.get('judge-network-failure|engine-b')?.records).toBe(1);
    expect(folds.get('judge-unavailable|unknown')?.records).toBe(1);
    expect(folds.size).toBe(3);
  });

  it('emits cells only at the recurring bars: records, days AND distinct proposals', () => {
    const atBars = judgeFailureCells(foldJudgeFailureCells(
      failureSeries('judge-parse-failure', 'engine-a', DECISIONS_MIN_DAYS, DECISIONS_FAILURE_MIN_RECORDS),
      { nowMs: NOW_MS },
    ));
    expect(atBars).toHaveLength(1);
    expect(atBars[0]).toMatchObject({
      kind: 'judge-parse-failure', engine: 'engine-a',
      records: DECISIONS_MIN_DAYS * DECISIONS_FAILURE_MIN_RECORDS, days: DECISIONS_MIN_DAYS,
    });

    // Below the record bar: two records across two days and two proposals still stay under three.
    expect(judgeFailureCells(foldJudgeFailureCells(
      failureSeries('judge-parse-failure', 'engine-a', DECISIONS_MIN_DAYS, 1),
      { nowMs: NOW_MS },
    ))).toEqual([]);

    // Records and proposals recur but all on one UTC day.
    const oneDay = [0, 1, 2].map((i) => decision({
      action: 'judged', model: 'engine-a', judgeReasonCode: 'judge-parse-failure',
      proposalId: `pd-${i}`, ts: iso(NOW_MS - i * HOUR),
    }));
    expect(judgeFailureCells(foldJudgeFailureCells(oneDay, { nowMs: NOW_MS }))).toEqual([]);

    // Records across days but all on ONE proposal — a stubborn proposal is not machinery failure.
    const oneProposal = [0, 1, 2].map((d) => decision({
      action: 'judged', model: 'engine-a', judgeReasonCode: 'judge-parse-failure',
      proposalId: 'p-same', ts: iso(NOW_MS - d * DAY),
    }));
    expect(oneProposal.length).toBeGreaterThanOrEqual(DECISIONS_FAILURE_MIN_RECORDS);
    expect(judgeFailureCells(foldJudgeFailureCells(oneProposal, { nowMs: NOW_MS }))).toEqual([]);
  });
});

describe('decisionsBacklogItems', () => {
  it('emits one stable valid item per recurring failure cell', async () => {
    const rows = [
      ...failureSeries('judge-parse-failure', 'engine-a', DECISIONS_MIN_DAYS, DECISIONS_FAILURE_MIN_RECORDS),
      ...failureSeries('judge-network-failure', 'engine-b', DECISIONS_MIN_DAYS, DECISIONS_FAILURE_MIN_RECORDS),
      // Designed escalations never emit.
      ...[0, 1, 2].map((d) => decision({
        action: 'escalated', reason: 'manager gate held: verdict=\'review\'', detail: 'gate-held',
        proposalId: `held-${d}`, ts: iso(NOW_MS - d * DAY),
      })),
      // Real judgments never emit.
      ...[0, 1, 2].map((d) => decision({
        action: 'judged', model: 'engine-a', judgeReasonCode: 'judge-review', verdict: 'review',
        proposalId: `real-${d}`, ts: iso(NOW_MS - d * DAY),
      })),
    ];
    const items = await decisionsBacklogItems({ repo: 'ashlrai/phantom', now: NOW_MS, readDecisions: inject(rows) });
    expect(items).toHaveLength(2);
    for (const item of items) {
      expect(validBacklogItem(item)).not.toBeNull();
      expect(item.repo).toBe('ashlrai/phantom');
      expect(item.area).toBe('judge-failures');
      expect(item.priority).toBe(3);
      expect(item.prompt).toContain('decisions');
      expect(item.prompt).toContain('judgeReasonCode');
    }
    const parseItem = items.find((i) => i.title.includes('unparseable'));
    const netItem = items.find((i) => i.title.includes('network'));
    expect(parseItem?.title).toContain('engine-a');
    expect(netItem?.title).toContain('engine-b');
    expect(parseItem?.prompt).toContain(`'engine-a'`);
    expect(parseItem?.prompt).toContain('judge-parse-failure');
    expect(netItem?.prompt).toContain('judge-network-failure');
    // Counts and days are quoted; proposal ids and free-text reasons never are.
    expect(parseItem?.prompt).toContain(`${DECISIONS_MIN_DAYS * DECISIONS_FAILURE_MIN_RECORDS} 'judge-parse-failure' record(s)`);
    expect(parseItem?.prompt).not.toContain('p-judge-parse-failure');
    expect(netItem?.prompt).not.toContain('gate 7 fail closed');

    // Dedup is downstream: a refresh re-derives the same ids.
    const again = await decisionsBacklogItems({ repo: 'ashlrai/phantom', now: NOW_MS, readDecisions: inject(rows) });
    expect(again.map((i) => i.id)).toEqual(items.map((i) => i.id));
  });

  it('emits an unattributed judge-unavailable cell for escalated rows without engine labels', async () => {
    const rows = [0, 1, 2].map((d) => decision({
      action: 'escalated',
      reason: d === 2 ? 'manager judge unavailable — gate 7 fail closed' : 'manager-judge-unavailable',
      proposalId: `pu-${d}`, ts: iso(NOW_MS - d * DAY),
    }));
    const items = await decisionsBacklogItems({ repo: 'ashlrai/phantom', now: NOW_MS, readDecisions: inject(rows) });
    expect(items).toHaveLength(1);
    expect(items[0]?.title).toContain('unavailable');
    expect(items[0]?.prompt).toContain('judge-unavailable');
    expect(items[0]?.prompt).toContain('unattributed');
    expect(validBacklogItem(items[0])).not.toBeNull();
  });

  it('emits the degraded-source item alone when the read reports degradation', async () => {
    const items = await decisionsBacklogItems({
      repo: 'ashlrai/phantom', now: NOW_MS,
      readDecisions: inject(
        failureSeries('judge-parse-failure', 'engine-a', DECISIONS_MIN_DAYS, DECISIONS_FAILURE_MIN_RECORDS),
        { sourceState: 'degraded', complete: false, invalidRows: 2, unreadableFiles: 1, stopReasons: ['io-error'] },
      ),
    });
    expect(items).toHaveLength(1);
    expect(items[0]?.title).toContain('degraded');
    expect(items[0]?.prompt).toContain('invalidRows 2');
    expect(items[0]?.prompt).toContain('unreadableFiles 1');
    expect(items[0]?.prompt).toContain('io-error');
    expect(validBacklogItem(items[0])).not.toBeNull();
    // Same stable id on refresh — dedup downstream.
    const again = await decisionsBacklogItems({
      repo: 'ashlrai/phantom', now: NOW_MS,
      readDecisions: inject([], { sourceState: 'degraded', complete: false, stopReasons: ['byte-limit'] }),
    });
    expect(again).toHaveLength(1);
    expect(again[0]?.id).toBe(items[0]?.id);

    // complete:false alone degrades the source even if a reader reports healthy.
    const incomplete = await decisionsBacklogItems({
      repo: 'ashlrai/phantom', now: NOW_MS,
      readDecisions: inject(failureSeries('judge-parse-failure', 'engine-a', DECISIONS_MIN_DAYS, DECISIONS_FAILURE_MIN_RECORDS), { complete: false, stopReasons: ['row-limit'] }),
    });
    expect(incomplete).toHaveLength(1);
    expect(incomplete[0]?.title).toContain('degraded');
  });

  it('emits nothing for missing, empty, foreign-repo, throwing or below-bar sources', async () => {
    expect(await decisionsBacklogItems({
      repo: 'ashlrai/phantom', now: NOW_MS,
      readDecisions: inject([], { sourceState: 'missing', sourcePresent: false }),
    })).toEqual([]);
    expect(await decisionsBacklogItems({ repo: 'ashlrai/phantom', now: NOW_MS, readDecisions: inject([]) })).toEqual([]);
    expect(await decisionsBacklogItems({
      repo: 'someone-else/other-repo', now: NOW_MS,
      readDecisions: inject(failureSeries('judge-parse-failure', 'engine-a', DECISIONS_MIN_DAYS, DECISIONS_FAILURE_MIN_RECORDS)),
    })).toEqual([]);
    expect(await decisionsBacklogItems({
      repo: 'ashlrai/phantom', now: NOW_MS,
      readDecisions: () => { throw new Error('boom'); },
    })).toEqual([]);
    // Below the record bar: never emits.
    expect(await decisionsBacklogItems({
      repo: 'ashlrai/phantom', now: NOW_MS,
      readDecisions: inject(failureSeries('judge-parse-failure', 'engine-a', DECISIONS_MIN_DAYS, 1)),
    })).toEqual([]);
  });

  it('respects the item limit in fold order (most records first)', async () => {
    const heavy = failureSeries('judge-parse-failure', 'engine-a', DECISIONS_MIN_DAYS, DECISIONS_FAILURE_MIN_RECORDS + 2);
    const light = failureSeries('judge-network-failure', 'engine-b', DECISIONS_MIN_DAYS, DECISIONS_FAILURE_MIN_RECORDS);
    const items = await decisionsBacklogItems({
      repo: 'ashlrai/phantom', now: NOW_MS, limit: 1,
      readDecisions: inject([...heavy, ...light]),
    });
    expect(items).toHaveLength(1);
    expect(items[0]?.title).toContain('engine-a');
  });
});

// ---------------------------------------------------------------------------
// End-to-end: real day files through readDecisionsDetailed
// ---------------------------------------------------------------------------

const origHome = process.env.HOME;
const origAshlrHome = process.env.ASHLR_HOME;
let tmpHome: string;

beforeEach(() => {
  tmpHome = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'ashlr-decisions-backlog-')));
  process.env.HOME = tmpHome;
  process.env.ASHLR_HOME = path.join(tmpHome, '.ashlr');
});

afterEach(() => {
  rmSync(tmpHome, { recursive: true, force: true });
  process.env.HOME = origHome;
  if (origAshlrHome === undefined) delete process.env.ASHLR_HOME;
  else process.env.ASHLR_HOME = origAshlrHome;
});

function decisionsDir(): string {
  const dir = path.join(tmpHome, '.ashlr', 'decisions');
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** One legacy (v1-metadata) decision row in the file named for its ts date — the writer's layout. */
function writeDecision(row: Record<string, unknown>): void {
  const ts = row['ts'] as string;
  appendFileSync(path.join(decisionsDir(), `${ts.slice(0, 10)}.jsonl`), `${JSON.stringify(row)}\n`, 'utf8');
}

const judgedFailure = (tsMs: number, proposalId: string, engine: string, kind: 'parse' | 'network'): Record<string, unknown> => ({
  ts: iso(tsMs),
  proposalId,
  action: 'judged',
  engine: 'fleet-judge',
  model: engine,
  verdict: 'review',
  detail: kind === 'network' ? 'judge-network-failure' : 'judge-parse-failure',
});

describe('decisionsBacklogItems end-to-end', () => {
  it('folds real day files: recurring judge failures become items, real judgments do not', async () => {
    const now = Date.now();
    // engine-a: three parse failures across two UTC days and three proposals.
    const stamps: Array<[number, string]> = [
      [now - 3 * DAY - 2 * HOUR, 'pa-1'],
      [now - 2 * DAY - 2 * HOUR, 'pa-2'],
      [now - DAY - 2 * HOUR, 'pa-3'],
    ];
    for (const [tsMs, pid] of stamps) writeDecision(judgedFailure(tsMs, pid, 'engine-a', 'parse'));
    // engine-b: two network failures on ONE proposal only — below the proposal bar.
    writeDecision(judgedFailure(now - 2 * DAY, 'pb-same', 'engine-b', 'network'));
    writeDecision(judgedFailure(now - DAY, 'pb-same', 'engine-b', 'network'));
    // engine-c: real 'review' judgments — never failure evidence.
    for (let d = 0; d < 3; d++) {
      writeDecision({
        ts: iso(now - d * DAY - HOUR), proposalId: `pc-${d}`, action: 'judged',
        engine: 'fleet-judge', model: 'engine-c', verdict: 'review',
      });
    }
    // Designed gate-held escalations — never failure evidence.
    for (let d = 0; d < 3; d++) {
      writeDecision({
        ts: iso(now - d * DAY - HOUR), proposalId: `held-${d}`, action: 'escalated',
        reason: 'manager gate held: verdict=\'review\'', detail: 'gate-held',
      });
    }

    const items = await decisionsBacklogItems({ repo: 'ashlrai/phantom' });
    expect(items).toHaveLength(1);
    expect(items[0]?.title).toContain('engine-a');
    expect(items[0]?.prompt).toContain('judge-parse-failure');
    expect(validBacklogItem(items[0])).not.toBeNull();
  });

  it('emits the degraded-source item when a day file holds an off-contract row', async () => {
    const now = Date.now();
    const ts = iso(now - DAY);
    writeDecision(judgedFailure(now - DAY, 'pd-1', 'engine-a', 'parse'));
    // A malformed line degrades the whole read for requireComplete consumers.
    appendFileSync(path.join(decisionsDir(), `${ts.slice(0, 10)}.jsonl`), 'this is not json\n', 'utf8');

    const items = await decisionsBacklogItems({ repo: 'ashlrai/phantom' });
    expect(items).toHaveLength(1);
    expect(items[0]?.title).toContain('degraded');
    expect(items[0]?.prompt).toContain('invalidRows');
    expect(validBacklogItem(items[0])).not.toBeNull();
  });

  it('emits nothing when the decisions directory is absent', async () => {
    const items = await decisionsBacklogItems({ repo: 'ashlrai/phantom' });
    expect(items).toEqual([]);
  });
});
