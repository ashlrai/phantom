import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  authorityRevertedPrKeys,
  foldCrossReviews,
  foldEmptyTags,
  foldLaunchCosts,
  foldMarketHandoffAdvisories,
  foldMergeEvents,
  foldRewardSignals,
  foldRouteDecisionWorkClasses,
  foldRouteDecisions,
  foldRouterOutcomes,
  foldSpendCosts,
  readLedgerFile,
  readLedgerTail,
  readRouterOutcomes,
  ROUTER_OUTCOME_LEDGER_LIMIT,
  type CrossReviewEvidence,
  type MergeQueueEvidence,
  type RouterOutcomeEvidenceRow,
} from '../src/core/router/outcomes.js';
import { recordRevertOutcomes, revertOutcomesLedgerPath } from '../src/core/improve/revert-ledger.js';
import type { RevertOutcomeRecord } from '../src/core/improve/reverted.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function runsDir(ledger?: string): string {
  const root = mkdtempSync(join(tmpdir(), 'ledger-612s-'));
  roots.push(root);
  if (ledger !== undefined) {
    mkdirSync(join(root, 'metrics'));
    writeFileSync(join(root, 'metrics', 'jobs.jsonl'), ledger);
  }
  return root;
}

const ledgerPath = (root: string) => join(root, 'metrics', 'jobs.jsonl');
const spendPath = (root: string) => join(root, 'metrics', 'api-spend.jsonl');

function writeSpend(root: string, text: string): void {
  mkdirSync(join(root, 'metrics'), { recursive: true });
  writeFileSync(spendPath(root), text);
}

const marketPath = (root: string) => join(root, 'metrics', 'work-market.jsonl');

function writeMarket(root: string, rows: object[]): void {
  mkdirSync(join(root, 'metrics'), { recursive: true });
  writeFileSync(marketPath(root), rows.map(r => JSON.stringify(r)).join('\n') + '\n');
}

const emptyTagsPath = (root: string) => join(root, 'metrics', 'empty-tags.jsonl');

function writeEmptyTags(root: string, rows: object[]): void {
  mkdirSync(join(root, 'metrics'), { recursive: true });
  writeFileSync(emptyTagsPath(root), rows.map(r => JSON.stringify(r)).join('\n') + '\n');
}

const mergeEventsPath = (root: string) => join(root, 'metrics', 'merge-events.jsonl');

function writeMergeEvents(root: string, rows: object[]): void {
  mkdirSync(join(root, 'metrics'), { recursive: true });
  writeFileSync(mergeEventsPath(root), rows.map(r => JSON.stringify(r)).join('\n') + '\n');
}

const launchCostsPath = (root: string) => join(root, 'metrics', 'launch-cost.jsonl');

function writeLaunchCosts(root: string, rows: object[]): void {
  mkdirSync(join(root, 'metrics'), { recursive: true });
  writeFileSync(launchCostsPath(root), rows.map(r => JSON.stringify(r)).join('\n') + '\n');
}

/** A fleet.launch-cost.v1 row in the shape contrib/mac/launch_cost.py appends (src/core/fleet/launch-cost.ts). */
const launchCostRow = (launchId: string, status: 'measured' | 'partial' | 'unknown', extra: Record<string, unknown> = {}): object => ({
  schema: 'fleet.launch-cost.v1', lane: 'alpha', launchId, startedAt: '2026-11-01T00:00:00Z',
  windowSeconds: 60, sampledSeconds: status === 'measured' ? 60 : 30, samples: status === 'measured' ? 60 : 6,
  peakProcesses: status === 'unknown' ? null : 4,
  meanCpuPercentOneCore: status === 'unknown' ? null : 12.5,
  peakCpuPercentOneCore: status === 'unknown' ? null : 40,
  status, ...extra,
});

/** A merge-events.jsonl observation row in the fleet merge-latency shape (repo#pr keyed). */
const mergeEvent = (pr: number, type: string, extra: Record<string, unknown> = {}): object => ({
  repo: 'ashlrai/phantom', pr, type, at: '2026-11-21T00:00:00Z', ...extra,
});

/** A job.empty-tag.v1 row in the shape `phm jobs empty --record` appends (src/core/fleet/empty-tags.ts). */
const emptyTag = (job: string, tag: string, extra: Record<string, unknown> = {}): object => ({
  schema: 'job.empty-tag.v1', job, lane: 'alpha', tag, ...extra,
});

/** A work-market.v1 route_decision row in the dispatcher's own shape. */
const decision = (job: string, workClass: string, ts: number, extra: Record<string, unknown> = {}): object => ({
  schema: 'work-market.v1', event: 'route_decision', job,
  chosen_lane: 'alpha', preferred_lane: 'alpha', work_class: workClass,
  override: null, rejected_lanes: [], reason_codes: [], ts, ...extra,
});

function ashlarDir(scores?: unknown): string {
  const root = mkdtempSync(join(tmpdir(), 'ledger-612s-eval-'));
  roots.push(root);
  if (scores !== undefined) {
    mkdirSync(join(root, 'eval', 'passk'), { recursive: true });
    writeFileSync(join(root, 'eval', 'passk', 'lane-scores.json'), typeof scores === 'string' ? scores : JSON.stringify(scores));
  }
  return root;
}

const rewardSignalsPath = (root: string) => join(root, 'metrics', 'reward-signals.jsonl');

/** An ASHLR-home temp root carrying metrics/reward-signals.jsonl rows (reward-signal v1 shape). */
function rewardLedger(rows: object[]): string {
  const root = mkdtempSync(join(tmpdir(), 'ledger-612s-reward-'));
  roots.push(root);
  mkdirSync(join(root, 'metrics'), { recursive: true });
  writeFileSync(rewardSignalsPath(root), rows.map(r => JSON.stringify(r)).join('\n') + '\n');
  return root;
}

const crossReviewLedgerPath = (root: string) => join(root, 'fleet', 'cross-review.jsonl');

/** An ASHLR-home temp root carrying fleet/cross-review.jsonl rows (the cross-review audit journal shape). */
function crossReviewLedger(rows: (object | string)[]): string {
  const root = mkdtempSync(join(tmpdir(), 'ledger-612s-xreview-'));
  roots.push(root);
  mkdirSync(join(root, 'fleet'), { recursive: true });
  writeFileSync(crossReviewLedgerPath(root), rows.map(r => typeof r === 'string' ? r : JSON.stringify(r)).join('\n') + '\n');
  return root;
}

/** A cross-review.jsonl kind:'review' row in the shape cross-review-run.ts appends (src/core/fleet/cross-review.ts). */
const crossReview = (pr: number, outcome: string, extra: Record<string, unknown> = {}): object => ({
  schemaVersion: 1, kind: 'review', at: '2026-11-21T00:00:00.000Z',
  repo: 'ashlrai/phantom', pr,
  prUrl: `https://github.com/ashlrai/phantom/pull/${pr}`,
  reviewedHeadSha: 'a'.repeat(40), diffSha256: 'b'.repeat(64),
  producerPool: 'mac-a', producerFamily: 'openai',
  reviewerPool: 'mac-b', reviewerFamily: 'claude',
  outcome, reasons: [], failure: null, skippedFor: [], ...extra,
});

/** A reward-signals.jsonl v1 row in the shape the reward-sync feed appends (src/core/metrics/reward-signal.ts). */
const rewardRow = (jobId: string, merged: boolean, extra: Record<string, unknown> = {}): object => ({
  v: 1, jobId, pool: 'codex-cmp', repo: 'ashlrai/phantom', merged,
  dispatchedAt: '2026-11-01T00:00:00.000Z', mergedAt: merged ? '2026-11-01T01:00:00.000Z' : null,
  timeToMergeMs: merged ? 3_600_000 : null, ciWallMs: 600_000,
  cost: { pool: 'codex-cmp', pctUsedStart: 10, pctUsedEnd: 12.5, pctUsedDelta: 2.5, costUsd: 0.75 },
  recordedAt: '2026-11-01T02:00:00.000Z', ...extra,
});

const laneScores = (lanes: unknown[]) => ({
  schema: 'eval.lane-scores.v1', generatedAt: '2026-11-19T00:00:00Z', reportId: 'r1', k: 3, trials: 9, lanes,
});
const scoreRow = (lane: string, model: string, passPowK: number | null) => ({
  lane, model, tasks: 3, trials: 9, passes: 6, pass1: 2 / 3, ci95: null, passAtK: 0.9, passPowK,
});

describe('router outcome ledger (612S preservation)', () => {
  it('folds mixed valid and malformed rows and tolerates blanks', () => {
    const text = [
      '{"job":"J1","lane":"alpha","model":"m1","tier":"work","phase":"MERGED","ts":"2026-11-01T00:00:00Z"}',
      'not json',
      '',
      '[1,2]',
      '42',
      '{"job":"J2","lane":"beta"}',
    ].join('\n');
    const fold = foldRouterOutcomes(text);
    expect(fold.malformed_rows).toBe(3);
    expect(fold.unattached_rows).toBe(0);
    expect(fold.outcomes.map(o => o.job_id)).toEqual(['J1', 'J2']);
    expect(fold.outcomes[0]).toMatchObject({ schema: 'router.outcome.v1', lane: 'alpha', model: 'm1', tier: 'work', merged: true, passk: null });
  });

  it('joins a PR URL to its job only through an exact, unambiguous claim', () => {
    const text = [
      '{"job":"J1","pr_url":"https://github.com/o/r/pull/1","phase":"MERGED","ts":"2026-11-01T00:00:00Z"}',
      '{"pr_url":"https://github.com/o/r/pull/1","cost_usd":2.5}',
      '{"job":"J2","pr_url":"https://github.com/o/r/pull/2","phase":"CLOSED"}',
      '{"pr_url":"https://github.com/o/r/pull/9","phase":"MERGED"}',
    ].join('\n');
    const fold = foldRouterOutcomes(text);
    const j1 = fold.outcomes.find(o => o.job_id === 'J1');
    expect(j1).toMatchObject({ merged: true, cost_usd: 2.5 });
    expect(fold.outcomes.find(o => o.job_id === 'J2')).toMatchObject({ merged: false });
    // PR 9 has no job identity anywhere: counted as unattached, never attached to a guess.
    expect(fold.unattached_rows).toBe(1);
    expect(fold.outcomes).toHaveLength(2);
  });

  it('reads alias timestamp fields and prefers mergedAt/closedAt on terminal rows', () => {
    const fold = foldRouterOutcomes([
      '{"job":"T1","phase":"CLOSED","timestamp":"2026-11-01T00:00:00Z","closedAt":"2026-11-01T02:00:00Z"}',
      '{"job":"T1","phase":"MERGED","recordedAt":"2026-11-01T03:00:00Z"}',
      '{"job":"T2","phase":"MERGED","time":"2026-11-01T01:00:00Z","mergedAt":"2026-11-01T04:00:00Z"}',
      '{"job":"T2","phase":"CLOSED","updatedAt":"2026-11-01T05:00:00Z"}',
    ].join('\n'));
    // T1: the alias-only MERGED stamp (03:00) is later than the CLOSED closedAt (02:00).
    expect(fold.outcomes.find(o => o.job_id === 'T1')).toMatchObject({ merged: true });
    // T2: the alias-only CLOSED stamp (05:00) is later than the MERGED mergedAt (04:00).
    expect(fold.outcomes.find(o => o.job_id === 'T2')).toMatchObject({ merged: false });
  });

  it('reads the full jobs-ledger outcome dialect: phase aliases and event-named verdicts', () => {
    const fold = foldRouterOutcomes([
      // Reconciler-style merge: publish-shaped event, terminal phase in `phase`.
      '{"job":"D1","event":"publish","phase":"MERGED","pr_url":"https://github.com/o/r/pull/11","ts":"2026-11-01T00:00:00Z"}',
      // Closed spelled `result` on a `kind` event.
      '{"job":"D2","kind":"outcome","result":"CLOSED","ts":"2026-11-01T00:00:00Z"}',
      // Verdict carried only by the event name.
      '{"job":"D3","event":"merged","lane":"alpha","ts":"2026-11-01T00:00:00Z"}',
      '{"job":"D4","event":"closed","lane":"alpha","ts":"2026-11-01T00:00:00Z"}',
      // A bare outcome or published event names no verdict.
      '{"job":"D5","event":"outcome","ts":"2026-11-01T00:00:00Z"}',
      '{"job":"D6","event":"published","outcome":"PUBLISHED","url":"https://github.com/o/r/pull/12","ts":"2026-11-01T00:00:00Z"}',
      // A resolved phase stays authoritative over the event name.
      '{"job":"D7","event":"closed","conclusion":"MERGED","ts":"2026-11-01T00:00:00Z"}',
      '{"job":"D8","event":"merged","status":"CLOSED","ts":"2026-11-01T00:00:00Z"}',
      // Event-named merges order by mergedAt like phase-named ones.
      '{"job":"D9","phase":"CLOSED","closedAt":"2026-11-01T01:00:00Z"}',
      '{"job":"D9","event":"merged","mergedAt":"2026-11-01T02:00:00Z"}',
      '{"job":"D10","event":"merged","mergedAt":"2026-11-01T01:00:00Z"}',
      '{"job":"D10","phase":"CLOSED","closedAt":"2026-11-01T02:00:00Z"}',
    ].join('\n'));
    const byId = new Map(fold.outcomes.map(o => [o.job_id, o]));
    expect(byId.get('D1')?.merged).toBe(true);
    expect(byId.get('D2')?.merged).toBe(false);
    expect(byId.get('D3')?.merged).toBe(true);
    expect(byId.get('D4')?.merged).toBe(false);
    expect(byId.get('D5')?.merged).toBeNull();
    expect(byId.get('D6')?.merged).toBeNull();
    expect(byId.get('D7')?.merged).toBe(true);
    expect(byId.get('D8')?.merged).toBe(false);
    expect(byId.get('D9')?.merged).toBe(true);
    expect(byId.get('D10')?.merged).toBe(false);
  });

  it('folds recorded opened-to-merged seconds only from the standing merge verdict', () => {
    const fold = foldRouterOutcomes([
      // The fleet's ttm dialect on the merge row that stands as the verdict.
      '{"job":"M1","phase":"MERGED","mergedAt":"2026-11-01T02:00:00Z","ttm_s":3600,"ts":"2026-11-01T02:00:00Z"}',
      // The camelCase alias spelling on an event-named merge.
      '{"job":"M2","event":"merged","mergedAt":"2026-11-01T03:00:00Z","ttmS":7200}',
      // A close verdict and an unresolved outcome never carry merge latency.
      '{"job":"M3","phase":"CLOSED","ttm_s":100,"ts":"2026-11-01T01:00:00Z"}',
      '{"job":"M4","phase":"VERIFIED","ttm_s":100}',
      // A later close clears the earlier merge's recorded figure.
      '{"job":"M5","phase":"MERGED","mergedAt":"2026-11-01T01:00:00Z","ttm_s":500,"ts":"2026-11-01T01:00:00Z"}',
      '{"job":"M5","phase":"CLOSED","closedAt":"2026-11-01T04:00:00Z","ts":"2026-11-01T04:00:00Z"}',
      // A newer merge row without the field replaces it wholesale: unknown, not stale.
      '{"job":"M6","phase":"MERGED","mergedAt":"2026-11-01T01:00:00Z","ttm_s":500,"ts":"2026-11-01T01:00:00Z"}',
      '{"job":"M6","phase":"MERGED","mergedAt":"2026-11-01T07:00:00Z","ts":"2026-11-01T07:00:00Z"}',
      // Non-finite and negative figures stay unknown.
      '{"job":"M7","phase":"MERGED","mergedAt":"2026-11-01T05:00:00Z","ttm_s":-5}',
      '{"job":"M8","phase":"MERGED","mergedAt":"2026-11-01T06:00:00Z","ttm_s":"fast"}',
    ].join('\n'));
    const byId = new Map(fold.outcomes.map(o => [o.job_id, o]));
    expect(byId.get('M1')).toMatchObject({ merged: true, ttm_s: 3600 });
    expect(byId.get('M2')).toMatchObject({ merged: true, ttm_s: 7200 });
    expect(byId.get('M3')).toMatchObject({ merged: false, ttm_s: null });
    expect(byId.get('M4')).toMatchObject({ merged: null, ttm_s: null });
    expect(byId.get('M5')).toMatchObject({ merged: false, ttm_s: null });
    expect(byId.get('M6')).toMatchObject({ merged: true, ttm_s: null });
    expect(byId.get('M7')).toMatchObject({ merged: true, ttm_s: null });
    expect(byId.get('M8')).toMatchObject({ merged: true, ttm_s: null });
  });

  it('refuses to attach URL-only rows when two jobs claim the same PR', () => {
    const text = [
      '{"job":"A","pr_url":"https://github.com/o/r/pull/7"}',
      '{"job":"B","pr_url":"https://github.com/o/r/pull/7"}',
      '{"pr_url":"https://github.com/o/r/pull/7","phase":"MERGED","cost_usd":9}',
    ].join('\n');
    const fold = foldRouterOutcomes(text);
    expect(fold.ambiguous_urls).toBe(1);
    expect(fold.unattached_rows).toBe(1);
    for (const o of fold.outcomes) {
      expect(o.merged).toBeNull();
      expect(o.cost_usd).toBeNull();
    }
  });

  it('keeps unknown measurements null and does not infer merge from VERIFIED, CI, or a PR URL', () => {
    const fold = foldRouterOutcomes('{"job":"U1","phase":"VERIFIED","pr_url":"https://github.com/o/r/pull/3","ci_first_pass":"yes","cost_usd":-1}\n');
    expect(fold.outcomes).toEqual([{
      schema: 'router.outcome.v1', job_id: 'U1', lane: null, model: null, tier: null, work_class: null, repo: null,
      lane_hint: null, lane_override: null,
      merged: null, reverted: null, ci_first_pass: null, review_findings: null, cost_usd: null, wall_s: null,
      tokens_total: null, acus: null, tokens_in: null, tokens_out: null,
      tokens_cache_read: null, tokens_cache_write: null,
      usage_source: null, usage_missing: null,
      ttm_s: null, queue_wait_s: null, ci_wall_s: null, publish_wait_s: null, empty: null, diff_files: null, diff_lines: null,
      exit_code: null, failure_class: null, empty_class: null, empty_tag: null,
      task_outcome: null, lane_hint_blocked_by: null,
      skipped: null, skip_reason: null, skip_code: null,
      deferred: null, defer_reason: null, defer_repeat_of: null,
      noop: null, noop_reason: null, noop_repeat_of: null,
      market_lane: null, market_preferred: null, market_override: null, market_reasons: null,
      market_rejected: null,
      handoff_trigger: null, handoff_lane: null, handoff_target: null,
      provider_wall_trigger: null, provider_wall_pattern: null, provider_wall_lane: null,
      pool_kind: null, pool_mem_free_pct: null, pool_swap_gb: null, pool_pct_used: null,
      node_outcome: null, node_id: null, node_pack: null,
      merge_queue: null, cross_review: null,
      launch_cost_status: null, launch_peak_processes: null, launch_mean_cpu_pct: null, launch_peak_cpu_pct: null,
      passk: null,
    }]);
  });

  it('folds queue-admission wait from arrival to first dispatch, unknown when a boundary is missing', () => {
    const fold = foldRouterOutcomes([
      // Q1: enqueued 10:00, launched 10:05 -> 300s of queue wait.
      '{"job":"Q1","event":"enqueue","ts":"2026-11-01T10:00:00Z"}',
      '{"job":"Q1","event":"launch","lane":"alpha","ts":"2026-11-01T10:05:00Z"}',
      '{"job":"Q1","phase":"MERGED","ts":"2026-11-01T11:00:00Z"}',
      // Q2: requeued after a failed attempt — the later arrival never moves
      // the first-dispatch wait (still 10:00 -> 10:02 = 120s).
      '{"job":"Q2","event":"enqueue","ts":"2026-11-01T10:00:00Z"}',
      '{"job":"Q2","event":"launch","lane":"alpha","ts":"2026-11-01T10:02:00Z"}',
      '{"job":"Q2","event":"enqueue","ts":"2026-11-01T12:00:00Z"}',
      '{"job":"Q2","event":"launch","lane":"alpha","ts":"2026-11-01T12:30:00Z"}',
      '{"job":"Q2","phase":"MERGED","ts":"2026-11-01T13:00:00Z"}',
      // Q3: dispatched with no recorded arrival — unknown, never zero.
      '{"job":"Q3","event":"launch","lane":"alpha","ts":"2026-11-01T10:00:00Z"}',
      '{"job":"Q3","phase":"MERGED"}',
      // Q4: arrival recorded but never dispatched — still in flight, unknown.
      '{"job":"Q4","event":"queued","ts":"2026-11-01T10:00:00Z"}',
      // Q5: arrival stamped after the first dispatch cannot pair — unknown.
      '{"job":"Q5","event":"launch","lane":"alpha","ts":"2026-11-01T10:00:00Z"}',
      '{"job":"Q5","event":"enqueue","ts":"2026-11-01T11:00:00Z"}',
      '{"job":"Q5","phase":"MERGED"}',
      // Q6: batch-session infrastructure rows never mint queue evidence.
      '{"job":"RQ-BATCH-q6","event":"enqueue","ts":"2026-11-01T10:00:00Z"}',
      '{"job":"RQ-BATCH-q6","event":"launch","ts":"2026-11-01T10:05:00Z"}',
      // Q7: timestamp aliases and dispatch dialects join like the phase reads.
      '{"job":"Q7","kind":"enqueued","at":"2026-11-01T09:00:00Z"}',
      '{"job":"Q7","type":"batch_claim","lane":"alpha","time":"2026-11-01T09:00:30Z"}',
      '{"job":"Q7","phase":"CLOSED"}',
    ].join('\n'));
    const byId = new Map(fold.outcomes.map(o => [o.job_id, o]));
    expect(byId.get('Q1')).toMatchObject({ merged: true, queue_wait_s: 300 });
    expect(byId.get('Q2')).toMatchObject({ merged: true, queue_wait_s: 120 });
    for (const id of ['Q3', 'Q4', 'Q5']) expect(byId.get(id)?.queue_wait_s).toBeNull();
    expect(byId.has('RQ-BATCH-q6')).toBe(false);
    expect(byId.get('Q7')).toMatchObject({ merged: false, queue_wait_s: 30 });
  });

  it('uses the same PR attribution for timing boundaries and outcome rows', () => {
    const unique = 'https://github.com/ashlrai/phantom/pull/42';
    const contested = 'https://github.com/ashlrai/phantom/pull/43';
    const rows = [
      { event: 'enqueue', url: unique, ts: '2026-11-01T10:00:00Z' },
      { event: 'launch', job: 'unique', ts: '2026-11-01T10:01:00Z' },
      { event: 'finish', job: 'unique', ts: '2026-11-01T10:02:00Z' },
      { event: 'publish', url: unique, ts: '2026-11-01T10:03:00Z' },
      { event: 'ci_start', prUrl: 'https://github.com/AshlrAI/Phantom/pull/42', ts: '2026-11-01T10:04:00Z' },
      { event: 'ci_complete', url: unique, ts: '2026-11-01T10:06:00Z' },
      { phase: 'MERGED', job: 'unique', url: unique },
      { event: 'ci_start', job: 'first', url: contested, ts: '2026-11-01T10:04:00Z' },
      { event: 'ci_complete', url: contested, ts: '2026-11-01T10:06:00Z' },
      { event: 'ci_complete', job: 'first', url: contested, ts: '2026-11-01T10:07:00Z' },
      { event: 'ci_start', job: 'second', url: contested, ts: '2026-11-01T10:04:00Z' },
    ];
    const fold = foldRouterOutcomes(rows.map(row => JSON.stringify(row)).join('\n'));
    const byId = new Map(fold.outcomes.map(outcome => [outcome.job_id, outcome]));
    expect(byId.get('unique')).toMatchObject({ queue_wait_s: 60, publish_wait_s: 60, ci_wall_s: 120 });
    expect(byId.get('first')?.ci_wall_s).toBe(180);
    expect(byId.get('second')?.ci_wall_s).toBeNull();
    expect(fold.unattached_rows).toBe(1);

    const withUndatedCi = foldRouterOutcomes([
      ...rows,
      { event: 'ci_start', url: unique },
    ].map(row => JSON.stringify(row)).join('\n'));
    expect(withUndatedCi.outcomes.find(outcome => outcome.job_id === 'unique')?.ci_wall_s).toBeNull();
  });

  it('folds CI wall seconds from the recorded ci_start/ci_complete pair, unknown when ambiguous', () => {
    const fold = foldRouterOutcomes([
      // C1: one start, one complete 20 minutes later -> 1200s of CI wall.
      '{"job":"C1","event":"ci_start","ts":"2026-11-01T10:00:00Z"}',
      '{"job":"C1","event":"ci_complete","ts":"2026-11-01T10:20:00Z"}',
      '{"job":"C1","phase":"MERGED"}',
      // C2: timestamp and event dialect aliases join like the phase reads.
      '{"job":"C2","kind":"ci_start","at":"2026-11-01T09:00:00Z"}',
      '{"job":"C2","type":"ci_complete","time":"2026-11-01T09:05:00Z"}',
      '{"job":"C2","phase":"CLOSED"}',
      // C3: a start with no recorded complete stays unknown, never zero.
      '{"job":"C3","event":"ci_start","ts":"2026-11-01T10:00:00Z"}',
      // C4: reversed stamps cannot pair — unknown, not a negative duration.
      '{"job":"C4","event":"ci_complete","ts":"2026-11-01T10:00:00Z"}',
      '{"job":"C4","event":"ci_start","ts":"2026-11-01T10:20:00Z"}',
      // C5: a CI re-run records a second pair — ambiguous, stays unknown.
      '{"job":"C5","event":"ci_start","ts":"2026-11-01T10:00:00Z"}',
      '{"job":"C5","event":"ci_complete","ts":"2026-11-01T10:10:00Z"}',
      '{"job":"C5","event":"ci_start","ts":"2026-11-01T11:00:00Z"}',
      '{"job":"C5","event":"ci_complete","ts":"2026-11-01T11:05:00Z"}',
      // C6: identical repeated stamps dedupe — a replayed append is not a re-run.
      '{"job":"C6","event":"ci_start","ts":"2026-11-01T10:00:00Z"}',
      '{"job":"C6","event":"ci_start","ts":"2026-11-01T10:00:00Z"}',
      '{"job":"C6","event":"ci_complete","ts":"2026-11-01T10:30:00Z"}',
      // C7: batch-session infrastructure rows never mint CI evidence.
      '{"job":"RQ-BATCH-c7","event":"ci_start","ts":"2026-11-01T10:00:00Z"}',
      '{"job":"RQ-BATCH-c7","event":"ci_complete","ts":"2026-11-01T10:10:00Z"}',
      // C8: boundary rows without a readable stamp cannot pair.
      '{"job":"C8","event":"ci_start"}',
      '{"job":"C8","event":"ci_complete","ts":"not a date"}',
    ].join('\n'));
    const byId = new Map(fold.outcomes.map(o => [o.job_id, o]));
    expect(byId.get('C1')).toMatchObject({ merged: true, ci_wall_s: 1200 });
    expect(byId.get('C2')).toMatchObject({ merged: false, ci_wall_s: 300 });
    expect(byId.get('C6')).toMatchObject({ ci_wall_s: 1800 });
    for (const id of ['C3', 'C4', 'C5', 'C8']) expect(byId.get(id)?.ci_wall_s).toBeNull();
    expect(byId.has('RQ-BATCH-c7')).toBe(false);
  });

  it('folds publish-station wait from the recorded finish/publish pair, unknown when ambiguous', () => {
    const fold = foldRouterOutcomes([
      // P1: finished 10:00, published 10:20 -> 1200s of publish wait.
      '{"job":"P1","event":"finish","ts":"2026-11-01T10:00:00Z"}',
      '{"job":"P1","event":"publish","ts":"2026-11-01T10:20:00Z"}',
      '{"job":"P1","phase":"MERGED","ts":"2026-11-01T11:00:00Z"}',
      // P2: timestamp and event dialect aliases join like the phase reads —
      // 'published' is the publish spelling visit-sync normalizes.
      '{"job":"P2","kind":"finish","at":"2026-11-01T09:00:00Z"}',
      '{"job":"P2","type":"published","time":"2026-11-01T09:05:00Z"}',
      '{"job":"P2","phase":"CLOSED"}',
      // P3: a finish with no recorded publish stays unknown, never zero.
      '{"job":"P3","event":"finish","ts":"2026-11-01T10:00:00Z"}',
      // P4: reversed stamps cannot pair — unknown, not a negative duration.
      '{"job":"P4","event":"publish","ts":"2026-11-01T10:00:00Z"}',
      '{"job":"P4","event":"finish","ts":"2026-11-01T10:20:00Z"}',
      // P5: a retried attempt records a second finish — ambiguous, stays unknown.
      '{"job":"P5","event":"finish","ts":"2026-11-01T10:00:00Z"}',
      '{"job":"P5","event":"finish","ts":"2026-11-01T10:30:00Z"}',
      '{"job":"P5","event":"publish","ts":"2026-11-01T10:40:00Z"}',
      // P6: a republish records a second publish — ambiguous, stays unknown.
      '{"job":"P6","event":"finish","ts":"2026-11-01T10:00:00Z"}',
      '{"job":"P6","event":"publish","ts":"2026-11-01T10:10:00Z"}',
      '{"job":"P6","event":"publish","ts":"2026-11-01T11:10:00Z"}',
      // P7: identical repeated stamps dedupe — a replayed append is not a republish.
      '{"job":"P7","event":"finish","ts":"2026-11-01T10:00:00Z"}',
      '{"job":"P7","event":"finish","ts":"2026-11-01T10:00:00Z"}',
      '{"job":"P7","event":"publish","ts":"2026-11-01T10:30:00Z"}',
      // P8: the reconciler's copied publish row re-stamped MERGED is verdict
      // evidence at merge time, never a second publish — the original
      // PUBLISHED row still pairs with the finish.
      '{"job":"P8","event":"finish","ts":"2026-11-01T10:00:00Z"}',
      '{"job":"P8","event":"publish","outcome":"PUBLISHED","ts":"2026-11-01T10:20:00Z"}',
      '{"job":"P8","event":"publish","outcome":"MERGED","ts":"2026-11-01T12:00:00Z","mergedAt":"2026-11-01T12:00:00Z"}',
      '{"job":"P8","event":"publish","outcome":"MERGED"}',
      // P9: batch-session infrastructure rows never mint publish evidence.
      '{"job":"RQ-BATCH-p9","event":"finish","ts":"2026-11-01T10:00:00Z"}',
      '{"job":"RQ-BATCH-p9","event":"publish","ts":"2026-11-01T10:10:00Z"}',
      // P10: an eventless PUBLISHED phase row is the publish claim itself.
      '{"job":"P10","event":"finish","ts":"2026-11-01T10:00:00Z"}',
      '{"job":"P10","outcome":"PUBLISHED","ts":"2026-11-01T10:15:00Z"}',
      // P11: boundary rows without a readable stamp cannot pair.
      '{"job":"P11","event":"finish"}',
      '{"job":"P11","event":"publish","ts":"not a date"}',
      // Even with a dated pair, an undated retry or republish is ambiguous.
      '{"job":"P12","event":"finish","ts":"2026-11-01T10:00:00Z"}',
      '{"job":"P12","event":"publish","ts":"2026-11-01T10:20:00Z"}',
      '{"job":"P12","event":"finish"}',
      '{"job":"P13","event":"finish","ts":"2026-11-01T10:00:00Z"}',
      '{"job":"P13","event":"publish","ts":"2026-11-01T10:20:00Z"}',
      '{"job":"P13","outcome":"PUBLISHED","ts":"not a date"}',
    ].join('\n'));
    const byId = new Map(fold.outcomes.map(o => [o.job_id, o]));
    expect(byId.get('P1')).toMatchObject({ merged: true, publish_wait_s: 1200 });
    expect(byId.get('P2')).toMatchObject({ merged: false, publish_wait_s: 300 });
    expect(byId.get('P7')).toMatchObject({ publish_wait_s: 1800 });
    expect(byId.get('P8')).toMatchObject({ merged: true, publish_wait_s: 1200 });
    expect(byId.get('P10')).toMatchObject({ publish_wait_s: 900 });
    for (const id of ['P3', 'P4', 'P5', 'P6', 'P11', 'P12', 'P13']) expect(byId.get(id)?.publish_wait_s).toBeNull();
    expect(byId.has('RQ-BATCH-p9')).toBe(false);
  });

  it('folds the dispatch claim lane override, newest claim stands', () => {
    const fold = foldRouterOutcomes([
      // O1: solo claim that left its hinted lane — the market's recorded pair.
      '{"job":"O1","event":"claim","lane":"claude","lane_hint":"codex-personal","lane_override":"preferred_lane_fallback","lane_hint_blocked_by":["saturated"]}',
      '{"job":"O1","phase":"MERGED"}',
      // O2: override on a first claim, then a re-claim that ran on its hint
      // clears it — the outcome describes the final dispatch.
      '{"job":"O2","event":"claim","lane":"devin","lane_hint":"claude","lane_override":"resource_fit"}',
      '{"job":"O2","event":"claim","lane":"claude"}',
      '{"job":"O2","phase":"MERGED"}',
      // O3: batch member whose session lane differed from its own.
      '{"job":"O3","event":"batch_claim","batch":"RQ-BATCH-o3","lane":"claude","lane_hint":"devin","lane_override":"batch_session"}',
      '{"job":"O3","event":"task_outcome","outcome":"done"}',
      // O4: a claim row carrying a hint but no override reason records no
      // usable pair — the fields stay null like any on-hint claim.
      '{"job":"O4","event":"batch_claim","batch":"RQ-BATCH-o4","lane":"devin","lane_hint":"devin"}',
      // O5: override reason without a recorded hint still joins, hint stays null.
      '{"job":"O5","event":"claim","lane":"alpha","lane_override":"unknown_preference"}',
      // O6: malformed reason or hint is skipped, never recorded raw — and a
      // malformed newest claim preserves the earlier well-formed pair.
      '{"job":"O6","event":"claim","lane":"alpha","lane_hint":"beta","lane_override":"resource_fit"}',
      '{"job":"O6","event":"claim","lane":"gamma","lane_hint":"beta","lane_override":"NOT_A_CODE"}',
      '{"job":"O6","event":"claim","lane":"delta","lane_hint":"bad lane!","lane_override":"resource_fit"}',
      // O7: advisory failover receipts carry the same field names under a
      // different vocabulary and never join.
      '{"job":"O7","event":"failover","lane":"beta","lane_hint":"alpha","lane_override":"failover_quota","failure":"quota"}',
      '{"job":"O7","phase":"MERGED"}',
      // O8: non-claim rows carrying the fields never mint or clear the pair.
      '{"job":"O8","event":"launch","lane":"alpha","lane_hint":"beta","lane_override":"resource_fit"}',
      '{"job":"O8","event":"finish","lane_hint":"beta","lane_override":"resource_fit"}',
      '{"job":"O8","phase":"MERGED"}',
      // O9: claim rows under the type/kind dialect join like the phase reads.
      '{"job":"O9","type":"claim","lane":"alpha","lane_hint":"beta","lane_override":"resource_fit"}',
      '{"job":"O9","phase":"CLOSED"}',
    ].join('\n'));
    const byId = new Map(fold.outcomes.map(o => [o.job_id, o]));
    expect(byId.get('O1')).toMatchObject({ lane: 'claude', lane_hint: 'codex-personal', lane_override: 'preferred_lane_fallback', merged: true });
    expect(byId.get('O2')).toMatchObject({ lane: 'claude', lane_hint: null, lane_override: null });
    expect(byId.get('O3')).toMatchObject({ lane: 'claude', lane_hint: 'devin', lane_override: 'batch_session', task_outcome: 'done' });
    expect(byId.get('O4')).toMatchObject({ lane: 'devin', lane_hint: null, lane_override: null });
    expect(byId.get('O5')).toMatchObject({ lane_hint: null, lane_override: 'unknown_preference' });
    expect(byId.get('O6')).toMatchObject({ lane: 'delta', lane_hint: 'beta', lane_override: 'resource_fit' });
    expect(byId.get('O7')).toMatchObject({ lane: 'beta', lane_hint: null, lane_override: null });
    expect(byId.get('O8')).toMatchObject({ lane_hint: null, lane_override: null });
    expect(byId.get('O9')).toMatchObject({ lane_hint: 'beta', lane_override: 'resource_fit', merged: false });
  });

  it('folds revert evidence from every recorded dialect, sticky-true', () => {
    const fold = foldRouterOutcomes([
      '{"job":"V1","phase":"MERGED","ts":"2026-11-01T00:00:00Z"}',
      '{"job":"V1","event":"revert","ts":"2026-11-02T00:00:00Z"}',
      '{"job":"V1","reverted":false,"ts":"2026-11-03T00:00:00Z"}',
      '{"job":"V2","phase":"MERGED","reverted":true}',
      '{"job":"V3","phase":"MERGED","reverted":false}',
      '{"job":"V4","outcome":"reverted"}',
      '{"job":"V5","state":"REVERTED"}',
      '{"job":"V6","kind":"reverted"}',
      '{"job":"V7","reverted_at":"2026-11-04T00:00:00Z"}',
      '{"job":"V8","revertedAt":"2026-11-04T00:00:00Z"}',
      '{"job":"V9","phase":"MERGED"}',
      '{"job":"V10","event":"revert_coverage","repo":"o/r"}',
      '{"job":"V11","event":"revert-failed"}',
      '{"job":"V12","reverted_at":"not-a-date"}',
    ].join('\n'));
    const byId = new Map(fold.outcomes.map(o => [o.job_id, o]));
    // A recorded revert is never contradicted by a later reverted:false.
    expect(byId.get('V1')).toMatchObject({ merged: true, reverted: true });
    expect(byId.get('V2')).toMatchObject({ merged: true, reverted: true });
    // Explicit reverted:false stands only with no positive evidence.
    expect(byId.get('V3')).toMatchObject({ merged: true, reverted: false });
    for (const id of ['V4', 'V5', 'V6', 'V7', 'V8']) expect(byId.get(id)?.reverted).toBe(true);
    // No evidence stays unknown; coverage markers and failed reverts are not reverts.
    expect(byId.get('V9')?.reverted).toBeNull();
    expect(byId.get('V10')?.reverted).toBeNull();
    expect(byId.get('V11')?.reverted).toBeNull();
    expect(byId.get('V12')?.reverted).toBeNull();
  });

  it('attaches a revert event to its job through an unambiguous PR URL only', () => {
    const fold = foldRouterOutcomes([
      '{"job":"J1","pr_url":"https://github.com/o/r/pull/1","phase":"MERGED"}',
      '{"pr_url":"https://github.com/o/r/pull/1","event":"revert"}',
      '{"job":"A","pr_url":"https://github.com/o/r/pull/7"}',
      '{"job":"B","pr_url":"https://github.com/o/r/pull/7"}',
      '{"pr_url":"https://github.com/o/r/pull/7","event":"revert"}',
      '{"pr_url":"https://github.com/o/r/pull/9","event":"revert"}',
    ].join('\n'));
    expect(fold.outcomes.find(o => o.job_id === 'J1')).toMatchObject({ merged: true, reverted: true });
    // The ambiguous PR's revert row attaches to neither claimant.
    for (const id of ['A', 'B']) expect(fold.outcomes.find(o => o.job_id === id)?.reverted).toBeNull();
    // A revert row with no job or PR claim is unattached, never guessed.
    expect(fold.unattached_rows).toBe(2);
  });

  it('preserves measured zero and false instead of coercing them to null', () => {
    const text = [
      '{"job":"Z1","merged":false,"ci_first_pass":false,"cost_usd":0,"wall_s":0,"review_findings":{"fixed":0,"rejected":0,"ignored":0}}',
    ].join('\n');
    const [o] = foldRouterOutcomes(text).outcomes;
    expect(o).toMatchObject({ merged: false, ci_first_pass: false, cost_usd: 0, wall_s: 0, review_findings: { fixed: 0, rejected: 0, ignored: 0 } });
  });

  it('rejects non-integer or negative review counts instead of recording them', () => {
    const [o] = foldRouterOutcomes('{"job":"R1","review_findings":{"fixed":1.5,"rejected":0,"ignored":0}}').outcomes;
    expect(o!.review_findings).toBeNull();
  });

  it('folds finish-row productivity verdicts, newest explicit value wins', () => {
    const fold = foldRouterOutcomes([
      '{"job":"F1","event":"finish","empty":true,"exit_code":1,"failure_class":"quota","wall_s":10,"tokens_total":1000}',
      '{"job":"F1","event":"finish","empty":false,"exit_code":0,"wall_s":20,"tokens_total":2000}',
      '{"job":"F2","event":"finish","empty":false,"exit_code":-9,"failureClass":"authentication","tokensTotal":500}',
      '{"job":"F3","event":"finish","empty":"yes","exit_code":"1","failure_class":"Not A Label!","tokens_total":"many"}',
      '{"job":"F4","event":"claim"}',
      '{"job":"F5","exitCode":3}',
    ].join('\n'));
    const byId = new Map(fold.outcomes.map(o => [o.job_id, o]));
    // The newest finish row wins per field; an explicit empty:false and exit 0 are measured values.
    expect(byId.get('F1')).toMatchObject({ empty: false, exit_code: 0, failure_class: 'quota', wall_s: 20, tokens_total: 2000 });
    // Negative signal exits stay recorded; the camelCase aliases join too.
    expect(byId.get('F2')).toMatchObject({ empty: false, exit_code: -9, failure_class: 'authentication', tokens_total: 500 });
    // Wrong types and out-of-shape labels are skipped, never coerced or recorded raw.
    expect(byId.get('F3')).toMatchObject({ empty: null, exit_code: null, failure_class: null, tokens_total: null });
    expect(byId.get('F4')).toMatchObject({ empty: null, exit_code: null, failure_class: null });
    expect(byId.get('F5')).toMatchObject({ exit_code: 3 });
  });

  it('folds the finish row failure classification across failure_class, failure_reason and pool_error', () => {
    const fold = foldRouterOutcomes([
      // dispatchd writes failure_class only for the devin pool; other lanes
      // record failure_reason or pool_error instead.
      '{"job":"G1","event":"finish","empty":true,"exit_code":124,"failure_reason":"launch_timeout"}',
      '{"job":"G2","event":"finish","exit_code":1,"pool_error":"rate_limit"}',
      '{"job":"G3","event":"finish","exit_code":1,"pool_error":"usage_limit","failure_reason":"provider_usage_limit"}',
      '{"job":"G4","event":"finish","exit_code":1,"failure_class":"quota","failure_reason":"agent_exit_nonzero","pool_error":"model_capacity"}',
      '{"job":"G5","event":"finish","exit_code":1,"failureReason":"exit_status_missing","poolError":"credits_exhausted"}',
      '{"job":"G6","event":"finish","exit_code":1,"pool_error":"Not A Label!"}',
      // Newest explicit classification wins; a later row without one keeps it.
      '{"job":"G7","event":"finish","exit_code":1,"pool_error":"rate_limit"}',
      '{"job":"G7","event":"finish","exit_code":1,"failure_reason":"launch_timeout"}',
      '{"job":"G7","event":"finish","exit_code":0}',
    ].join('\n'));
    const byId = new Map(fold.outcomes.map(o => [o.job_id, o]));
    expect(byId.get('G1')?.failure_class).toBe('launch_timeout');
    expect(byId.get('G2')?.failure_class).toBe('rate_limit');
    // failure_reason outranks pool_error on the same row.
    expect(byId.get('G3')?.failure_class).toBe('provider_usage_limit');
    // failure_class outranks both fallbacks.
    expect(byId.get('G4')?.failure_class).toBe('quota');
    // camelCase spellings join in the same precedence.
    expect(byId.get('G5')?.failure_class).toBe('exit_status_missing');
    // Out-of-shape labels are skipped, never recorded raw.
    expect(byId.get('G6')?.failure_class).toBeNull();
    // The newest classified row wins; a later row with none keeps it.
    expect(byId.get('G7')?.failure_class).toBe('launch_timeout');
  });

  it('folds a dead launch give_up reason into failure_class, never a retry receipt or launch_terminal', () => {
    const fold = foldRouterOutcomes([
      // dispatchd's launch_failed receipt: action=retry is transient
      // backoff, action=give_up is the recorded cause for a launch the
      // dispatcher will not retry (budget spent or permanent failure).
      '{"job":"L1","event":"launch_failed","reason":"provider_unavailable","action":"retry","attempt":1}',
      '{"job":"L1","event":"launch_failed","reason":"provider_unavailable","class":"retryable","action":"give_up","attempt":3,"lane":"alpha"}',
      '{"job":"L2","event":"launch_failed","reason":"authentication","class":"permanent","action":"give_up","attempt":1}',
      // launch_terminal rows fire on requeues and skips too — never a class.
      '{"job":"L3","event":"launch_terminal","reason":"launcher-exited"}',
      '{"job":"L3","event":"launch_terminal","reason":"spawn-failed"}',
      // A give_up row without a bounded reason label stays unknown, as do
      // retry receipts, missing actions and other launch_failed reasons
      // spelled outside the identifier shape.
      '{"job":"L4","event":"launch_failed","reason":"Not A Label!","action":"give_up"}',
      '{"job":"L5","event":"launch_failed","reason":"launch_timeout","action":"retry"}',
      '{"job":"L6","event":"launch_failed","reason":"launch_timeout"}',
      // The receipt's class field describes retryability, not cause.
      '{"job":"L7","event":"launch_failed","class":"permanent","action":"give_up"}',
      // Newest recognized classification wins across finish and launch
      // rows in either order.
      '{"job":"L8","event":"finish","exit_code":1,"pool_error":"rate_limit"}',
      '{"job":"L8","event":"launch_failed","reason":"resource_exhausted","action":"give_up"}',
      '{"job":"L9","event":"launch_failed","reason":"launch_timeout","action":"give_up"}',
      '{"job":"L9","event":"finish","exit_code":1,"failure_reason":"agent_exit_nonzero"}',
      // Dialect spellings: type/kind event names and an uppercase action.
      '{"job":"L10","kind":"launch_failed","reason":"launch_interrupted","action":"GIVE_UP"}',
    ].join('\n'));
    const byId = new Map(fold.outcomes.map(o => [o.job_id, o]));
    expect(byId.get('L1')?.failure_class).toBe('provider_unavailable');
    expect(byId.get('L1')?.lane).toBe('alpha');
    expect(byId.get('L2')?.failure_class).toBe('authentication');
    expect(byId.get('L3')?.failure_class).toBeNull();
    expect(byId.get('L4')?.failure_class).toBeNull();
    expect(byId.get('L5')?.failure_class).toBeNull();
    expect(byId.get('L6')?.failure_class).toBeNull();
    expect(byId.get('L7')?.failure_class).toBeNull();
    expect(byId.get('L8')?.failure_class).toBe('resource_exhausted');
    expect(byId.get('L9')?.failure_class).toBe('agent_exit_nonzero');
    expect(byId.get('L10')?.failure_class).toBe('launch_interrupted');
  });

  it('folds the finish row empty_class in its closed classify_empty vocabulary', () => {
    const fold = foldRouterOutcomes([
      // dispatchd writes empty_class from classify_empty: no_diff for a
      // clean empty finish, error for a nonzero exit or pool error, unknown
      // when no exit status was recorded.
      '{"job":"E1","event":"finish","empty":true,"exit_code":0,"empty_class":"no_diff"}',
      '{"job":"E2","event":"finish","empty":true,"exit_code":1,"empty_class":"error"}',
      '{"job":"E3","event":"finish","empty":true,"empty_class":"unknown"}',
      // camelCase spelling joins; null and non-empty finishes carry nothing.
      '{"job":"E4","event":"finish","empty":true,"exit_code":0,"emptyClass":"no_diff"}',
      '{"job":"E5","event":"finish","empty":false,"exit_code":0,"empty_class":null}',
      // Out-of-vocabulary spellings are skipped, never recorded raw.
      '{"job":"E6","event":"finish","empty":true,"empty_class":"infra"}',
      '{"job":"E7","event":"finish","empty":true,"empty_class":"Error"}',
      '{"job":"E8","event":"finish","empty":true,"empty_class":42}',
      // The newest recognized value wins; a later row without one keeps it.
      '{"job":"E9","event":"finish","empty":true,"exit_code":1,"empty_class":"error"}',
      '{"job":"E9","event":"finish","empty":true,"exit_code":0,"empty_class":"no_diff"}',
      '{"job":"E9","event":"finish","empty":false,"exit_code":0}',
      '{"job":"E10","event":"claim"}',
    ].join('\n'));
    const byId = new Map(fold.outcomes.map(o => [o.job_id, o]));
    expect(byId.get('E1')?.empty_class).toBe('no_diff');
    expect(byId.get('E2')?.empty_class).toBe('error');
    expect(byId.get('E3')?.empty_class).toBe('unknown');
    expect(byId.get('E4')?.empty_class).toBe('no_diff');
    expect(byId.get('E5')?.empty_class).toBeNull();
    expect(byId.get('E6')?.empty_class).toBeNull();
    expect(byId.get('E7')?.empty_class).toBeNull();
    expect(byId.get('E8')?.empty_class).toBeNull();
    // Newest recognized wins; the trailing finish row carried no class.
    expect(byId.get('E9')?.empty_class).toBe('no_diff');
    expect(byId.get('E10')?.empty_class).toBeNull();
  });

  it('folds the finish row usage block and diff metrics, newest explicit value wins', () => {
    const fold = foldRouterOutcomes([
      // dispatchd's job_usage spread: ACU spend, the token breakdown and
      // the provenance labels, beside job_diff_metrics' diff size.
      '{"job":"U1","event":"finish","lane":"devin","acus":2.5,"tokens_in":900,"tokens_out":300,' +
        '"tokens_cache_read":400,"tokens_cache_write":50,"tokens_total":1250,' +
        '"usage_source":"devin-sessions-db","diff_files":7,"diff_lines":420}',
      // A later finish row replaces each recorded figure independently.
      '{"job":"U1","event":"finish","acus":3,"tokensIn":1000,"tokensOut":350,"tokensCacheRead":450,' +
        '"tokensCacheWrite":60,"usageSource":"tokens-line","diffFiles":8,"diffLines":460}',
      // claude dialect spelling plus snake_case provenance.
      '{"job":"U2","event":"finish","lane":"claude","tokens_in":2000,"tokens_out":800,' +
        '"usage_source":"claude-result-json","usage_missing":null,"diff_files":3,"diff_lines":null}',
      // A recorded capture gap joins as a bounded label; wrong types and
      // out-of-shape labels are skipped, never recorded raw. snake_case
      // wins over camelCase on the same row.
      '{"job":"U3","event":"finish","tokens_total":null,"usage_missing":"tokens-line-not-in-log","usageMissing":"devin-usage-incomplete"}',
      '{"job":"U4","event":"finish","usage_missing":"Not A Label!","usage_source":"Two Words","usageMissing":"also bad!"}',
      '{"job":"U5","event":"finish","acus":"many","tokens_in":"lots","diff_files":-1,"diff_lines":"x"}',
      '{"job":"U6","event":"claim"}',
      // acus_consumed/acusConsumed and camelCase usage spellings join too.
      '{"job":"U7","event":"finish","acus_consumed":1.25}',
      '{"job":"U8","event":"finish","acusConsumed":2,"usageMissing":"claude-result-not-in-log"}',
    ].join('\n'));
    const byId = new Map(fold.outcomes.map(o => [o.job_id, o]));
    expect(byId.get('U1')).toMatchObject({
      acus: 3, tokens_in: 1000, tokens_out: 350, tokens_cache_read: 450, tokens_cache_write: 60,
      usage_source: 'tokens-line', diff_files: 8, diff_lines: 460,
    });
    expect(byId.get('U2')).toMatchObject({
      tokens_in: 2000, tokens_out: 800, usage_source: 'claude-result-json',
      usage_missing: null, diff_files: 3, diff_lines: null,
    });
    // snake_case outranks camelCase on the same row; U3's tokens_total
    // stayed unrecorded.
    expect(byId.get('U3')).toMatchObject({ usage_missing: 'tokens-line-not-in-log', tokens_total: null });
    expect(byId.get('U4')).toMatchObject({ usage_missing: null, usage_source: null });
    expect(byId.get('U5')).toMatchObject({ acus: null, tokens_in: null, diff_files: null, diff_lines: null });
    expect(byId.get('U6')).toMatchObject({ acus: null, usage_missing: null, diff_files: null });
    expect(byId.get('U7')?.acus).toBe(1.25);
    expect(byId.get('U8')).toMatchObject({ acus: 2, usage_missing: 'claude-result-not-in-log' });
  });

  it('folds the recorded repo cell newest-explicit-wins in the bounded repo shape', () => {
    const fold = foldRouterOutcomes([
      // dispatchd writes the ready line's repo cell on its queue rows.
      '{"job":"R1","event":"enqueue","repo":"phantom"}',
      '{"job":"R1","event":"claim","lane":"alpha","repo":"lexicon"}',
      // A later row without repo leaves the standing record alone.
      '{"job":"R1","event":"finish","lane":"alpha","phase":"MERGED"}',
      // owner/repo pairs and mixed-case segments join in the same shape.
      '{"job":"R2","event":"launch","repo":"ashlrai/phantom"}',
      '{"job":"R3","event":"task_outcome","outcome":"done","repo":"EXAMPLE/PHANTOM"}',
      // Absolute paths, whitespace, deeper paths and non-strings are
      // skipped — the earlier bounded value stands, never recorded raw.
      '{"job":"R1","event":"outcome","repo":"/Users/someone/Desktop/github/dev-tools/ashlr-hub"}',
      '{"job":"R1","event":"outcome","repo":"not a repo!"}',
      '{"job":"R1","event":"outcome","repo":"a/b/c"}',
      '{"job":"R1","event":"outcome","repo":42}',
      // A job whose rows never recorded repo stays null — unknown.
      '{"job":"R4","event":"claim","lane":"beta"}',
    ].join('\n'));
    const byId = new Map(fold.outcomes.map(o => [o.job_id, o]));
    expect(byId.get('R1')).toMatchObject({ repo: 'lexicon', merged: true });
    expect(byId.get('R2')?.repo).toBe('ashlrai/phantom');
    expect(byId.get('R3')?.repo).toBe('EXAMPLE/PHANTOM');
    expect(byId.get('R4')?.repo).toBeNull();
  });

  it('skips RQ-BATCH-* session rows and folds member task_outcome words', () => {
    const fold = foldRouterOutcomes([
      // Session infrastructure: launch and finish rows keyed by the bundle
      // id carry session-aggregate evidence no member owns.
      '{"job":"RQ-BATCH-abc123","event":"launch","lane":"alpha","wall_s":900,"tokens_total":50000}',
      '{"job":"RQ-BATCH-abc123","event":"finish","lane":"alpha","wall_s":900,"exit_code":0,"empty":false,"tokens_total":50000,"pr_url":"https://github.com/o/r/pull/77"}',
      // Members arrive through batch_claim and close through task_outcome;
      // they never get per-member launch/finish rows of their own.
      '{"job":"M1","event":"batch_claim","batch":"RQ-BATCH-abc123","lane":"alpha","tier":"work"}',
      '{"job":"M1","event":"task_outcome","batch":"RQ-BATCH-abc123","lane":"alpha","outcome":"failed","reason":"crash"}',
      '{"job":"M2","event":"batch_claim","batch":"RQ-BATCH-abc123","lane":"alpha","tier":"work"}',
      '{"job":"M2","event":"task_outcome","batch":"RQ-BATCH-abc123","lane":"alpha","outcome":"done"}',
      // A later task_outcome row is the member's newest recorded word.
      '{"job":"M2","event":"task_outcome","batch":"RQ-BATCH-abc123","lane":"alpha","outcome":"skipped"}',
      // Unrecognized words and non-task_outcome rows never set the field.
      '{"job":"M3","event":"batch_claim","batch":"RQ-BATCH-abc123","lane":"alpha"}',
      '{"job":"M3","event":"task_outcome","batch":"RQ-BATCH-abc123","lane":"alpha","outcome":"exploded"}',
      '{"job":"M3","event":"outcome","outcome":"done"}',
      '{"job":"M3","event":"task_outcome","batch":"RQ-BATCH-abc123","lane":"alpha","outcome":"deferred"}',
      // A solo job's rows are untouched by the batch dialect.
      '{"job":"S1","event":"finish","lane":"alpha","empty":false,"exit_code":0,"outcome":"done"}',
    ].join('\n'));
    expect(fold.session_rows).toBe(2);
    expect(fold.outcomes.map(o => o.job_id)).toEqual(['M1', 'M2', 'M3', 'S1']);
    const byId = new Map(fold.outcomes.map(o => [o.job_id, o]));
    // The session's finish verdicts and usage stay session evidence: members
    // keep their own fields null rather than split the aggregate.
    for (const id of ['M1', 'M2', 'M3']) {
      expect(byId.get(id)).toMatchObject({
        wall_s: null, tokens_total: null, empty: null, exit_code: null, failure_class: null,
      });
    }
    expect(byId.get('M1')?.task_outcome).toBe('failed');
    // Newest recognized task_outcome word wins.
    expect(byId.get('M2')?.task_outcome).toBe('skipped');
    // An out-of-vocabulary word and a non-task_outcome outcome field are
    // skipped; the later deferred row still lands.
    expect(byId.get('M3')?.task_outcome).toBe('deferred');
    // A solo job's outcome-named phase field is merge evidence, not a member word.
    expect(byId.get('S1')?.task_outcome).toBeNull();
    expect(byId.get('S1')?.empty).toBe(false);
    expect(byId.get('S1')?.exit_code).toBe(0);
  });

  it('keys fleet.session-pool.v1 rows on jobId, never the attempt job', () => {
    const fold = foldRouterOutcomes([
      // Session lifecycle rows carry no job fields: session_start and
      // session_stop stay unattached like every jobless ledger row.
      '{"schema":"fleet.session-pool.v1","ts":"2026-11-20T10:00:00Z","sessionId":"sess-a","event":"session_start","context":0}',
      // Task rows carry two ids under the producer's contract: `job` is the
      // per-attempt id (<sessionId>:<n>) and `jobId` the logical queue id.
      // Only jobId may key an outcome — the attempt id is session machinery.
      '{"schema":"fleet.session-pool.v1","ts":"2026-11-20T10:00:01Z","sessionId":"sess-a","event":"launch","context":0,"job":"sess-a:1","jobId":"ready:RQ-NODE-1:1"}',
      '{"schema":"fleet.session-pool.v1","ts":"2026-11-20T10:05:00Z","sessionId":"sess-a","event":"finish","context":0,"job":"sess-a:1","jobId":"ready:RQ-NODE-1:1","outcome":"completed"}',
      // A second queue job in the same session gets its own outcome.
      '{"schema":"fleet.session-pool.v1","ts":"2026-11-20T10:05:01Z","sessionId":"sess-a","event":"launch","context":0,"job":"sess-a:2","jobId":"ready:RQ-NODE-2:1"}',
      '{"schema":"fleet.session-pool.v1","ts":"2026-11-20T10:09:00Z","sessionId":"sess-a","event":"finish","context":0,"job":"sess-a:2","jobId":"ready:RQ-NODE-2:1","outcome":"lease-expiry"}',
      '{"schema":"fleet.session-pool.v1","ts":"2026-11-20T10:09:01Z","sessionId":"sess-a","event":"session_stop","context":0}',
      // A queue job retried by a later session folds into the same outcome —
      // one outcome per logical queue job, not per session attempt.
      '{"schema":"fleet.session-pool.v1","ts":"2026-11-20T11:00:00Z","sessionId":"sess-b","event":"launch","context":0,"job":"sess-b:1","jobId":"ready:RQ-NODE-1:1"}',
      '{"schema":"fleet.session-pool.v1","ts":"2026-11-20T11:04:00Z","sessionId":"sess-b","event":"finish","context":0,"job":"sess-b:1","jobId":"ready:RQ-NODE-1:1","outcome":"completed"}',
      // A session-pool row carrying the attempt id without jobId has no
      // logical job identity — the attempt id never keys an outcome.
      '{"schema":"fleet.session-pool.v1","ts":"2026-11-20T11:05:00Z","sessionId":"sess-b","event":"launch","context":0,"job":"sess-b:2"}',
      // session_rotate attaches to the just-pulled task's outcome like any
      // other row but mints no verdict of its own.
      '{"schema":"fleet.session-pool.v1","ts":"2026-11-20T11:04:30Z","sessionId":"sess-b","event":"session_rotate","context":1,"job":"sess-b:1","jobId":"ready:RQ-NODE-1:1"}',
      // Rows under any other schema keep the standard job|job_id|jobId|id
      // precedence — a foreign schema's job field still wins.
      '{"schema":"other.v9","job":"attempt-9","jobId":"logical-9","event":"finish"}',
    ].join('\n'));
    expect(fold.unattached_rows).toBe(3);
    expect(fold.outcomes.map(o => o.job_id)).toEqual([
      'ready:RQ-NODE-1:1', 'ready:RQ-NODE-2:1', 'attempt-9',
    ]);
    const byId = new Map(fold.outcomes.map(o => [o.job_id, o]));
    // Node completion is not a merge verdict: 'completed'/'lease-expiry'
    // finish outcomes and the session_rotate row leave merged null, and no
    // session-pool field mints productivity or launch verdicts.
    for (const id of ['ready:RQ-NODE-1:1', 'ready:RQ-NODE-2:1']) {
      expect(byId.get(id)).toMatchObject({
        merged: null, reverted: null, lane: null, model: null, work_class: null,
        empty: null, exit_code: null, failure_class: null, task_outcome: null,
        skipped: null, deferred: null, noop: null,
      });
    }
    // The retried queue job's rows folded into one outcome; the foreign
    // schema row kept job-first precedence.
    expect(byId.get('ready:RQ-NODE-1:1')).toBeDefined();
    expect(byId.get('attempt-9')).toMatchObject({ merged: null });
    expect(fold.outcomes.some(o => o.job_id.startsWith('sess-'))).toBe(false);
  });

  it('keys phm-node-runner.v1 rows on jobId and folds the runner verdict', () => {
    const fold = foldRouterOutcomes([
      // The runner's finish rows carry two ids under the producer's
      // contract: `job` is the per-claim id (<jobId>:<token>) and `jobId`
      // the logical node-queue id. Only jobId may key an outcome — the
      // claim-scoped id never mints a phantom outcome.
      '{"schema":"phm-node-runner.v1","ts":"2026-11-20T10:00:00Z","event":"finish","job":"ready:RQ-NODE-1:1:4","jobId":"ready:RQ-NODE-1:1","node":"muse","pack":"shell-check","token":4,"leaderToken":3,"outcome":"succeeded","outputBytes":4242}',
      // A second node job gets its own outcome.
      '{"schema":"phm-node-runner.v1","ts":"2026-11-20T10:05:00Z","event":"finish","job":"ready:RQ-NODE-2:1:7","jobId":"ready:RQ-NODE-2:1","node":"mini","pack":"omlx-chat","token":7,"leaderToken":3,"outcome":"failed"}',
      // A retried claim of the same queue job folds into the same
      // outcome — one outcome per logical node job, not per claim.
      '{"schema":"phm-node-runner.v1","ts":"2026-11-20T11:00:00Z","event":"finish","job":"ready:RQ-NODE-1:1:9","jobId":"ready:RQ-NODE-1:1","node":"studio","pack":"codex-file","token":9,"leaderToken":5,"outcome":"fenced"}',
      // A runner row carrying the claim id without jobId has no logical
      // job identity — the attempt id never keys an outcome.
      '{"schema":"phm-node-runner.v1","ts":"2026-11-20T11:01:00Z","event":"finish","job":"ready:RQ-NODE-3:1:2","node":"muse","pack":"shell-check","outcome":"succeeded"}',
      // Rows under any other schema keep the standard job-first
      // precedence — a foreign schema's job field still wins.
      '{"schema":"other.v9","job":"attempt-9","jobId":"logical-9","event":"finish"}',
    ].join('\n'));
    expect(fold.unattached_rows).toBe(1);
    expect(fold.outcomes.map(o => o.job_id)).toEqual([
      'ready:RQ-NODE-1:1', 'ready:RQ-NODE-2:1', 'attempt-9',
    ]);
    const byId = new Map(fold.outcomes.map(o => [o.job_id, o]));
    // The execution verdict is not a merge verdict: succeeded/failed/
    // fenced leave merged null, and fencing tokens never join.
    expect(byId.get('ready:RQ-NODE-1:1')).toMatchObject({
      node_outcome: 'fenced', node_id: 'studio', node_pack: 'codex-file',
      merged: null, lane: null, work_class: null, empty: null, exit_code: null,
      failure_class: null, task_outcome: null, skipped: null, deferred: null, noop: null,
    });
    expect(byId.get('ready:RQ-NODE-2:1')).toMatchObject({
      node_outcome: 'failed', node_id: 'mini', node_pack: 'omlx-chat', merged: null,
    });
    expect(byId.get('attempt-9')).toMatchObject({ node_outcome: null, merged: null });
    expect(fold.outcomes.some(o => o.job_id.includes(':4') || o.job_id.includes(':9'))).toBe(false);
  });

  it('bounds node runner verdict evidence and keeps unknown null', () => {
    const fold = foldRouterOutcomes([
      // An outcome word outside the closed vocabulary skips the row's
      // node evidence entirely — never recorded raw — while the row
      // still keys its outcome on jobId.
      '{"schema":"phm-node-runner.v1","event":"finish","job":"ready:A:1:1","jobId":"ready:A:1","node":"muse","pack":"shell-check","outcome":"Succeeded"}',
      '{"schema":"phm-node-runner.v1","event":"finish","job":"ready:B:1:1","jobId":"ready:B:1","node":"muse","pack":"shell-check","outcome":"bogus-word"}',
      // Malformed node/pack values drop to null without discarding the
      // recorded verdict.
      '{"schema":"phm-node-runner.v1","event":"finish","job":"ready:C:1:1","jobId":"ready:C:1","node":"bad node!","pack":"ok-pack","outcome":"succeeded"}',
      '{"schema":"phm-node-runner.v1","event":"finish","job":"ready:D:1:1","jobId":"ready:D:1","pack":"shell-check","outcome":"fenced"}',
      // The newest recognized runner row replaces the triple wholesale;
      // an unrecognized later row leaves the standing verdict alone.
      '{"schema":"phm-node-runner.v1","event":"finish","job":"ready:E:1:1","jobId":"ready:E:1","node":"muse","pack":"shell-check","outcome":"succeeded"}',
      '{"schema":"phm-node-runner.v1","event":"finish","job":"ready:E:1:2","jobId":"ready:E:1","node":"studio","pack":"codex-file","outcome":"failed"}',
      '{"schema":"phm-node-runner.v1","event":"finish","job":"ready:E:1:3","jobId":"ready:E:1","node":"other","pack":"other-pack","outcome":"unrecognized"}',
      // A non-runner row never mints node evidence even carrying the
      // lookalike fields.
      '{"job":"F1","event":"finish","outcome":"succeeded","node":"muse","pack":"shell-check"}',
    ].join('\n'));
    const byId = new Map(fold.outcomes.map(o => [o.job_id, o]));
    expect(byId.get('ready:A:1')).toMatchObject({ node_outcome: null, node_id: null, node_pack: null });
    expect(byId.get('ready:B:1')).toMatchObject({ node_outcome: null, node_id: null, node_pack: null });
    expect(byId.get('ready:C:1')).toMatchObject({ node_outcome: 'succeeded', node_id: null, node_pack: 'ok-pack' });
    expect(byId.get('ready:D:1')).toMatchObject({ node_outcome: 'fenced', node_id: null, node_pack: 'shell-check' });
    expect(byId.get('ready:E:1')).toMatchObject({ node_outcome: 'failed', node_id: 'studio', node_pack: 'codex-file' });
    expect(byId.get('F1')).toMatchObject({ node_outcome: null, node_id: null, node_pack: null, merged: null });
  });

  it('folds the claim lane-hint blocking codes, newest claim stands', () => {
    const fold = foldRouterOutcomes([
      // B1: solo claim that left its hinted lane — the market's recorded
      // rejected-lane reason codes join in recorded order.
      '{"job":"B1","event":"claim","lane":"claude","lane_hint":"codex-personal","lane_override":"preferred_lane_fallback","lane_hint_blocked_by":["quota_exhausted","saturated"]}',
      '{"job":"B1","phase":"MERGED"}',
      // B2: override then a re-claim that ran on its hint clears the codes.
      '{"job":"B2","event":"claim","lane":"devin","lane_hint":"claude","lane_override":"resource_fit","lane_hint_blocked_by":["lower_rank"]}',
      '{"job":"B2","event":"claim","lane":"claude"}',
      // B3: batch member whose session lane differed — batch_claim never
      // carries the field, so the codes stay unrecorded (null), never [].
      '{"job":"B3","event":"batch_claim","batch":"RQ-BATCH-b3","lane":"claude","lane_hint":"devin","lane_override":"batch_session"}',
      // B4: a recorded empty list is the market's "nothing blocked it"
      // verdict — it stays [] and is distinct from missing evidence.
      '{"job":"B4","event":"claim","lane":"alpha","lane_hint":"beta","lane_override":"resource_fit","lane_hint_blocked_by":[]}',
      // B5: non-array values and lists whose entries are all
      // unrecognizable read as unrecorded — never guessed, never raw.
      '{"job":"B5","event":"claim","lane":"alpha","lane_hint":"beta","lane_override":"resource_fit","lane_hint_blocked_by":"quota_exhausted"}',
      '{"job":"B5","event":"claim","lane":"alpha","lane_hint":"beta","lane_override":"preferred_lane_fallback","lane_hint_blocked_by":["NOT_A_CODE",42,null]}',
      // B6: duplicate and over-bound entries dedupe/cap; malformed reason
      // or hint skips the row and preserves the earlier well-formed codes.
      '{"job":"B6","event":"claim","lane":"alpha","lane_hint":"beta","lane_override":"preferred_lane_fallback","lane_hint_blocked_by":["held","held","saturated"]}',
      '{"job":"B6","event":"claim","lane":"gamma","lane_hint":"beta","lane_override":"NOT_A_CODE","lane_hint_blocked_by":["quota_exhausted"]}',
      '{"job":"B6","event":"claim","lane":"delta","lane_hint":"bad lane!","lane_override":"preferred_lane_fallback","lane_hint_blocked_by":["provider_backoff"]}',
      // B7: advisory failover receipts carry lookalike fields under a
      // different vocabulary and never join.
      '{"job":"B7","event":"failover","lane":"beta","lane_hint":"alpha","lane_override":"failover_quota","lane_hint_blocked_by":["quota_exhausted"],"failure":"quota"}',
      '{"job":"B7","phase":"MERGED"}',
      // B8: non-claim rows carrying the fields never mint or clear codes.
      '{"job":"B8","event":"launch","lane":"alpha","lane_hint":"beta","lane_override":"resource_fit","lane_hint_blocked_by":["saturated"]}',
      '{"job":"B8","event":"finish","lane_hint_blocked_by":["saturated"]}',
      '{"job":"B8","phase":"MERGED"}',
      // B9: claim rows under the type/kind dialect join like the phase reads.
      '{"job":"B9","type":"claim","lane":"alpha","lane_hint":"beta","lane_override":"preferred_lane_fallback","lane_hint_blocked_by":["hysteresis_move_cap"]}',
      '{"job":"B9","phase":"CLOSED"}',
      // B10: an override reason without a recorded hint still joins the
      // codes — the hint shape gates the pair, not the code list.
      '{"job":"B10","event":"claim","lane":"alpha","lane_override":"unknown_preference","lane_hint_blocked_by":[]}',
    ].join('\n'));
    const byId = new Map(fold.outcomes.map(o => [o.job_id, o]));
    expect(byId.get('B1')).toMatchObject({ lane_hint_blocked_by: ['quota_exhausted', 'saturated'], merged: true });
    expect(byId.get('B2')).toMatchObject({ lane_hint_blocked_by: null });
    expect(byId.get('B3')).toMatchObject({ lane_hint_blocked_by: null });
    expect(byId.get('B4')).toMatchObject({ lane_hint_blocked_by: [] });
    expect(byId.get('B5')).toMatchObject({ lane_hint_blocked_by: null });
    // Malformed newest claims preserve the earlier well-formed codes;
    // duplicates fold once in recorded order.
    expect(byId.get('B6')).toMatchObject({ lane_hint_blocked_by: ['held', 'saturated'] });
    expect(byId.get('B7')).toMatchObject({ lane_hint_blocked_by: null, merged: true });
    expect(byId.get('B8')).toMatchObject({ lane_hint_blocked_by: null, merged: true });
    expect(byId.get('B9')).toMatchObject({ lane_hint_blocked_by: ['hysteresis_move_cap'], merged: false });
    expect(byId.get('B10')).toMatchObject({ lane_hint_blocked_by: [] });
  });

  it('folds the skip gate\'s launch declines, newest dispatch supersedes', () => {
    const fold = foldRouterOutcomes([
      // K1: empty-gate decline — the recorded reason label joins.
      '{"job":"K1","event":"skipped_empty","lane":"alpha","reason":"prompt_empty_same_base_24h","repo":"phantom","task_hash":"abc"}',
      // K2: precheck decline — the gate's integer exit code joins skip_code,
      // never a guessed reason.
      '{"job":"K2","event":"skipped_empty","lane":"beta","repo":"phantom","code":13}',
      // K3: the precheck_skip spelling sibling readers honor joins alike.
      '{"job":"K3","type":"precheck_skip","lane":"alpha","code":14}',
      // K4: a bounded string code is the skip's label when no reason exists.
      '{"job":"K4","event":"skipped_empty","lane":"alpha","code":"dup"}',
      // K5: declined, then dispatched — the claim supersedes to false and
      // clears the recorded label wholesale.
      '{"job":"K5","event":"skipped_empty","lane":"alpha","reason":"task_empty_repeat_24h"}',
      '{"job":"K5","event":"claim","lane":"alpha"}',
      // K6: declined, then a batch member's session claim supersedes too.
      '{"job":"K6","event":"skipped_empty","lane":"alpha","reason":"upkeep_empty_same_base"}',
      '{"job":"K6","event":"batch_claim","batch":"RQ-BATCH-k6","lane":"alpha"}',
      // K7: the dry-run receipt records the job still launched — it clears
      // a standing decline but never mints one of its own.
      '{"job":"K7","event":"skipped_empty","lane":"alpha","reason":"prompt_empty_same_base_24h"}',
      '{"job":"K7","event":"skipped_empty","lane":"alpha","reason":"task_empty_repeat_24h","applied":false}',
      // K8: a later real decline after the dry run stands again, and the
      // newest skip row replaces reason/code wholesale.
      '{"job":"K8","event":"skipped_empty","lane":"alpha","reason":"prompt_empty_same_base_24h","code":11}',
      '{"job":"K8","event":"skipped_empty","lane":"alpha","code":12}',
      // K9: finish/publish/outcome rows belong to attempts already decided
      // and never touch the standing decline.
      '{"job":"K9","event":"skipped_empty","lane":"alpha","reason":"prompt_empty_same_base_24h"}',
      '{"job":"K9","event":"finish","lane":"alpha","empty":true,"exit_code":0}',
      '{"job":"K9","event":"publish","pr_url":"https://github.com/o/r/pull/21"}',
      // K10: the detailed dupcheck receipt never joins — its paired
      // skipped_empty row already carries the canonical decline.
      '{"job":"K10","event":"dupcheck_skip","lane":"alpha","reason":"already_on_master","evidence":"https://github.com/o/r/pull/22"}',
      // K11: unbounded reason text and non-skip events mint nothing.
      '{"job":"K11","event":"skipped_empty","lane":"alpha","reason":"not a bounded label!"}',
      '{"job":"K11","event":"enqueue","lane":"alpha"}',
      // K12: a launch row supersedes like claim does.
      '{"job":"K12","event":"skipped_empty","lane":"alpha","code":13}',
      '{"job":"K12","event":"launch","lane":"alpha"}',
    ].join('\n'));
    const byId = new Map(fold.outcomes.map(o => [o.job_id, o]));
    expect(byId.get('K1')).toMatchObject({ skipped: true, skip_reason: 'prompt_empty_same_base_24h', skip_code: null });
    expect(byId.get('K2')).toMatchObject({ skipped: true, skip_reason: null, skip_code: 13 });
    expect(byId.get('K3')).toMatchObject({ skipped: true, skip_reason: null, skip_code: 14 });
    expect(byId.get('K4')).toMatchObject({ skipped: true, skip_reason: 'dup', skip_code: null });
    expect(byId.get('K5')).toMatchObject({ skipped: false, skip_reason: null, skip_code: null });
    expect(byId.get('K6')).toMatchObject({ skipped: false, skip_reason: null, skip_code: null });
    expect(byId.get('K7')).toMatchObject({ skipped: false, skip_reason: null, skip_code: null });
    // The newest skip row replaced reason and code wholesale: the earlier
    // reason is gone and the later integer code is the standing record.
    expect(byId.get('K8')).toMatchObject({ skipped: true, skip_reason: null, skip_code: 12 });
    expect(byId.get('K9')).toMatchObject({ skipped: true, skip_reason: 'prompt_empty_same_base_24h', empty: true });
    expect(byId.get('K10')).toMatchObject({ skipped: null, skip_reason: null, skip_code: null });
    expect(byId.get('K11')).toMatchObject({ skipped: true, skip_reason: null, skip_code: null });
    expect(byId.get('K12')).toMatchObject({ skipped: false, skip_reason: null, skip_code: null });
  });

  it('folds the keep-queued verdicts, newest dispatch or decline supersedes', () => {
    const fold = foldRouterOutcomes([
      // D1: duplicate-request deferral — reason and covering job join.
      '{"job":"D1","event":"dispatch_deferred","repo":"phantom","reason":"duplicate-request","repeatOf":"RQ-OWNER-1"}',
      // D2: recut admission defer — the in-flight prior joins as the cover.
      '{"job":"D2","event":"recut_admission","repo":"phantom","reason":"recut-in-flight","action":"defer","repeatOf":"RQ-RECUT-9","targetPr":9,"headSha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}',
      // D3: precheck park — the bounded park reason joins, no cover exists.
      '{"job":"D3","event":"precheck_parked","repo":"phantom","lane":"alpha","code":13,"reason":"files_and_tests_exist","retry_at":1762000000,"attempt":2}',
      // D4: deferred, then dispatched — the claim supersedes to false and
      // clears the recorded reason/cover wholesale.
      '{"job":"D4","event":"dispatch_deferred","repo":"phantom","reason":"duplicate-request","repeatOf":"RQ-OWNER-4"}',
      '{"job":"D4","event":"claim","lane":"alpha"}',
      // D5: recut defer, then the blocker resolves — 'ready' supersedes to
      // false even without a dispatch row.
      '{"job":"D5","event":"recut_admission","repo":"phantom","reason":"recut-in-flight","action":"defer","repeatOf":"RQ-RECUT-5"}',
      '{"job":"D5","event":"recut_admission","repo":"phantom","reason":"recut-no-current-coverage","action":"ready","repeatOf":null}',
      // D6: recut defer, then the recut already merged — 'skip' resolves the
      // verdict the same way, and the paired DONE-NOOP outcome row then
      // records the fleet's terminal no-op verdict (no reason/cover on
      // this row, so both join null) without touching the resolved
      // deferral.
      '{"job":"D6","event":"recut_admission","repo":"phantom","reason":"recut-in-flight","action":"defer","repeatOf":"RQ-RECUT-6"}',
      '{"job":"D6","event":"recut_admission","repo":"phantom","reason":"recut-already-merged","action":"skip","repeatOf":"RQ-PHX-RECUT6L1"}',
      '{"job":"D6","event":"outcome","state":"DONE-NOOP","repo":"phantom"}',
      // D7: deferred, then the skip gate declines the job — the newer
      // launch decision supersedes the deferral.
      '{"job":"D7","event":"precheck_parked","repo":"phantom","lane":"alpha","code":13,"reason":"symbols_defined"}',
      '{"job":"D7","event":"skipped_empty","lane":"alpha","reason":"prompt_empty_same_base_24h"}',
      // D8: a launch row supersedes like claim does.
      '{"job":"D8","event":"dispatch_deferred","repo":"phantom","reason":"duplicate-request","repeatOf":"RQ-OWNER-8"}',
      '{"job":"D8","event":"launch","lane":"alpha"}',
      // D9: unbounded reason text and a malformed cover still mint the
      // verdict — the labels join null, never recorded raw — and an
      // unrecognized recut action leaves the standing verdict alone.
      '{"job":"D9","event":"dispatch_deferred","repo":"phantom","reason":"not a bounded label!","repeatOf":"bad cover!"}',
      '{"job":"D9","event":"recut_admission","repo":"phantom","reason":"recut-in-flight","action":"maybe"}',
      // D10: finish/publish/outcome rows belong to attempts already
      // decided and never touch the standing verdict.
      '{"job":"D10","event":"dispatch_deferred","repo":"phantom","reason":"duplicate-request","repeatOf":"RQ-OWNER-10"}',
      '{"job":"D10","event":"finish","lane":"alpha","empty":true}',
      // D11: a defer after a supersede stands again — newest wins.
      '{"job":"D11","event":"precheck_parked","repo":"phantom","lane":"alpha","code":13,"reason":"unproven_completion"}',
      '{"job":"D11","event":"claim","lane":"alpha"}',
      '{"job":"D11","event":"recut_admission","repo":"phantom","reason":"recut-in-flight","action":"defer","repeatOf":"RQ-RECUT-11"}',
      // D12: non-defer events carrying lookalike fields never mint one.
      '{"job":"D12","event":"launch","lane":"alpha","defer_reason":"duplicate-request","repeatOf":"RQ-OWNER-12"}',
    ].join('\n'));
    const byId = new Map(fold.outcomes.map(o => [o.job_id, o]));
    expect(byId.get('D1')).toMatchObject({ deferred: true, defer_reason: 'duplicate-request', defer_repeat_of: 'RQ-OWNER-1' });
    expect(byId.get('D2')).toMatchObject({ deferred: true, defer_reason: 'recut-in-flight', defer_repeat_of: 'RQ-RECUT-9' });
    expect(byId.get('D3')).toMatchObject({ deferred: true, defer_reason: 'files_and_tests_exist', defer_repeat_of: null });
    expect(byId.get('D4')).toMatchObject({ deferred: false, defer_reason: null, defer_repeat_of: null });
    expect(byId.get('D5')).toMatchObject({ deferred: false, defer_reason: null, defer_repeat_of: null });
    expect(byId.get('D6')).toMatchObject({ deferred: false, defer_reason: null, defer_repeat_of: null,
      noop: true, noop_reason: null, noop_repeat_of: null });
    expect(byId.get('D7')).toMatchObject({ deferred: false, defer_reason: null, defer_repeat_of: null, skipped: true, skip_reason: 'prompt_empty_same_base_24h' });
    expect(byId.get('D8')).toMatchObject({ deferred: false, defer_reason: null, defer_repeat_of: null });
    // Malformed labels and covers join null while the verdict stands; the
    // unrecognized recut action leaves it untouched.
    expect(byId.get('D9')).toMatchObject({ deferred: true, defer_reason: null, defer_repeat_of: null });
    expect(byId.get('D10')).toMatchObject({ deferred: true, defer_reason: 'duplicate-request', defer_repeat_of: 'RQ-OWNER-10', empty: true });
    expect(byId.get('D11')).toMatchObject({ deferred: true, defer_reason: 'recut-in-flight', defer_repeat_of: 'RQ-RECUT-11' });
    expect(byId.get('D12')).toMatchObject({ deferred: null, defer_reason: null, defer_repeat_of: null });
  });

  it('folds the terminal no-op verdicts, newest launch decision supersedes', () => {
    const fold = foldRouterOutcomes([
      // N1: dispatchd's admission verdict — already merged, reason joins.
      '{"job":"N1","event":"outcome","state":"DONE-NOOP","repo":"phantom","reason":"already-merged","launched":false}',
      // N2: restock's precheck retirement — the lowercase dialect resolves
      // the same phase and the reason joins through empty_reason.
      '{"job":"N2","event":"outcome","state":"done-noop","reason":"","empty_reason":"precheck_retired"}',
      // N3: the defensive empty-family spellings all mint the verdict —
      // phase/state/outcome keys and EMPTY/EMPTY_DONE/SKIPPED-EMPTY/NOOP.
      '{"job":"N3","phase":"EMPTY","reason":"target_pr_closed"}',
      '{"job":"N4","state":"EMPTY_DONE","noop_reason":"target_pr_merged"}',
      '{"job":"N5","outcome":"SKIPPED-EMPTY","empty_reason":"target_pr_conflicts_resolved"}',
      '{"job":"N6","state":"NOOP","reason":"recut-already-merged","repeatOf":"RQ-PHX-RECUT6L1"}',
      // N7: the reason keys join in order — reason wins over the aliases.
      '{"job":"N7","event":"outcome","state":"DONE-NOOP","reason":"already-merged","empty_reason":"target_pr_closed","noop_reason":"target_pr_merged"}',
      // N8: a malformed reason and cover join null, never recorded raw,
      // while the verdict itself still stands.
      '{"job":"N8","event":"outcome","state":"DONE-NOOP","reason":"not a bounded label!","repeatOf":"bad cover!"}',
      // N9: the newest no-op row replaces reason and cover wholesale.
      '{"job":"N9","event":"outcome","state":"DONE-NOOP","reason":"already-merged","repeatOf":"RQ-OLD-1"}',
      '{"job":"N9","event":"outcome","state":"EMPTY","reason":"target_pr_closed"}',
      // N10: a standing decline resolves when the terminal verdict lands —
      // the fleet's newest recorded decision is "no work needed".
      '{"job":"N10","event":"skipped_empty","lane":"alpha","reason":"prompt_empty_same_base_24h"}',
      '{"job":"N10","event":"outcome","state":"DONE-NOOP","reason":"already-merged"}',
      // N11: a standing deferral resolves the same way.
      '{"job":"N11","event":"dispatch_deferred","repo":"phantom","reason":"duplicate-request","repeatOf":"RQ-OWNER-11"}',
      '{"job":"N11","event":"outcome","state":"DONE-NOOP","reason":"target_pr_merged"}',
      // N12: a no-op verdict with no prior receipts leaves skip/defer
      // unknown — null means no receipt was ever recorded.
      '{"job":"N12","event":"outcome","state":"DONE-NOOP","reason":"target_pr_closed"}',
      // N13: every newer launch-decision receipt supersedes the verdict —
      // dispatch, skip-gate decline, keep-queued receipt, recut verdict.
      '{"job":"N13","event":"outcome","state":"DONE-NOOP","reason":"already-merged"}',
      '{"job":"N13","event":"claim","lane":"alpha"}',
      '{"job":"N14","event":"outcome","state":"DONE-NOOP","reason":"already-merged"}',
      '{"job":"N14","event":"skipped_empty","lane":"alpha","reason":"prompt_empty_same_base_24h"}',
      '{"job":"N15","event":"outcome","state":"DONE-NOOP","reason":"already-merged"}',
      '{"job":"N15","event":"dispatch_deferred","repo":"phantom","reason":"duplicate-request"}',
      '{"job":"N16","event":"outcome","state":"DONE-NOOP","reason":"already-merged"}',
      '{"job":"N16","event":"recut_admission","repo":"phantom","reason":"recut-in-flight","action":"defer","repeatOf":"RQ-RECUT-16"}',
      // N17: a launch row supersedes like claim does.
      '{"job":"N17","event":"outcome","state":"DONE-NOOP","reason":"already-merged"}',
      '{"job":"N17","event":"launch","lane":"alpha"}',
      // N18: a skip then a no-op then a dispatch — the newest decision wins
      // and the earlier verdicts stay resolved, not resurrected.
      '{"job":"N18","event":"skipped_empty","lane":"alpha","code":13}',
      '{"job":"N18","event":"outcome","state":"DONE-NOOP","reason":"already-merged"}',
      '{"job":"N18","event":"batch_claim","lane":"alpha"}',
      // N19: finish/publish/outcome rows of other phases and non-decision
      // events never touch the standing verdict; a task_outcome 'skipped'
      // word resolves to SKIPPED — outside the empty family — and mints
      // nothing.
      '{"job":"N19","event":"outcome","state":"DONE-NOOP","reason":"already-merged"}',
      '{"job":"N19","event":"finish","lane":"alpha","empty":true,"exit_code":0}',
      '{"job":"N19","event":"publish","pr_url":"https://github.com/o/r/pull/31"}',
      '{"job":"N19","event":"enqueue"}',
      '{"job":"N20","event":"task_outcome","batch":"RQ-BATCH-n20","lane":"alpha","outcome":"skipped"}',
      '{"job":"N20","event":"outcome","outcome":"done"}',
      // N21: a MERGED phase is the merge lifecycle's verdict, never a
      // no-op — and it leaves merged resolution exactly as before.
      '{"job":"N21","event":"outcome","state":"DONE-NOOP","reason":"already-merged"}',
      '{"job":"N21","phase":"MERGED","ts":"2026-11-01T00:00:00Z"}',
    ].join('\n'));
    const byId = new Map(fold.outcomes.map(o => [o.job_id, o]));
    expect(byId.get('N1')).toMatchObject({ merged: null, noop: true, noop_reason: 'already-merged', noop_repeat_of: null });
    expect(byId.get('N2')).toMatchObject({ noop: true, noop_reason: 'precheck_retired', noop_repeat_of: null });
    expect(byId.get('N3')).toMatchObject({ noop: true, noop_reason: 'target_pr_closed' });
    expect(byId.get('N4')).toMatchObject({ noop: true, noop_reason: 'target_pr_merged' });
    expect(byId.get('N5')).toMatchObject({ noop: true, noop_reason: 'target_pr_conflicts_resolved' });
    expect(byId.get('N6')).toMatchObject({ noop: true, noop_reason: 'recut-already-merged', noop_repeat_of: 'RQ-PHX-RECUT6L1' });
    expect(byId.get('N7')).toMatchObject({ noop: true, noop_reason: 'already-merged' });
    expect(byId.get('N8')).toMatchObject({ noop: true, noop_reason: null, noop_repeat_of: null });
    expect(byId.get('N9')).toMatchObject({ noop: true, noop_reason: 'target_pr_closed', noop_repeat_of: null });
    expect(byId.get('N10')).toMatchObject({ noop: true, skipped: false, skip_reason: null, skip_code: null });
    expect(byId.get('N11')).toMatchObject({ noop: true, deferred: false, defer_reason: null, defer_repeat_of: null });
    expect(byId.get('N12')).toMatchObject({ noop: true, skipped: null, deferred: null });
    expect(byId.get('N13')).toMatchObject({ noop: false, noop_reason: null, noop_repeat_of: null });
    expect(byId.get('N14')).toMatchObject({ noop: false, skipped: true, skip_reason: 'prompt_empty_same_base_24h' });
    expect(byId.get('N15')).toMatchObject({ noop: false, deferred: true, defer_reason: 'duplicate-request' });
    expect(byId.get('N16')).toMatchObject({ noop: false, deferred: true, defer_reason: 'recut-in-flight' });
    expect(byId.get('N17')).toMatchObject({ noop: false });
    expect(byId.get('N18')).toMatchObject({ noop: false, skipped: false, skip_reason: null, skip_code: null });
    expect(byId.get('N19')).toMatchObject({ noop: true, empty: true });
    expect(byId.get('N20')).toMatchObject({ noop: null, task_outcome: 'skipped' });
    expect(byId.get('N21')).toMatchObject({ noop: true, merged: true });
  });

  it('never lets a session row claim a PR URL or resolve an outcome', () => {
    const fold = foldRouterOutcomes([
      // The session's own finish row names a pull URL; it must not claim it.
      '{"job":"RQ-BATCH-def456","event":"finish","pr_url":"https://github.com/o/r/pull/9"}',
      // The member's publish row claims the same URL and resolves cleanly.
      '{"job":"P1","event":"publish","pr_url":"https://github.com/o/r/pull/9","phase":"MERGED"}',
      // A second session row reusing another member's URL stays invisible too.
      '{"job":"RQ-BATCH-ghi789","event":"finish","pr_url":"https://github.com/o/r/pull/10"}',
      '{"job":"P2","event":"publish","pr_url":"https://github.com/o/r/pull/10","phase":"CLOSED"}',
      // A URL claimed only by a session resolves to nothing at all.
      '{"pr_url":"https://github.com/o/r/pull/11","event":"revert"}',
      '{"job":"RQ-BATCH-jkl012","event":"finish","pr_url":"https://github.com/o/r/pull/11"}',
    ].join('\n'));
    expect(fold.session_rows).toBe(3);
    expect(fold.ambiguous_urls).toBe(0);
    // The session's URL claim never contests the member's: both resolve.
    expect(fold.outcomes.find(o => o.job_id === 'P1')).toMatchObject({ merged: true });
    expect(fold.outcomes.find(o => o.job_id === 'P2')).toMatchObject({ merged: false });
    // The session-only URL row is unattached evidence, never a phantom outcome.
    expect(fold.outcomes.map(o => o.job_id)).toEqual(['P1', 'P2']);
    expect(fold.unattached_rows).toBe(1);
  });

  it('reads the real folder and filters by lane', async () => {
    const root = runsDir([
      '{"job":"A1","lane":"alpha","phase":"MERGED"}',
      '{"job":"B1","lane":"beta","phase":"CLOSED"}',
      'junk',
    ].join('\n'));
    const all = await readRouterOutcomes({ runsDir: root });
    expect(all.state).toBe('read');
    expect(all.path).toBe(ledgerPath(root));
    expect(all.malformed_rows).toBe(1);
    expect(all.outcomes.map(o => o.job_id)).toEqual(['A1', 'B1']);

    const alpha = await readRouterOutcomes({ runsDir: root, lane: 'alpha' });
    expect(alpha.outcomes.map(o => o.job_id)).toEqual(['A1']);
    expect(alpha.state).toBe('read');
  });

  it('distinguishes a missing ledger from a readable empty one', async () => {
    const missing = await readRouterOutcomes({ runsDir: runsDir() });
    expect(missing).toMatchObject({ state: 'missing', outcomes: [], malformed_rows: 0 });

    const empty = await readRouterOutcomes({ runsDir: runsDir('') });
    expect(empty).toMatchObject({ state: 'read', outcomes: [], malformed_rows: 0 });
  });

  it('reports a directory at the ledger path as not-file, not as empty', async () => {
    const root = runsDir();
    mkdirSync(ledgerPath(root), { recursive: true }); // metrics/jobs.jsonl exists as a directory
    const result = await readRouterOutcomes({ runsDir: root });
    expect(result).toMatchObject({ state: 'not-file', outcomes: [] });
  });

  it('rejects a symlinked ledger and never follows it', async () => {
    const root = runsDir();
    const target = join(root, 'real.jsonl');
    writeFileSync(target, '{"job":"S1","phase":"MERGED"}\n');
    mkdirSync(join(root, 'metrics'));
    symlinkSync(target, ledgerPath(root));
    const result = await readRouterOutcomes({ runsDir: root });
    expect(result).toMatchObject({ state: 'unreadable', outcomes: [] });
  });

  it('reads the retained tail of an over-limit ledger instead of refusing it', async () => {
    const root = runsDir();
    mkdirSync(join(root, 'metrics'));
    writeFileSync(ledgerPath(root), '');
    truncateSync(ledgerPath(root), ROUTER_OUTCOME_LEDGER_LIMIT + 1); // sparse; no 16 MiB write
    const result = await readRouterOutcomes({ runsDir: root });
    expect(result).toMatchObject({ state: 'read', truncated: true, outcomes: [] });
  });

  it('folds rows inside the retained tail and drops the cut first line', async () => {
    const root = runsDir();
    mkdirSync(join(root, 'metrics'));
    // One oversized first line fills the whole bound; only the rows after it
    // survive the tail window, and the cut line prefix is never parsed.
    const pad = 'x'.repeat(ROUTER_OUTCOME_LEDGER_LIMIT);
    writeFileSync(ledgerPath(root), `${pad}\n{"job":"T1","phase":"MERGED"}\n{"job":"T2","phase":"CLOSED"}\n`);
    const result = await readRouterOutcomes({ runsDir: root });
    expect(result.state).toBe('read');
    expect(result.truncated).toBe(true);
    expect(result.malformed_rows).toBe(0);
    expect(result.outcomes.map(o => o.job_id)).toEqual(['T1', 'T2']);
    expect(result.outcomes[0]).toMatchObject({ merged: true });
    expect(result.outcomes[1]).toMatchObject({ merged: false });
  });

  it('reports truncated=false when the ledger fits the bound', async () => {
    const root = runsDir('{"job":"S1","phase":"MERGED"}\n');
    const result = await readRouterOutcomes({ runsDir: root });
    expect(result).toMatchObject({ state: 'read', truncated: false });
    expect(result.outcomes.map(o => o.job_id)).toEqual(['S1']);
  });

  it('enforces the byte limit on the bounded reader itself', async () => {
    const root = runsDir('{"job":"L1"}\n{"job":"L2"}\n');
    expect(await readLedgerFile(ledgerPath(root), 4)).toEqual({ state: 'too-large' });
    expect(await readLedgerFile(ledgerPath(root), 1024)).toMatchObject({ state: 'read' });
  });

  it('tail-reads whole lines only and flags coverage honestly', async () => {
    const root = runsDir('aaaa\nbbbb\ncccc\n');
    // 15-byte file; a truncated window always drops its first line because it
    // may be a cut suffix — here 'bbbb' is dropped even though it looks whole.
    expect(await readLedgerTail(ledgerPath(root), 10)).toEqual({ state: 'read', text: 'cccc\n', truncated: true });
    // A window starting mid-line drops the partial 'bbbb' suffix the same way.
    expect(await readLedgerTail(ledgerPath(root), 9)).toEqual({ state: 'read', text: 'cccc\n', truncated: true });
    // File fits the bound: whole text, no truncation.
    expect(await readLedgerTail(ledgerPath(root), 15)).toEqual({ state: 'read', text: 'aaaa\nbbbb\ncccc\n', truncated: false });
    expect(await readLedgerTail(ledgerPath(root))).toMatchObject({ state: 'read', truncated: false });
  });

  it('tail reader yields empty text when the window holds no newline', async () => {
    const root = runsDir('x'.repeat(20)); // one unterminated line, no '\n'
    expect(await readLedgerTail(ledgerPath(root), 10)).toEqual({ state: 'read', text: '', truncated: true });
  });

  it('tail reader keeps the same file refusals as the whole-file reader', async () => {
    expect(await readLedgerTail(join(runsDir(), 'metrics', 'jobs.jsonl'))).toEqual({ state: 'missing' });
    const dirRoot = runsDir();
    mkdirSync(ledgerPath(dirRoot), { recursive: true });
    expect(await readLedgerTail(ledgerPath(dirRoot))).toEqual({ state: 'not-file' });
    const linkRoot = runsDir();
    const target = join(linkRoot, 'real.jsonl');
    writeFileSync(target, '{"job":"S1"}\n');
    mkdirSync(join(linkRoot, 'metrics'));
    symlinkSync(target, ledgerPath(linkRoot));
    expect(await readLedgerTail(ledgerPath(linkRoot))).toEqual({ state: 'unreadable' });
    expect(await readLedgerFile(ledgerPath(linkRoot))).toEqual({ state: 'unreadable' });
  });

  it('leaves fixtures byte-identical and unmodified by reads', async () => {
    const ledger = '{"job":"F1","phase":"MERGED","cost_usd":1}\nnoise\n';
    const root = runsDir(ledger);
    const before = statSync(ledgerPath(root));
    await readRouterOutcomes({ runsDir: root });
    await readRouterOutcomes({ runsDir: root, lane: 'x' });
    expect(readFileSync(ledgerPath(root), 'utf8')).toBe(ledger);
    const after = statSync(ledgerPath(root));
    expect(after.size).toBe(before.size);
    expect(after.mtimeMs).toBe(before.mtimeMs);
  });

  it('requires an absolute runs directory', async () => {
    await expect(readRouterOutcomes({ runsDir: 'relative/runs' })).rejects.toThrow(RangeError);
  });
});

describe('router outcome pass^k join', () => {
  it('fold resolves passk only through an exact lane+model match', () => {
    const fold = foldRouterOutcomes(
      [
        '{"job":"A","lane":"l1","model":"m1"}',
        '{"job":"B","lane":"l1"}',
        '{"job":"C","model":"m1"}',
        '{"job":"D","lane":"l2","model":"m2"}',
        '{"job":"E","lane":"l1","model":"m1"}',
      ].join('\n'),
      { passkFor: (lane, model) => (lane === 'l1' && model === 'm1' ? 0.5 : lane === 'l2' ? Number.NaN : null) },
    );
    const byId = new Map(fold.outcomes.map(o => [o.job_id, o]));
    expect(byId.get('A')?.passk).toBe(0.5);
    expect(byId.get('E')?.passk).toBe(0.5);
    // Non-finite resolver output and unmatched pairs stay null, never fabricated.
    expect(byId.get('D')?.passk).toBeNull();
    expect(byId.get('B')?.passk).toBeNull();
    expect(byId.get('C')?.passk).toBeNull();
  });

  it('attaches the lane+model pass^k score from a healthy projection', async () => {
    const root = runsDir('{"job":"J1","lane":"devin","model":"swe-2","phase":"MERGED"}\n{"job":"J2","lane":"devin","model":"other","phase":"MERGED"}\n');
    const result = await readRouterOutcomes({ runsDir: root, ashlarDir: ashlarDir(laneScores([scoreRow('devin', 'swe-2', 0.42)])) });
    expect(result.eval_state).toBe('healthy');
    expect(result.outcomes.find(o => o.job_id === 'J1')?.passk).toBe(0.42);
    expect(result.outcomes.find(o => o.job_id === 'J2')?.passk).toBeNull();
  });

  it('leaves passk null and reports eval_state when the projection is missing or degraded', async () => {
    const root = runsDir('{"job":"J1","lane":"devin","model":"swe-2"}\n');
    const missing = await readRouterOutcomes({ runsDir: root, ashlarDir: ashlarDir() });
    expect(missing).toMatchObject({ state: 'read', eval_state: 'missing' });
    expect(missing.outcomes[0]?.passk).toBeNull();

    const degraded = await readRouterOutcomes({ runsDir: root, ashlarDir: ashlarDir('{not json') });
    expect(degraded).toMatchObject({ state: 'read', eval_state: 'degraded' });
    expect(degraded.outcomes[0]?.passk).toBeNull();
  });

  it('refuses a duplicated lane+model pair but keeps unambiguous rows', async () => {
    const root = runsDir('{"job":"J1","lane":"devin","model":"swe-2"}\n{"job":"J2","lane":"claude","model":"opus"}\n');
    const evalRoot = ashlarDir(laneScores([scoreRow('devin', 'swe-2', 0.4), scoreRow('devin', 'swe-2', 0.9), scoreRow('claude', 'opus', 0.7)]));
    const result = await readRouterOutcomes({ runsDir: root, ashlarDir: evalRoot });
    expect(result.eval_state).toBe('healthy');
    expect(result.outcomes.find(o => o.job_id === 'J1')?.passk).toBeNull();
    expect(result.outcomes.find(o => o.job_id === 'J2')?.passk).toBe(0.7);
  });

  it('keeps passk null when the matched row has no pass^k value', async () => {
    const root = runsDir('{"job":"J1","lane":"devin","model":"swe-2"}\n');
    const result = await readRouterOutcomes({ runsDir: root, ashlarDir: ashlarDir(laneScores([scoreRow('devin', 'swe-2', null)])) });
    expect(result.eval_state).toBe('healthy');
    expect(result.outcomes[0]?.passk).toBeNull();
  });

  it('requires an absolute ashlarDir when given', async () => {
    await expect(readRouterOutcomes({ runsDir: runsDir(''), ashlarDir: 'relative/ashlr' })).rejects.toThrow(RangeError);
  });
});

describe('router outcome spend join', () => {
  it('folds api-spend rows into per-job USD sums with the fleet spend contract', () => {
    const costs = foldSpendCosts([
      '{"ts":"2026-11-02T08:00:00Z","job":"J1","cost_usd":1.25}',
      '{"ts":"2026-11-02T09:00:00Z","job":"J1","model":"m","usd":0.5}',
      '{"timestamp":"2026-11-02T10:00:00Z","job_id":"J2","cost":0.25}',
      '{"ts":"2026-11-02T11:00:00Z","id":"J3","cost_usd":0}',
      '{"ts":"2026-11-02T12:00:00Z","job":"J4","cost_estimated":true,"cost_usd":0.75}',
      '{"ts":"2026-11-02T13:00:00Z","model":"m","cost_usd":9}',
      '{"ts":"2026-11-02T14:00:00Z","job":"J5"}',
      '{"ts":"2026-11-02T15:00:00Z","job":"J6","cost_usd":-1}',
      'not json',
      '[1,2]',
      '',
    ].join('\n'));
    expect(costs.get('J1')).toBeCloseTo(1.75);
    expect(costs.get('J2')).toBe(0.25);
    // A reported zero is evidence; estimated costs still report a USD figure.
    expect(costs.get('J3')).toBe(0);
    expect(costs.get('J4')).toBe(0.75);
    // No job id, no cost, invalid cost: never counted.
    expect(costs.has('J5')).toBe(false);
    expect(costs.has('J6')).toBe(false);
    expect(costs.size).toBe(4);
  });

  it('populates cost_usd from spend rows only where the jobs fold left it null', async () => {
    const root = runsDir([
      '{"job":"J1","phase":"MERGED","ts":"2026-11-01T00:00:00Z"}',
      '{"job":"J2","phase":"CLOSED","cost_usd":2,"ts":"2026-11-01T00:00:00Z"}',
      '{"job":"J3","phase":"MERGED","ts":"2026-11-01T00:00:00Z"}',
      '{"job":"J4","phase":"MERGED","ts":"2026-11-01T00:00:00Z"}',
    ].join('\n'));
    writeSpend(root, [
      '{"job":"J1","cost_usd":1.25}',
      '{"job":"J1","usd":0.5}',
      '{"job":"J2","cost_usd":9}',
      '{"job":"J3","cost_usd":1}',
      '{"job":"J3","model":"m"}',
      '{"job":"J3","cost_usd":2}',
      '{"job":"J4","cost_usd":1e308}',
      '{"job":"J4","cost_usd":1e308}',
      '{"job":"J-UNKNOWN","cost_usd":7}',
      '{"cost_usd":3}',
    ].join('\n'));
    const result = await readRouterOutcomes({ runsDir: root });
    expect(result.state).toBe('read');
    expect(result.spend_state).toBe('read');
    expect(result.spend_truncated).toBe(false);
    const byId = new Map(result.outcomes.map(o => [o.job_id, o]));
    // Spend sum fills the null; the explicit ledger cost wins over spend.
    expect(byId.get('J1')?.cost_usd).toBeCloseTo(1.75);
    expect(byId.get('J2')?.cost_usd).toBe(2);
    // A partial or non-finite total stays unknown. Spend rows for jobs
    // outside the jobs window never create outcomes.
    expect(byId.get('J3')?.cost_usd).toBeNull();
    expect(byId.get('J4')?.cost_usd).toBeNull();
    expect(result.outcomes.map(o => o.job_id)).toEqual(['J1', 'J2', 'J3', 'J4']);
  });

  it('accepts usd/cost aliases on jobs rows as explicit cost evidence', async () => {
    const root = runsDir('{"job":"J1","phase":"MERGED","cost":0.4}\n{"job":"J2","phase":"MERGED","usd":0.6}\n');
    writeSpend(root, '{"job":"J1","cost_usd":5}\n');
    const result = await readRouterOutcomes({ runsDir: root });
    const byId = new Map(result.outcomes.map(o => [o.job_id, o]));
    expect(byId.get('J1')?.cost_usd).toBe(0.4);
    expect(byId.get('J2')?.cost_usd).toBe(0.6);
  });

  it('degrades the spend source independently of the jobs fold', async () => {
    const root = runsDir('{"job":"J1","phase":"MERGED"}\n');
    // No api-spend.jsonl at all: spend_state reports missing, cost stays null.
    const missing = await readRouterOutcomes({ runsDir: root });
    expect(missing).toMatchObject({ state: 'read', spend_state: 'missing', spend_truncated: false });
    expect(missing.outcomes[0]?.cost_usd).toBeNull();

    // A symlinked spend ledger is refused like the jobs ledger.
    const target = join(root, 'real-spend.jsonl');
    writeFileSync(target, '{"job":"J1","cost_usd":1}\n');
    symlinkSync(target, spendPath(root));
    const linked = await readRouterOutcomes({ runsDir: root });
    expect(linked).toMatchObject({ state: 'read', spend_state: 'unreadable' });
    expect(linked.outcomes[0]?.cost_usd).toBeNull();
  });

  it('still reports spend health when the jobs ledger itself is missing', async () => {
    const root = runsDir();
    writeSpend(root, '{"job":"J1","cost_usd":1}\n');
    const result = await readRouterOutcomes({ runsDir: root });
    expect(result).toMatchObject({ state: 'missing', spend_state: 'read', spend_truncated: false, outcomes: [] });
  });

  it('withholds cut spend sums and preserves independent recorded costs', async () => {
    const root = runsDir([
      '{"job":"J1","phase":"MERGED"}',
      '{"job":"J2","phase":"MERGED","cost_usd":2}',
      '{"job":"J3","phase":"MERGED"}',
    ].join('\n'));
    writeSpend(root, '{"job":"J1","cost_usd":3}\n');
    truncateSync(spendPath(root), ROUTER_OUTCOME_LEDGER_LIMIT + 1);
    appendFileSync(spendPath(root), '\n' + [
      '{"job":"J1","cost_usd":1}',
      '{"job":"J2","cost_usd":9}',
      '{"job":"J3","cost_usd":0.25}',
      '',
    ].join('\n'));

    const result = await readRouterOutcomes({ runsDir: root, ashlarDir: rewardLedger([rewardRow('J3', true)]) });
    expect(result).toMatchObject({ state: 'read', spend_state: 'read', spend_truncated: true });
    expect(result.outcomes.map(({ job_id, cost_usd }) => [job_id, cost_usd])).toEqual([
      ['J1', null], ['J2', 2], ['J3', 0.75],
    ]);
  });
});

describe('router outcome work_class join', () => {
  it('folds route_decision rows to each job\'s latest recorded work_class', () => {
    const classes = foldRouteDecisionWorkClasses([
      JSON.stringify(decision('J1', 'bulk', 100)),
      JSON.stringify(decision('J1', 'judgment', 200)),   // newer decision wins
      JSON.stringify(decision('J1', 'standard', 150)),  // older than the newest: ignored
      JSON.stringify(decision('J2', 'standard', 100, { chosen_lane: null, reason_codes: ['no_runnable_lane'] })),
      JSON.stringify({ schema: 'work-market.v1', event: 'posture', ts: 300, lanes: {} }),
      JSON.stringify(decision('J3', 'bulk', 100)),
      JSON.stringify({ ...decision('J3', 'bulk', 200), work_class: undefined }),
      JSON.stringify(decision('J4', 'bad class!', 200)),
      JSON.stringify(decision('J4', 'judgment', 100)), // older append cannot revive the class
      JSON.stringify({ schema: 'work-market.v1', event: 'route_decision', job: 'J5', work_class: 'bulk', ts: 'not-a-number' }),
      JSON.stringify(decision('J6', 'bulk', 100, { schema: 'other.v9' })),
      'not json',
      '',
    ].join('\n'));
    expect(classes.get('J1')).toBe('judgment');
    expect(classes.get('J2')).toBe('standard');
    expect(classes.has('J3')).toBe(false);
    expect(classes.has('J4')).toBe(false);
    expect(classes.has('J5')).toBe(false);
    expect(classes.has('J6')).toBe(false);
    expect(classes.size).toBe(2);
  });

  it('fills work_class from route decisions only where jobs rows recorded none', async () => {
    const root = runsDir([
      '{"job":"J1","lane":"alpha","phase":"MERGED","ts":"2026-11-01T00:00:00Z"}',
      '{"job":"J2","lane":"beta","phase":"CLOSED","work_class":"docs","ts":"2026-11-01T00:00:00Z"}',
      '{"job":"J3","lane":"alpha","phase":"MERGED","ts":"2026-11-01T00:00:00Z"}',
    ].join('\n'));
    writeMarket(root, [
      decision('J1', 'bulk', 100),
      decision('J2', 'bulk', 100),   // explicit jobs-row class wins over the market join
      decision('J3', 'judgment', 100),
      { ...decision('J3', 'judgment', 200), work_class: undefined, chosen_lane: 'beta' },
      decision('J-UNDECIDED', 'bulk', 100), // no jobs outcome: never creates one
    ]);
    const result = await readRouterOutcomes({ runsDir: root });
    expect(result).toMatchObject({ state: 'read', market_state: 'read', market_truncated: false });
    const byId = new Map(result.outcomes.map(o => [o.job_id, o]));
    expect(byId.get('J1')?.work_class).toBe('bulk');
    expect(byId.get('J2')?.work_class).toBe('docs');
    expect(byId.get('J3')).toMatchObject({ work_class: null, market_lane: 'beta' });
    expect(result.outcomes.map(o => o.job_id)).toEqual(['J1', 'J2', 'J3']);
  });

  it('keeps work_class null and reports market_state when the market ledger is absent or refused', async () => {
    const missing = await readRouterOutcomes({ runsDir: runsDir('{"job":"J1","phase":"MERGED"}\n') });
    expect(missing).toMatchObject({ state: 'read', market_state: 'missing', market_truncated: false });
    expect(missing.outcomes[0]?.work_class).toBeNull();

    const root = runsDir('{"job":"J1","phase":"MERGED"}\n');
    const target = join(root, 'real-market.jsonl');
    writeFileSync(target, JSON.stringify(decision('J1', 'bulk', 100)) + '\n');
    symlinkSync(target, marketPath(root));
    const linked = await readRouterOutcomes({ runsDir: root });
    expect(linked).toMatchObject({ state: 'read', market_state: 'unreadable' });
    expect(linked.outcomes[0]?.work_class).toBeNull();
  });

  it('still reports market health when the jobs ledger itself is missing', async () => {
    const root = runsDir();
    writeMarket(root, [decision('J1', 'bulk', 100)]);
    const result = await readRouterOutcomes({ runsDir: root });
    expect(result).toMatchObject({ state: 'missing', market_state: 'read', market_truncated: false, outcomes: [] });
  });

  it('flags a cut market tail so joined classes read as newest-bytes coverage', async () => {
    const root = runsDir('{"job":"J1","phase":"MERGED"}\n');
    writeFileSync(marketPath(root), '');
    truncateSync(marketPath(root), ROUTER_OUTCOME_LEDGER_LIMIT + 1);
    const result = await readRouterOutcomes({ runsDir: root });
    expect(result).toMatchObject({ state: 'read', market_state: 'read', market_truncated: true });
    expect(result.outcomes[0]?.work_class).toBeNull();
  });
});

describe('router outcome market decision join', () => {
  it('folds route_decision rows to each job\'s newest recorded routing verdict', () => {
    const decisions = foldRouteDecisions([
      JSON.stringify(decision('J1', 'bulk', 100, {
        chosen_lane: 'alpha', preferred_lane: 'beta',
        override: { from: 'beta', to: 'alpha', reason: 'resource_fit', preferred_lane_blocked_by: ['quota_exhausted'] },
        reason_codes: ['preferred_lane', 'healthy_capacity'],
      })),
      JSON.stringify(decision('J1', 'bulk', 200, {
        chosen_lane: 'gamma', preferred_lane: null, override: null,
        reason_codes: ['no_runnable_lane', 'no_runnable_lane', 'Hysteresis_X', 'bad code!'],
      })),   // newer decision wins; dupes drop, unbounded codes skip
      JSON.stringify(decision('J1', 'bulk', 150, { chosen_lane: 'delta' })),  // older: ignored
      JSON.stringify(decision('J2', 'bulk', 100, { chosen_lane: null, preferred_lane: null, reason_codes: [] })),
      JSON.stringify(decision('J3', 'bulk', 100, { chosen_lane: 'alpha!', reason_codes: ['!!!'] })),
      JSON.stringify({ schema: 'work-market.v1', event: 'posture', ts: 300, lanes: {} }),
      JSON.stringify({ schema: 'work-market.v1', event: 'route_decision', job: 'J4', ts: 100, chosen_lane: 'alpha' }), // minimal row: absent fields stay null
      JSON.stringify({ schema: 'work-market.v1', event: 'route_decision', job: 'J5', ts: 'not-a-number', chosen_lane: 'alpha' }),
      JSON.stringify(decision('J6', 'bulk', 100, { schema: 'other.v9' })),
      'not json',
      '',
    ].join('\n'));
    expect(decisions.get('J1')).toEqual({
      lane: 'gamma', preferred: null, override: null,
      reasons: ['no_runnable_lane'], rejected: [],
    });
    // A recorded empty reason_codes/rejected_lanes list stays []; chosen/preferred null inside a real decision.
    expect(decisions.get('J2')).toEqual({ lane: null, preferred: null, override: null, reasons: [], rejected: [] });
    // Malformed lane and all-unrecognizable codes read as unrecorded, never raw.
    expect(decisions.get('J3')).toEqual({ lane: null, preferred: 'alpha', override: null, reasons: null, rejected: [] });
    // Minimal rows still record what parses; absent fields and bad ts/wrong schema skip or stay null.
    // J4 wrote no rejected_lanes member at all: unrecorded (null), distinct from J2's recorded [].
    expect(decisions.get('J4')).toEqual({ lane: 'alpha', preferred: null, override: null, reasons: null, rejected: null });
    expect(decisions.has('J5')).toBe(false);
    expect(decisions.has('J6')).toBe(false);
    expect(decisions.size).toBe(4);
  });

  it('folds rejected_lanes per lane under the bounded shapes, newest decision stands', () => {
    const decisions = foldRouteDecisions([
      // R1: the market's per-lane rejection record — ineligible codes,
      // hysteresis holds and lower_rank all join in recorded order.
      JSON.stringify(decision('R1', 'bulk', 100, {
        chosen_lane: null, reason_codes: ['no_runnable_lane'],
        rejected_lanes: [
          { lane: 'devin', reason_codes: ['quota_exhausted', 'held'] },
          { lane: 'codex-cmp', reason_codes: ['saturated', 'provider_backoff'] },
          { lane: 'claude', reason_codes: ['lower_rank'] },
        ],
      })),
      // R2: malformed entries skip — bad lane shapes, non-objects, a
      // missing lane — while well-formed neighbors still join; a
      // reasons list that is recorded-empty stays [] and one whose
      // codes are all unrecognizable reads as unrecorded (null).
      JSON.stringify(decision('R2', 'bulk', 100, {
        rejected_lanes: [
          { lane: 'alpha!', reason_codes: ['quota_exhausted'] },
          'not-an-object',
          { reason_codes: ['saturated'] },
          { lane: 'beta', reason_codes: [] },
          { lane: 'gamma', reason_codes: ['NOT_A_CODE', 42, null] },
          { lane: 'delta' },
          { lane: 'epsilon', reason_codes: 'quota_exhausted' },
        ],
      })),
      // R3: the newest decision stands even when its rejected_lanes is
      // unrecordable — a non-array value reads as unrecorded (null) and
      // supersedes the older row's valid list; a non-empty list whose
      // every entry is malformed reads the same way.
      JSON.stringify(decision('R3', 'bulk', 100, {
        rejected_lanes: [{ lane: 'alpha', reason_codes: ['held'] }],
      })),
      JSON.stringify(decision('R3', 'bulk', 200, { rejected_lanes: 'quota_exhausted' })),
      JSON.stringify(decision('R3', 'bulk', 300, { rejected_lanes: [{ lane: 'bad lane!' }] })),
      // R4: over-bound entries cap; duplicate codes dedupe per entry.
      JSON.stringify(decision('R4', 'bulk', 100, {
        rejected_lanes: [
          ...Array.from({ length: 40 }, (_, i) => ({ lane: `lane-${i}`, reason_codes: ['held'] })),
        ],
      })),
      JSON.stringify(decision('R5', 'bulk', 100, {
        rejected_lanes: [{ lane: 'alpha', reason_codes: ['held', 'held', 'saturated'] }],
      })),
    ].join('\n'));
    expect(decisions.get('R1')?.rejected).toEqual([
      { lane: 'devin', reasons: ['quota_exhausted', 'held'] },
      { lane: 'codex-cmp', reasons: ['saturated', 'provider_backoff'] },
      { lane: 'claude', reasons: ['lower_rank'] },
    ]);
    expect(decisions.get('R2')?.rejected).toEqual([
      { lane: 'beta', reasons: [] },
      { lane: 'gamma', reasons: null },
      { lane: 'delta', reasons: null },
      { lane: 'epsilon', reasons: null },
    ]);
    expect(decisions.get('R3')?.rejected).toBeNull();
    expect(decisions.get('R4')?.rejected).toHaveLength(32);
    expect(decisions.get('R5')?.rejected).toEqual([{ lane: 'alpha', reasons: ['held', 'saturated'] }]);
  });

  it('joins the newest decision verdict onto outcomes without creating market-only jobs', async () => {
    const root = runsDir([
      '{"job":"J1","lane":"alpha","phase":"MERGED","ts":"2026-11-01T00:00:00Z"}',
      '{"job":"J2","lane":"beta","phase":"CLOSED","ts":"2026-11-01T00:00:00Z"}',
      '{"job":"J3","phase":"VERIFIED","ts":"2026-11-01T00:00:00Z"}',
    ].join('\n'));
    writeMarket(root, [
      decision('J1', 'bulk', 100, {
        chosen_lane: 'alpha', preferred_lane: 'beta',
        override: { from: 'beta', to: 'alpha', reason: 'resource_fit' },
        reason_codes: ['healthy_capacity', 'resource_fit'],
      }),
      decision('J1', 'bulk', 200, {   // newer decision stands
        chosen_lane: null, preferred_lane: 'beta', override: null,
        reason_codes: ['no_runnable_lane', 'global_admission'],
        rejected_lanes: [
          { lane: 'devin', reason_codes: ['quota_exhausted', 'held'] },
          { lane: 'codex-cmp', reason_codes: ['saturated'] },
        ],
      }),
      decision('J2', 'bulk', 100, { chosen_lane: 'beta', preferred_lane: 'beta', reason_codes: ['preferred_lane'] }),
      decision('J-UNDECIDED', 'bulk', 100, { chosen_lane: 'alpha', reason_codes: ['preferred_lane'] }),
    ]);
    const result = await readRouterOutcomes({ runsDir: root });
    expect(result).toMatchObject({ state: 'read', market_state: 'read', market_truncated: false });
    const byId = new Map(result.outcomes.map(o => [o.job_id, o]));
    expect(byId.get('J1')).toMatchObject({
      market_lane: null, market_preferred: 'beta', market_override: null,
      market_reasons: ['no_runnable_lane', 'global_admission'],
      market_rejected: [
        { lane: 'devin', reasons: ['quota_exhausted', 'held'] },
        { lane: 'codex-cmp', reasons: ['saturated'] },
      ],
    });
    expect(byId.get('J2')).toMatchObject({
      market_lane: 'beta', market_preferred: 'beta', market_override: null,
      market_reasons: ['preferred_lane'],
      // The fixture wrote rejected_lanes: [] — a recorded empty set, not unknown.
      market_rejected: [],
    });
    // J3 has no decision row: every market field stays null — unknown, never guessed.
    expect(byId.get('J3')).toMatchObject({
      market_lane: null, market_preferred: null, market_override: null, market_reasons: null,
      market_rejected: null,
    });
    expect(result.outcomes.map(o => o.job_id)).toEqual(['J1', 'J2', 'J3']);
  });

  it('keeps market verdict fields null when the market ledger is absent or refused', async () => {
    const missing = await readRouterOutcomes({ runsDir: runsDir('{"job":"J1","phase":"MERGED"}\n') });
    expect(missing).toMatchObject({ state: 'read', market_state: 'missing' });
    expect(missing.outcomes[0]).toMatchObject({
      market_lane: null, market_preferred: null, market_override: null, market_reasons: null,
      market_rejected: null,
    });

    const root = runsDir('{"job":"J1","phase":"MERGED"}\n');
    const target = join(root, 'real-market.jsonl');
    writeFileSync(target, JSON.stringify(decision('J1', 'bulk', 100, { chosen_lane: 'alpha' })) + '\n');
    symlinkSync(target, marketPath(root));
    const linked = await readRouterOutcomes({ runsDir: root });
    expect(linked).toMatchObject({ state: 'read', market_state: 'unreadable' });
    expect(linked.outcomes[0]?.market_lane).toBeNull();
    expect(linked.outcomes[0]?.market_rejected).toBeNull();
  });
});

describe('router outcome market handoff advisory join', () => {
  /** A session-failover.v1 advisory row in the market_metric() shape —
   *  dispatchd appends quota-exhausted verdicts to work-market.jsonl
   *  stamped with epoch-seconds ts (contrib/mac/session_handoff.py). */
  const marketAdvisory = (job: string, trigger: string, ts: number, extra: Record<string, unknown> = {}): object => ({
    schema: 'session-failover.v1', event: 'session_handoff_advisory', advisory: true,
    job, lane: 'alpha', trigger, target: null, ts, ...extra,
  });

  it('folds each job\'s newest advisory by recorded ts under the closed vocabulary', () => {
    const advisories = foldMarketHandoffAdvisories([
      JSON.stringify(marketAdvisory('J1', 'quota-exhausted', 100, { lane: 'alpha', target: 'devin' })),
      JSON.stringify(marketAdvisory('J1', 'quota-exhausted', 200, { lane: 'beta', target: 'gamma' })), // newer stands
      JSON.stringify(marketAdvisory('J1', 'quota-exhausted', 150, { lane: 'delta' })),                 // older ignored
      JSON.stringify(marketAdvisory('J2', 'rate-limit', 100, { lane: 'codex-cmp' })),
      // Malformed lane/target drop to null while the trigger still joins.
      JSON.stringify(marketAdvisory('J6', 'quota-exhausted', 100, { lane: 'bad lane!', target: 42 })),
      // Wrong schema, wrong event, out-of-vocabulary trigger, non-finite
      // ts and an empty job id are all unrecognized — never recorded.
      JSON.stringify(marketAdvisory('J3', 'quota-exhausted', 100, { schema: 'session-failover.v2' })),
      JSON.stringify({ ...marketAdvisory('J3', 'quota-exhausted', 100), event: 'session_handoff' }),
      JSON.stringify(marketAdvisory('J3', 'provider-error', 100)),
      JSON.stringify(marketAdvisory('J4', 'quota-exhausted', NaN)),
      JSON.stringify(marketAdvisory('', 'quota-exhausted', 100)),
      'not json',
    ].join('\n'));
    expect(advisories.get('J1')).toEqual({ trigger: 'quota-exhausted', lane: 'beta', target: 'gamma', ts: 200 });
    expect(advisories.get('J2')).toEqual({ trigger: 'rate-limit', lane: 'codex-cmp', target: null, ts: 100 });
    expect(advisories.get('J6')).toEqual({ trigger: 'quota-exhausted', lane: null, target: null, ts: 100 });
    expect(advisories.has('J3')).toBe(false);
    expect(advisories.has('J4')).toBe(false);
    expect(advisories.size).toBe(3);
  });

  it('joins market advisories onto outcomes only when they are the newest recorded verdict', async () => {
    const root = runsDir([
      '{"job":"J1","lane":"alpha","phase":"MERGED","ts":"2026-11-01T00:00:00Z"}',
      '{"job":"J2","lane":"beta","phase":"CLOSED","ts":"2026-11-01T00:00:00Z"}',
      // J3's standing jobs-ledger advisory (rate-limit, 2026-11-02) is
      // older than the market quota-exhausted verdict below.
      JSON.stringify({ schema: 'session-failover.v1', event: 'session_handoff_advisory', job: 'J3', lane: 'jobs-lane', trigger: 'rate-limit', target: null, ts: '2026-11-02T00:00:00Z' }),
      '{"job":"J3","phase":"VERIFIED","ts":"2026-11-01T00:00:00Z"}',
      // J4's standing jobs-ledger advisory carries no parseable ts, so
      // the market verdict cannot be ordered against it.
      JSON.stringify({ schema: 'session-failover.v1', event: 'session_handoff_advisory', job: 'J4', lane: 'jobs-lane', trigger: 'rate-limit', target: null }),
      '{"job":"J4","phase":"MERGED","ts":"2026-11-01T00:00:00Z"}',
      // J5's standing jobs-ledger advisory (2026-11-03) is newer than
      // the market row's epoch ts (1000s ≈ 1970).
      JSON.stringify({ schema: 'session-failover.v1', event: 'session_handoff_advisory', job: 'J5', lane: 'jobs-lane', trigger: 'rate-limit', target: 'jobs-target', ts: '2026-11-03T00:00:00Z' }),
      '{"job":"J5","phase":"MERGED","ts":"2026-11-01T00:00:00Z"}',
    ].join('\n'));
    writeMarket(root, [
      // J1 recorded no jobs advisory: the market verdict fills the triple.
      marketAdvisory('J1', 'quota-exhausted', 2000000000, { lane: 'alpha', target: 'devin' }),
      // J2 likewise has no jobs advisory — the market verdict fills it.
      marketAdvisory('J2', 'quota-exhausted', 1000, { lane: 'beta', target: 'gamma' }),
      // J3's market advisory (epoch ~2033) postdates the jobs advisory.
      marketAdvisory('J3', 'quota-exhausted', 2000000000, { lane: 'market-lane', target: 'market-target' }),
      // J4's market advisory is newer in wall time but the jobs
      // advisory's missing ts makes ordering impossible — jobs stands.
      marketAdvisory('J4', 'quota-exhausted', 2000000000, { lane: 'market-lane', target: 'market-target' }),
      // J5's market advisory (epoch ~1970) predates the jobs advisory.
      marketAdvisory('J5', 'quota-exhausted', 1000, { lane: 'market-lane', target: 'market-target' }),
      // A market advisory naming a job with no jobs outcome joins nothing.
      marketAdvisory('J-UNADVISED', 'quota-exhausted', 2000000000, { lane: 'alpha', target: 'devin' }),
    ]);
    const result = await readRouterOutcomes({ runsDir: root });
    expect(result).toMatchObject({ state: 'read', market_state: 'read', market_truncated: false });
    const byId = new Map(result.outcomes.map(o => [o.job_id, o]));
    expect(byId.get('J1')).toMatchObject({ handoff_trigger: 'quota-exhausted', handoff_lane: 'alpha', handoff_target: 'devin' });
    expect(byId.get('J2')).toMatchObject({ handoff_trigger: 'quota-exhausted', handoff_lane: 'beta', handoff_target: 'gamma' });
    expect(byId.get('J3')).toMatchObject({ handoff_trigger: 'quota-exhausted', handoff_lane: 'market-lane', handoff_target: 'market-target' });
    expect(byId.get('J4')).toMatchObject({ handoff_trigger: 'rate-limit', handoff_lane: 'jobs-lane', handoff_target: null });
    expect(byId.get('J5')).toMatchObject({ handoff_trigger: 'rate-limit', handoff_lane: 'jobs-lane', handoff_target: 'jobs-target' });
    expect(byId.has('J-UNADVISED')).toBe(false);
  });

  it('keeps the jobs-ledger advisory standing when the market ledger is absent or refused', async () => {
    const root = runsDir([
      JSON.stringify({ schema: 'session-failover.v1', event: 'session_handoff_advisory', job: 'J1', lane: 'alpha', trigger: 'rate-limit', target: null, ts: '2026-11-01T00:00:00Z' }),
      '{"job":"J1","phase":"MERGED","ts":"2026-11-01T00:00:00Z"}',
    ].join('\n'));
    const missing = await readRouterOutcomes({ runsDir: root });
    expect(missing).toMatchObject({ state: 'read', market_state: 'missing' });
    expect(missing.outcomes[0]).toMatchObject({ handoff_trigger: 'rate-limit', handoff_lane: 'alpha', handoff_target: null });

    const linked = runsDir([
      JSON.stringify({ schema: 'session-failover.v1', event: 'session_handoff_advisory', job: 'J1', lane: 'alpha', trigger: 'rate-limit', target: null, ts: '2026-11-01T00:00:00Z' }),
      '{"job":"J1","phase":"MERGED","ts":"2026-11-01T00:00:00Z"}',
    ].join('\n'));
    const target = join(linked, 'real-market.jsonl');
    writeFileSync(target, JSON.stringify(marketAdvisory('J1', 'quota-exhausted', 2000000000, { lane: 'beta', target: 'gamma' })) + '\n');
    symlinkSync(target, marketPath(linked));
    const refused = await readRouterOutcomes({ runsDir: linked });
    expect(refused).toMatchObject({ state: 'read', market_state: 'unreadable' });
    expect(refused.outcomes[0]).toMatchObject({ handoff_trigger: 'rate-limit', handoff_lane: 'alpha', handoff_target: null });
  });
});

describe('router outcome empty-tag join', () => {
  it('folds job.empty-tag.v1 rows to each job\'s recorded tag, last row wins', () => {
    const tags = foldEmptyTags([
      JSON.stringify(emptyTag('J1', 'already_done')),
      JSON.stringify(emptyTag('J1', 'pool_cap')),          // repeated job: last append stands
      JSON.stringify(emptyTag('J2', 'unknown')),
      JSON.stringify(emptyTag('J3', 'no_change_needed', { lane: 'beta' })),
      JSON.stringify(emptyTag('J4', 'not_a_tag')),
      JSON.stringify(emptyTag('J5', 'blocked', { schema: 'jobs.empty-tags.v1' })),
      JSON.stringify({ schema: 'job.empty-tag.v1', job: '', tag: 'blocked' }),
      JSON.stringify({ schema: 'job.empty-tag.v1', job: 'J6' }),
      JSON.stringify({ schema: 'job.empty-tag.v1', job: 'J7', tag: 42 }),
      JSON.stringify({ job: 'J8', tag: 'blocked' }),       // no schema: not a tag row
      'not json',
      '[1,2]',
      '',
    ].join('\n'));
    expect(tags.get('J1')).toBe('pool_cap');
    expect(tags.get('J2')).toBe('unknown');
    expect(tags.get('J3')).toBe('no_change_needed');
    expect(tags.size).toBe(3);
  });

  it('joins recorded tags onto outcomes and never creates outcomes for tag-only jobs', async () => {
    const root = runsDir([
      '{"job":"J1","lane":"alpha","phase":"MERGED","ts":"2026-11-01T00:00:00Z"}',
      '{"job":"J2","lane":"alpha","phase":"CLOSED","empty":true,"exit_code":0,"ts":"2026-11-01T00:00:00Z"}',
      '{"job":"J3","lane":"beta","phase":"VERIFIED","ts":"2026-11-01T00:00:00Z"}',
    ].join('\n'));
    writeEmptyTags(root, [
      emptyTag('J2', 'already_done'),
      emptyTag('J3', 'blocked'),
      emptyTag('J-UNDECLARED', 'pool_cap'),  // no jobs outcome: never creates one
    ]);
    const result = await readRouterOutcomes({ runsDir: root });
    expect(result).toMatchObject({ state: 'read', empty_tag_state: 'read', empty_tag_truncated: false });
    const byId = new Map(result.outcomes.map(o => [o.job_id, o]));
    // The tag attaches regardless of the standing finish verdict — J1 merged
    // yet still carries no tag row, J2's empty finish reads its recorded
    // cause, and the recorded 'unknown' tag on J3 is evidence, not a gap.
    expect(byId.get('J1')?.empty_tag).toBeNull();
    expect(byId.get('J2')?.empty_tag).toBe('already_done');
    expect(byId.get('J3')?.empty_tag).toBe('blocked');
    expect(result.outcomes.map(o => o.job_id)).toEqual(['J1', 'J2', 'J3']);
  });

  it('keeps empty_tag null and reports empty_tag_state when the tags ledger is absent or refused', async () => {
    const missing = await readRouterOutcomes({ runsDir: runsDir('{"job":"J1","phase":"MERGED"}\n') });
    expect(missing).toMatchObject({ state: 'read', empty_tag_state: 'missing', empty_tag_truncated: false });
    expect(missing.outcomes[0]?.empty_tag).toBeNull();

    const root = runsDir('{"job":"J1","phase":"MERGED"}\n');
    const target = join(root, 'real-empty-tags.jsonl');
    writeFileSync(target, JSON.stringify(emptyTag('J1', 'blocked')) + '\n');
    symlinkSync(target, emptyTagsPath(root));
    const linked = await readRouterOutcomes({ runsDir: root });
    expect(linked).toMatchObject({ state: 'read', empty_tag_state: 'unreadable' });
    expect(linked.outcomes[0]?.empty_tag).toBeNull();
  });

  it('still reports empty-tag health when the jobs ledger itself is missing', async () => {
    const root = runsDir();
    writeEmptyTags(root, [emptyTag('J1', 'blocked')]);
    const result = await readRouterOutcomes({ runsDir: root });
    expect(result).toMatchObject({ state: 'missing', empty_tag_state: 'read', empty_tag_truncated: false, outcomes: [] });
  });

  it('flags a cut empty-tags tail so joined tags read as newest-bytes coverage', async () => {
    const root = runsDir('{"job":"J1","phase":"MERGED"}\n');
    writeFileSync(emptyTagsPath(root), '');
    truncateSync(emptyTagsPath(root), ROUTER_OUTCOME_LEDGER_LIMIT + 1);
    const result = await readRouterOutcomes({ runsDir: root });
    expect(result).toMatchObject({ state: 'read', empty_tag_state: 'read', empty_tag_truncated: true });
    expect(result.outcomes[0]?.empty_tag).toBeNull();
  });
});

describe('router outcome merge-events join', () => {
  it('folds merge-events rows to per-PR evidence under the merge-latency validation', () => {
    const events = foldMergeEvents([
      // Malformed and non-object rows never count.
      'not json', '[1,2]', '42', '',
      // Bad repo/pr/type shapes skip.
      JSON.stringify({ repo: 'no-slash', pr: 1, type: 'queued', at: '2026-11-21T00:00:00Z' }),
      JSON.stringify({ repo: 'a/b', pr: 0, type: 'queued', at: '2026-11-21T00:00:00Z' }),
      JSON.stringify({ repo: 'a/b', pr: 1.5, type: 'queued', at: '2026-11-21T00:00:00Z' }),
      JSON.stringify({ repo: 'a/b', pr: 1, type: 'sideways', at: '2026-11-21T00:00:00Z' }),
      // blocked needs an in-vocabulary reason; check_observed a recorded
      // conclusion and a boolean-or-absent required.
      JSON.stringify({ repo: 'a/b', pr: 1, type: 'blocked', at: '2026-11-21T00:00:00Z' }),
      JSON.stringify({ repo: 'a/b', pr: 1, type: 'blocked', reason: 'sideways', at: '2026-11-21T00:00:00Z' }),
      JSON.stringify({ repo: 'a/b', pr: 1, type: 'check_observed', conclusion: 'green', at: '2026-11-21T00:00:00Z' }),
      JSON.stringify({ repo: 'a/b', pr: 1, type: 'check_observed', conclusion: 'failure', required: 'yes', at: '2026-11-21T00:00:00Z' }),
      // Every type outside the state/terminal set needs a parseable at.
      JSON.stringify({ repo: 'a/b', pr: 1, type: 'queued' }),
      JSON.stringify({ repo: 'a/b', pr: 1, type: 'queued', at: 'not a time' }),
      // Untimed state/terminal rows still count as recorded observations;
      // repo case canonicalizes to the same prKey pullRequestKey produces.
      JSON.stringify({ repo: 'AshlrAI/Phantom', pr: 7, type: 'auto_merge_enabled' }),
      JSON.stringify({ repo: 'AshlrAI/Phantom', pr: 7, type: 'auto_merge_disabled' }),
      JSON.stringify({ repo: 'AshlrAI/Phantom', pr: 7, type: 'merged' }),
      // The qualifying rows for PR 7.
      ...[
        mergeEvent(7, 'opened'),
        mergeEvent(7, 'queued'),
        mergeEvent(7, 'blocked', { reason: 'required_checks' }),
        mergeEvent(7, 'blocked', { reason: 'review' }),
        mergeEvent(7, 'blocked', { reason: 'required_checks' }),   // repeat reason: distinct once
        mergeEvent(7, 'check_observed', { conclusion: 'failure', required: true }),
        mergeEvent(7, 'check_observed', { conclusion: 'failure' }), // unrelated failure still counts
        mergeEvent(7, 'check_observed', { conclusion: 'success', required: true }),
        mergeEvent(7, 'check_observed', { conclusion: 'pending' }),
        mergeEvent(7, 'checks_passed'),
        mergeEvent(7, 'conflict'),
        mergeEvent(7, 'retry_requested', { head_sha: 'ABC123' }),
        mergeEvent(7, 'retry_requested', { head_sha: 'abc123' }),   // same at+head: replay dedupes
        mergeEvent(7, 'retry_requested', { head_sha: 'def456', at: '2026-11-21T01:00:00Z' }),
        mergeEvent(7, 'retry_failed', { head_sha: 'abc123' }),
        mergeEvent(7, 'recut_requested', { head_sha: 'abc123' }),
        mergeEvent(7, 'recut_requested', { head_sha: 'abc123' }),   // recuts count rows, not dedupe
      ],
    ].map(r => typeof r === 'string' ? r : JSON.stringify(r)).join('\n'));
    // The three untimed terminals plus the seventeen timed rows for PR 7 qualify.
    expect(events.get('ashlrai/phantom#7')).toEqual({
      events: 20,
      blocked_reasons: ['required_checks', 'review'],
      conflicts: 1,
      check_failures: 2,
      required_check_failures: 1,
      checks_passed: 1,
      check_observations: 4,
      retries: 2,
      retry_failures: 1,
      recuts: 2,
      auto_merge: 'disabled',
    } satisfies MergeQueueEvidence);
    expect(events.size).toBe(1);
  });

  it('joins merge_queue through each job\'s newest unambiguous canonical PR claim only', () => {
    const mq: MergeQueueEvidence = {
      events: 3, blocked_reasons: ['queue'], conflicts: 0, check_failures: 0,
      required_check_failures: 0, checks_passed: 0, check_observations: 0,
      retries: 0, retry_failures: 0, recuts: 0, auto_merge: null,
    };
    const mqNewer: MergeQueueEvidence = { ...mq, events: 9, blocked_reasons: ['conflict'] };
    const events = new Map([
      ['ashlrai/phantom#42', mq],
      ['ashlrai/phantom#77', mqNewer],
    ]);
    const fold = foldRouterOutcomes([
      // J1 claims PR 42 unambiguously -> joins.
      '{"job":"J1","lane":"alpha","phase":"MERGED","pr_url":"https://github.com/ashlrai/phantom/pull/42","ts":"2026-11-01T00:00:00Z"}',
      // J2 and J3 contest PR 43 -> ambiguous, never joins.
      '{"job":"J2","phase":"MERGED","pr_url":"https://github.com/ashlrai/phantom/pull/43"}',
      '{"job":"J3","phase":"MERGED","pr_url":"https://github.com/ashlrai/phantom/pull/43"}',
      // J4's claim is not the canonical github.com pull shape -> never joins.
      '{"job":"J4","phase":"MERGED","pr_url":"https://github.com/ashlrai/phantom/pull/42/files"}',
      // J5 claims PR 88 first, then PR 77 — the newest standing claim is
      // what joins, so it picks up #77's evidence, not the earlier claim's.
      '{"job":"J5","phase":"MERGED","pr_url":"https://github.com/ashlrai/phantom/pull/88"}',
      '{"job":"J5","phase":"MERGED","pr_url":"https://github.com/ashlrai/phantom/pull/77","ts":"2026-11-02T00:00:00Z"}',
      // J6 claims a PR with no recorded events -> merge_queue stays null.
      '{"job":"J6","phase":"MERGED","pr_url":"https://github.com/ashlrai/phantom/pull/99"}',
    ].join('\n'), { mergeEvents: events });
    const byId = new Map(fold.outcomes.map(o => [o.job_id, o]));
    expect(byId.get('J1')?.merge_queue).toEqual(mq);
    expect(byId.get('J1')?.merge_queue).not.toBe(mq); // defensive copy, not the map's object
    expect(byId.get('J5')?.merge_queue).toEqual(mqNewer);
    for (const id of ['J2', 'J3', 'J4', 'J6']) {
      expect(byId.get(id)?.merge_queue).toBeNull();
    }
    // Absent option: no join at all.
    const bare = foldRouterOutcomes('{"job":"J1","phase":"MERGED","pr_url":"https://github.com/ashlrai/phantom/pull/42"}');
    expect(bare.outcomes[0]?.merge_queue).toBeNull();
  });

  it.each([
    { name: 'winning verdict with out-of-order receipts', verdictPr: 42, expectedPr: 42 },
    { name: 'winning verdict with a contested PR', verdictPr: 42, contested: true, expectedPr: null },
    { name: 'URL-less verdict with multiple claims', verdictPr: null, expectedPr: null },
    { name: 'URL-less verdict with a sole claim', verdictPr: null, singleClaim: true, expectedPr: 77 },
  ])('binds queue and review evidence to the $name', ({ verdictPr, contested, singleClaim, expectedPr }) => {
    const url = (pr: number) => `https://github.com/ashlrai/phantom/pull/${pr}`;
    const rows = [
      { job: 'J1', phase: 'MERGED', mergedAt: '2026-11-22T00:00:00Z', ...(verdictPr ? { url: url(verdictPr) } : {}) },
      { job: 'J1', phase: 'PUBLISHED', url: url(77) },
      ...(!singleClaim ? [{ job: 'J1', phase: 'CLOSED', closedAt: '2026-11-21T00:00:00Z', url: url(verdictPr ? 77 : 42) }] : []),
      ...(contested ? [{ job: 'J2', phase: 'PUBLISHED', url: url(42) }] : []),
    ];
    const mergeEvents = foldMergeEvents([
      mergeEvent(42, 'check_observed', { conclusion: 'failure', required: true }),
      mergeEvent(77, 'checks_passed'),
    ].map(row => JSON.stringify(row)).join('\n'));
    const crossReviews = new Map<string, CrossReviewEvidence>([
      ['ashlrai/phantom#42', { outcome: 'reject', at: null }],
      ['ashlrai/phantom#77', { outcome: 'approve', at: null }],
    ]);
    const { outcomes } = foldRouterOutcomes(rows.map(row => JSON.stringify(row)).join('\n'), { mergeEvents, crossReviews });
    const expectedKey = `ashlrai/phantom#${expectedPr}`;
    expect(outcomes[0]).toMatchObject({
      merged: true,
      merge_queue: mergeEvents.get(expectedKey) ?? null,
      cross_review: crossReviews.get(expectedKey) ?? null,
      ci_first_pass: expectedPr === null ? null : expectedPr === 77,
    });
  });

  it('joins recorded merge-queue evidence onto outcomes and never creates outcomes for event-only PRs', async () => {
    const root = runsDir([
      '{"job":"J1","lane":"alpha","phase":"MERGED","pr_url":"https://github.com/ashlrai/phantom/pull/42","ts":"2026-11-01T00:00:00Z"}',
      '{"job":"J2","lane":"alpha","phase":"CLOSED","pr_url":"https://github.com/ashlrai/phantom/pull/43","ts":"2026-11-01T00:00:00Z"}',
      '{"job":"J3","lane":"beta","phase":"VERIFIED","ts":"2026-11-01T00:00:00Z"}',
    ].join('\n'));
    writeMergeEvents(root, [
      mergeEvent(42, 'queued'),
      mergeEvent(42, 'blocked', { reason: 'required_checks' }),
      mergeEvent(42, 'check_observed', { conclusion: 'failure', required: true }),
      mergeEvent(42, 'merged'),
      mergeEvent(43, 'conflict'),
      mergeEvent(43, 'auto_merge_enabled'),
      // PR 44 has observations but no jobs outcome claims it: joins nothing.
      mergeEvent(44, 'blocked', { reason: 'review' }),
    ]);
    const result = await readRouterOutcomes({ runsDir: root });
    expect(result).toMatchObject({ state: 'read', merge_events_state: 'read', merge_events_truncated: false });
    const byId = new Map(result.outcomes.map(o => [o.job_id, o]));
    expect(byId.get('J1')?.merge_queue).toEqual({
      events: 4, blocked_reasons: ['required_checks'], conflicts: 0,
      check_failures: 1, required_check_failures: 1,
      checks_passed: 0, check_observations: 1,
      retries: 0, retry_failures: 0, recuts: 0, auto_merge: null,
    });
    expect(byId.get('J2')?.merge_queue).toEqual({
      events: 2, blocked_reasons: [], conflicts: 1,
      check_failures: 0, required_check_failures: 0,
      checks_passed: 0, check_observations: 0,
      retries: 0, retry_failures: 0, recuts: 0, auto_merge: 'enabled',
    });
    // No claim, no join — unknown stays null, never a guessed queue history.
    expect(byId.get('J3')?.merge_queue).toBeNull();
    // The joined check record resolves ci_first_pass fill-only: J1's
    // recorded check failure reads false; J2 recorded no check rows.
    expect(byId.get('J1')?.ci_first_pass).toBe(false);
    expect(byId.get('J2')?.ci_first_pass).toBeNull();
    expect(result.outcomes.map(o => o.job_id)).toEqual(['J1', 'J2', 'J3']);
  });

  it('derives ci_first_pass fill-only from the joined merge-queue check record', async () => {
    const root = runsDir([
      // J1: clean checks_passed boundary, no failures -> true.
      '{"job":"J1","lane":"alpha","phase":"MERGED","pr_url":"https://github.com/ashlrai/phantom/pull/51","ts":"2026-11-01T00:00:00Z"}',
      // J2: a recorded failure beside a later checks_passed -> false; a
      // rerun or new head got it green, which is not a first pass.
      '{"job":"J2","lane":"alpha","phase":"MERGED","pr_url":"https://github.com/ashlrai/phantom/pull/52","ts":"2026-11-01T00:00:00Z"}',
      // J3: a merge with pending-only check observations stays unknown.
      '{"job":"J3","lane":"alpha","phase":"MERGED","pr_url":"https://github.com/ashlrai/phantom/pull/53","ts":"2026-11-01T00:00:00Z"}',
      // J4: pending-only observations on an unmerged PR -> null.
      '{"job":"J4","lane":"alpha","phase":"CLOSED","pr_url":"https://github.com/ashlrai/phantom/pull/54","ts":"2026-11-01T00:00:00Z"}',
      // J5: the jobs row's own verdict wins over contradicting queue evidence.
      '{"job":"J5","lane":"alpha","phase":"MERGED","pr_url":"https://github.com/ashlrai/phantom/pull/55","ci_first_pass":true,"ts":"2026-11-01T00:00:00Z"}',
      // J6: merged but the observer recorded no check rows -> null.
      '{"job":"J6","lane":"alpha","phase":"MERGED","pr_url":"https://github.com/ashlrai/phantom/pull/56","ts":"2026-11-01T00:00:00Z"}',
      // J7: closed unmerged with a checks_passed boundary -> true; CI
      // cleanliness is merge-independent.
      '{"job":"J7","lane":"alpha","phase":"CLOSED","pr_url":"https://github.com/ashlrai/phantom/pull/57","ts":"2026-11-01T00:00:00Z"}',
    ].join('\n'));
    writeMergeEvents(root, [
      mergeEvent(51, 'check_observed', { conclusion: 'success', required: true }),
      mergeEvent(51, 'checks_passed'),
      mergeEvent(52, 'check_observed', { conclusion: 'failure', required: true }),
      mergeEvent(52, 'check_observed', { conclusion: 'success', required: true }),
      mergeEvent(52, 'checks_passed'),
      mergeEvent(53, 'check_observed', { conclusion: 'pending', required: true }),
      mergeEvent(53, 'merged'),
      mergeEvent(54, 'check_observed', { conclusion: 'pending' }),
      mergeEvent(54, 'closed'),
      mergeEvent(55, 'check_observed', { conclusion: 'failure' }),
      mergeEvent(55, 'checks_passed'),
      mergeEvent(56, 'merged'),
      mergeEvent(57, 'checks_passed'),
      mergeEvent(57, 'closed'),
    ]);
    const result = await readRouterOutcomes({ runsDir: root });
    const byId = new Map(result.outcomes.map(o => [o.job_id, o]));
    expect(byId.get('J1')?.ci_first_pass).toBe(true);
    expect(byId.get('J2')?.ci_first_pass).toBe(false);
    expect(byId.get('J3')?.ci_first_pass).toBeNull();
    expect(byId.get('J4')?.ci_first_pass).toBeNull();
    expect(byId.get('J5')?.ci_first_pass).toBe(true);
    expect(byId.get('J6')?.ci_first_pass).toBeNull();
    expect(byId.get('J7')?.ci_first_pass).toBe(true);
  });

  it('keeps CI unknown when a reward-resolved merge has only an individual passing check', async () => {
    const root = runsDir('{"job":"J1","lane":"alpha","phase":"VERIFIED","pr_url":"https://github.com/ashlrai/phantom/pull/61","ts":"2026-11-01T00:00:00Z"}\n');
    writeMergeEvents(root, [
      mergeEvent(61, 'check_observed', { conclusion: 'success', required: true }),
      mergeEvent(61, 'merged'),
    ]);
    const ashlar = rewardLedger([rewardRow('J1', true)]);
    const result = await readRouterOutcomes({ runsDir: root, ashlarDir: ashlar });
    const [o] = result.outcomes;
    expect(o?.merged).toBe(true);
    expect(o?.ci_first_pass).toBeNull();
  });

  it.each([
    { receipt: 'recut_requested', tally: 'recuts' },
    { receipt: 'retry_requested', tally: 'retries' },
    { receipt: 'retry_failed', tally: 'retry_failures' },
  ])('withholds first-pass credit for a green PR with a $receipt receipt', async ({ receipt, tally }) => {
    const root = runsDir([
      { job: 'J1', phase: 'MERGED', pr_url: 'https://github.com/ashlrai/phantom/pull/61' },
      { job: 'J2', phase: 'MERGED', pr_url: 'https://github.com/ashlrai/phantom/pull/62' },
      { job: 'J3', phase: 'MERGED', pr_url: 'https://github.com/ashlrai/phantom/pull/63', ci_first_pass: true },
    ].map(row => JSON.stringify(row)).join('\n'));
    writeMergeEvents(root, [
      mergeEvent(61, receipt),
      mergeEvent(61, 'checks_passed'),
      mergeEvent(62, 'check_observed', { conclusion: 'failure' }),
      mergeEvent(62, receipt),
      mergeEvent(62, 'checks_passed'),
      mergeEvent(63, receipt),
      mergeEvent(63, 'checks_passed'),
    ]);
    const { outcomes } = await readRouterOutcomes({ runsDir: root });
    const byId = new Map(outcomes.map(outcome => [outcome.job_id, outcome]));
    expect(byId.get('J1')).toMatchObject({
      ci_first_pass: null,
      merge_queue: { [tally]: 1, checks_passed: 1 },
    });
    expect(byId.get('J2')?.ci_first_pass).toBe(false);
    expect(byId.get('J3')?.ci_first_pass).toBe(true);
  });

  it('keeps merge_queue null and reports merge_events_state when the ledger is absent or refused', async () => {
    const missing = await readRouterOutcomes({ runsDir: runsDir('{"job":"J1","phase":"MERGED","pr_url":"https://github.com/ashlrai/phantom/pull/42"}\n') });
    expect(missing).toMatchObject({ state: 'read', merge_events_state: 'missing', merge_events_truncated: false });
    expect(missing.outcomes[0]?.merge_queue).toBeNull();

    const root = runsDir('{"job":"J1","phase":"MERGED","pr_url":"https://github.com/ashlrai/phantom/pull/42"}\n');
    const target = join(root, 'real-merge-events.jsonl');
    writeFileSync(target, JSON.stringify(mergeEvent(42, 'queued')) + '\n');
    symlinkSync(target, mergeEventsPath(root));
    const linked = await readRouterOutcomes({ runsDir: root });
    expect(linked).toMatchObject({ state: 'read', merge_events_state: 'unreadable' });
    expect(linked.outcomes[0]?.merge_queue).toBeNull();
  });

  it('still reports merge-events health when the jobs ledger itself is missing', async () => {
    const root = runsDir();
    writeMergeEvents(root, [mergeEvent(42, 'queued')]);
    const result = await readRouterOutcomes({ runsDir: root });
    expect(result).toMatchObject({ state: 'missing', merge_events_state: 'read', merge_events_truncated: false, outcomes: [] });
  });

  it('flags a cut merge-events tail so joined evidence reads as newest-bytes coverage', async () => {
    const root = runsDir('{"job":"J1","phase":"MERGED","pr_url":"https://github.com/ashlrai/phantom/pull/42"}\n');
    writeFileSync(mergeEventsPath(root), '');
    truncateSync(mergeEventsPath(root), ROUTER_OUTCOME_LEDGER_LIMIT + 1);
    const result = await readRouterOutcomes({ runsDir: root });
    expect(result).toMatchObject({ state: 'read', merge_events_state: 'read', merge_events_truncated: true });
    expect(result.outcomes[0]?.merge_queue).toBeNull();
  });

  it.each(['{"type":', 'null'])('withholds first-pass success when the merge-events journal contains %s', async (malformed) => {
    const root = runsDir([
      { job: 'J1', pr_url: 'https://github.com/ashlrai/phantom/pull/42' },
      { job: 'J2', pr_url: 'https://github.com/ashlrai/phantom/pull/43' },
      { job: 'J3', pr_url: 'https://github.com/ashlrai/phantom/pull/44', ci_first_pass: true },
    ].map(row => JSON.stringify(row)).join('\n'));
    writeMergeEvents(root, [
      mergeEvent(43, 'check_observed', { conclusion: 'failure' }),
      mergeEvent(42, 'checks_passed'),
      mergeEvent(43, 'checks_passed'),
      mergeEvent(44, 'checks_passed'),
    ]);
    appendFileSync(mergeEventsPath(root), '\n' + malformed + '\n');

    const result = await readRouterOutcomes({ runsDir: root });
    expect(result).toMatchObject({ merge_events_state: 'read', merge_events_truncated: false });
    expect(result.outcomes).toMatchObject([
      { job_id: 'J1', ci_first_pass: null, merge_queue: { checks_passed: 1 } },
      { job_id: 'J2', ci_first_pass: false, merge_queue: { check_failures: 1 } },
      { job_id: 'J3', ci_first_pass: true, merge_queue: { checks_passed: 1 } },
    ]);
  });

  it('keeps queue evidence without inferring first-pass success from a cut merge-events tail', async () => {
    const root = runsDir([
      '{"job":"J1","phase":"MERGED","pr_url":"https://github.com/ashlrai/phantom/pull/42"}',
      '{"job":"J2","phase":"MERGED","pr_url":"https://github.com/ashlrai/phantom/pull/43"}',
      '{"job":"J3","phase":"MERGED","pr_url":"https://github.com/ashlrai/phantom/pull/44","ci_first_pass":true}',
    ].join('\n'));
    writeMergeEvents(root, [mergeEvent(42, 'check_observed', { conclusion: 'failure' })]);
    truncateSync(mergeEventsPath(root), ROUTER_OUTCOME_LEDGER_LIMIT + 1);
    appendFileSync(mergeEventsPath(root), '\n' + [
      mergeEvent(42, 'checks_passed'),
      mergeEvent(43, 'check_observed', { conclusion: 'failure' }),
      mergeEvent(43, 'checks_passed'),
      mergeEvent(44, 'checks_passed'),
    ].map(row => JSON.stringify(row)).join('\n') + '\n');

    const result = await readRouterOutcomes({ runsDir: root });
    expect(result).toMatchObject({ state: 'read', merge_events_state: 'read', merge_events_truncated: true });
    expect(result.outcomes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        job_id: 'J1', ci_first_pass: null,
        merge_queue: expect.objectContaining({ checks_passed: 1, check_failures: 0 }),
      }),
      expect.objectContaining({ job_id: 'J2', ci_first_pass: false }),
      expect.objectContaining({ job_id: 'J3', ci_first_pass: true }),
    ]));
  });
});

describe('router outcome cross-review join', () => {
  it('foldCrossReviews keeps only kind:review rows under the schema with a bounded verdict', () => {
    const reviews = foldCrossReviews([
      // Malformed and non-object rows never count.
      'not json', '[1,2]', '42', '',
      // Wrong schema version, decision rows and foreign kinds never count.
      JSON.stringify({ ...crossReview(1, 'approve'), schemaVersion: 2 }),
      JSON.stringify({ ...crossReview(2, 'approve'), kind: 'decision' }),
      JSON.stringify({ ...crossReview(3, 'approve'), kind: 'sideways' }),
      // Bad repo/pr/outcome shapes skip.
      JSON.stringify({ ...crossReview(4, 'approve'), repo: 'no-slash' }),
      JSON.stringify({ ...crossReview(0, 'approve') }),
      JSON.stringify({ ...crossReview(1.5, 'approve') }),
      JSON.stringify(crossReview(5, 'sideways')),
      // The qualifying rows for PR 7 — repo case canonicalizes to the
      // prKey pullRequestKey produces, and the last appended review wins.
      JSON.stringify(crossReview(7, 'reject', { repo: 'AshlrAI/Phantom', at: '2026-11-21T01:00:00Z' })),
      JSON.stringify(crossReview(7, 'approve', { at: '2026-11-21T02:00:00Z' })),
      // An unparseable `at` keeps the verdict but nulls the timestamp.
      JSON.stringify(crossReview(8, 'failed', { at: 'not a time' })),
      // A PR no outcome claims joins nothing — the map never creates outcomes.
      JSON.stringify(crossReview(99, 'approve')),
    ].join('\n'));
    expect(reviews.get('ashlrai/phantom#7')).toEqual({ outcome: 'approve', at: '2026-11-21T02:00:00Z' } satisfies CrossReviewEvidence);
    expect(reviews.get('ashlrai/phantom#8')).toEqual({ outcome: 'failed', at: null });
    expect(reviews.size).toBe(3);
  });

  it('joins cross_review through each job\'s newest unambiguous canonical PR claim only', () => {
    const reviews = new Map<string, CrossReviewEvidence>([
      ['ashlrai/phantom#42', { outcome: 'reject', at: '2026-11-21T00:00:00Z' }],
      ['ashlrai/phantom#77', { outcome: 'approve', at: '2026-11-22T00:00:00Z' }],
    ]);
    const fold = foldRouterOutcomes([
      // J1 claims PR 42 unambiguously -> joins.
      '{"job":"J1","lane":"alpha","phase":"MERGED","pr_url":"https://github.com/ashlrai/phantom/pull/42","ts":"2026-11-01T00:00:00Z"}',
      // J2 and J3 contest PR 43 -> ambiguous, never joins.
      '{"job":"J2","phase":"MERGED","pr_url":"https://github.com/ashlrai/phantom/pull/43"}',
      '{"job":"J3","phase":"MERGED","pr_url":"https://github.com/ashlrai/phantom/pull/43"}',
      // J4's claim is not the canonical github.com pull shape -> never joins.
      '{"job":"J4","phase":"MERGED","pr_url":"https://github.com/ashlrai/phantom/pull/42/files"}',
      // J5 claims PR 88 first, then PR 77 — the newest standing claim joins.
      '{"job":"J5","phase":"MERGED","pr_url":"https://github.com/ashlrai/phantom/pull/88"}',
      '{"job":"J5","phase":"MERGED","pr_url":"https://github.com/ashlrai/phantom/pull/77","ts":"2026-11-02T00:00:00Z"}',
      // J6 claims a PR with no recorded review -> cross_review stays null.
      '{"job":"J6","phase":"MERGED","pr_url":"https://github.com/ashlrai/phantom/pull/99"}',
    ].join('\n'), { crossReviews: reviews });
    const byId = new Map(fold.outcomes.map(o => [o.job_id, o]));
    expect(byId.get('J1')?.cross_review).toEqual({ outcome: 'reject', at: '2026-11-21T00:00:00Z' });
    expect(byId.get('J5')?.cross_review).toEqual({ outcome: 'approve', at: '2026-11-22T00:00:00Z' });
    for (const id of ['J2', 'J3', 'J4', 'J6']) {
      expect(byId.get(id)?.cross_review).toBeNull();
    }
    // Absent option: no join at all.
    const bare = foldRouterOutcomes('{"job":"J1","phase":"MERGED","pr_url":"https://github.com/ashlrai/phantom/pull/42"}');
    expect(bare.outcomes[0]?.cross_review).toBeNull();
  });

  it('joins recorded review verdicts onto outcomes and never creates outcomes for review-only PRs', async () => {
    const root = runsDir([
      '{"job":"J1","lane":"alpha","phase":"MERGED","pr_url":"https://github.com/ashlrai/phantom/pull/42","ts":"2026-11-01T00:00:00Z"}',
      '{"job":"J2","lane":"alpha","phase":"CLOSED","pr_url":"https://github.com/ashlrai/phantom/pull/43","ts":"2026-11-01T00:00:00Z"}',
      '{"job":"J3","lane":"beta","phase":"VERIFIED","ts":"2026-11-01T00:00:00Z"}',
    ].join('\n'));
    const ashlar = crossReviewLedger([
      crossReview(42, 'approve'),
      // A decision row is merge-action evidence, never a review verdict.
      { ...crossReview(43, 'approve'), kind: 'decision', action: 'enable-auto-merge' },
      crossReview(43, 'reject'),
      // PR 44 has a review but no jobs outcome claims it: joins nothing.
      crossReview(44, 'approve'),
    ]);
    const result = await readRouterOutcomes({ runsDir: root, ashlarDir: ashlar });
    expect(result).toMatchObject({ state: 'read', cross_review_state: 'read', cross_review_truncated: false });
    const byId = new Map(result.outcomes.map(o => [o.job_id, o]));
    expect(byId.get('J1')?.cross_review).toEqual({ outcome: 'approve', at: '2026-11-21T00:00:00.000Z' });
    expect(byId.get('J2')?.cross_review).toEqual({ outcome: 'reject', at: '2026-11-21T00:00:00.000Z' });
    // No claim, no join — unknown stays null, never a guessed review.
    expect(byId.get('J3')?.cross_review).toBeNull();
    expect(result.outcomes.map(o => o.job_id)).toEqual(['J1', 'J2', 'J3']);
  });

  it('keeps cross_review null and reports cross_review_state when the ledger is absent or refused', async () => {
    const emptyAshlar = mkdtempSync(join(tmpdir(), 'ledger-612s-xreview-empty-'));
    roots.push(emptyAshlar);
    const missing = await readRouterOutcomes({
      runsDir: runsDir('{"job":"J1","phase":"MERGED","pr_url":"https://github.com/ashlrai/phantom/pull/42"}\n'),
      ashlarDir: emptyAshlar,
    });
    expect(missing).toMatchObject({ state: 'read', cross_review_state: 'missing', cross_review_truncated: false });
    expect(missing.outcomes[0]?.cross_review).toBeNull();

    const root = runsDir('{"job":"J1","phase":"MERGED","pr_url":"https://github.com/ashlrai/phantom/pull/42"}\n');
    const target = join(root, 'real-cross-review.jsonl');
    writeFileSync(target, JSON.stringify(crossReview(42, 'approve')) + '\n');
    const ashlar = mkdtempSync(join(tmpdir(), 'ledger-612s-xreview-link-'));
    roots.push(ashlar);
    mkdirSync(join(ashlar, 'fleet'), { recursive: true });
    symlinkSync(target, crossReviewLedgerPath(ashlar));
    const linked = await readRouterOutcomes({ runsDir: root, ashlarDir: ashlar });
    expect(linked).toMatchObject({ state: 'read', cross_review_state: 'unreadable' });
    expect(linked.outcomes[0]?.cross_review).toBeNull();
  });
});

describe('router outcome reward-signals join', () => {
  it('foldRewardSignals keeps only v1 rows and collapses repeats last-wins', () => {
    const rewards = foldRewardSignals([
      JSON.stringify(rewardRow('J1', true)),
      'not json',
      JSON.stringify({ ...rewardRow('J2', false), v: 2 }),
      JSON.stringify({ ...rewardRow('J3', true), jobId: 'bad id!' }),
      JSON.stringify({ ...rewardRow('J4', true), merged: 'yes' }),
      JSON.stringify({ ...rewardRow('J5', true), dispatchedAt: 'not a date' }),
      JSON.stringify(rewardRow('J1', false, { timeToMergeMs: 5000, mergedAt: null })),
      JSON.stringify(rewardRow('J6', true, {
        cost: { pool: 'codex-cmp', pctUsedStart: 10, pctUsedEnd: 12.5, pctUsedDelta: 140, costUsd: -1 },
        repo: '../escape', timeToMergeMs: 500, ciWallMs: null,
      })),
    ].join('\n'));
    expect([...rewards.keys()].sort()).toEqual(['J1', 'J6']);
    // The second J1 row wins the repeat: closed-unmerged verdict, no merge span.
    expect(rewards.get('J1')).toEqual({
      merged: false, ttm_s: null, ci_wall_s: 600, cost_usd: 0.75,
      repo: 'ashlrai/phantom', pool_pct_used: 2.5,
    });
    // Out-of-shape consumed fields drop to null without discarding the row.
    expect(rewards.get('J6')).toEqual({
      merged: true, ttm_s: 0.5, ci_wall_s: null, cost_usd: null,
      repo: null, pool_pct_used: null,
    });
  });

  it('fills only fields the jobs fold left null and never contradicts a recorded verdict', async () => {
    const root = runsDir([
      // J1: no merge verdict, no repo, no cost — the reward row fills them all.
      '{"job":"J1","lane":"alpha","phase":"VERIFIED","ts":"2026-11-01T00:00:00Z"}',
      // J2: the jobs ledger already recorded the merge and its own ttm/cost —
      // the reward row's conflicting verdict and figures never win.
      '{"job":"J2","lane":"alpha","phase":"MERGED","ts":"2026-11-01T00:00:00Z","mergedAt":"2026-11-01T01:00:00Z","ttm_s":120,"cost_usd":2,"repo":"fleet-name"}',
      // J3: the jobs ledger recorded CLOSED — the reward row's merged:true loses,
      // and ttm_s stays null because the standing verdict is not a merge.
      '{"job":"J3","lane":"beta","phase":"CLOSED","ts":"2026-11-01T00:00:00Z"}',
      // J4: closed verdict plus a reward merged:false — still no merge span.
      '{"job":"J4","lane":"beta","phase":"VERIFIED","ts":"2026-11-01T00:00:00Z"}',
    ].join('\n'));
    const ashlar = rewardLedger([
      rewardRow('J1', true),
      rewardRow('J2', false, { timeToMergeMs: 999_000, ciWallMs: 1 }),
      rewardRow('J3', true),
      rewardRow('J4', false, { timeToMergeMs: 5_000 }),
      // JX has a reward row but no jobs outcome: it never creates one.
      rewardRow('JX', true),
    ]);
    const result = await readRouterOutcomes({ runsDir: root, ashlarDir: ashlar });
    expect(result).toMatchObject({ state: 'read', reward_state: 'read', reward_truncated: false });
    const byId = new Map(result.outcomes.map(o => [o.job_id, o]));
    expect(byId.get('J1')).toMatchObject({
      merged: true, ttm_s: 3600, ci_wall_s: 600, cost_usd: 0.75,
      repo: 'ashlrai/phantom', pool_pct_used: 2.5,
    });
    expect(byId.get('J2')).toMatchObject({
      merged: true, ttm_s: 120, cost_usd: 2, repo: 'fleet-name', pool_pct_used: 2.5,
    });
    expect(byId.get('J3')).toMatchObject({ merged: false, ttm_s: null, pool_pct_used: 2.5 });
    expect(byId.get('J4')).toMatchObject({ merged: false, ttm_s: null });
    expect(byId.has('JX')).toBe(false);
    expect(result.outcomes.map(o => o.job_id)).toEqual(['J1', 'J2', 'J3', 'J4']);
  });

  it('withholds CI timing when an undated boundary could belong to the dated pair', async () => {
    const rows = [
      { job: 'J1', event: 'ci_start', ts: '2026-11-01T00:00:00Z' },
      { job: 'J1', event: 'ci_complete', ts: '2026-11-01T00:05:00Z' },
      { job: 'J1', event: 'ci_start' },
    ].map(row => JSON.stringify(row)).join('\n');
    expect(foldRouterOutcomes(rows).outcomes[0]?.ci_wall_s).toBeNull();

    const result = await readRouterOutcomes({
      runsDir: runsDir(rows),
      ashlarDir: rewardLedger([rewardRow('J1', true)]),
    });
    expect(result.outcomes[0]).toMatchObject({ merged: true, ci_wall_s: null });
  });

  it('lets api-spend cost evidence win over the reward row, reward cost only as last resort', async () => {
    const root = runsDir('{"job":"J1","lane":"alpha","phase":"MERGED","ts":"2026-11-01T00:00:00Z"}\n');
    writeSpend(root, '{"job":"J1","cost_usd":1.5,"ts":"2026-11-01T00:30:00Z"}\n');
    const result = await readRouterOutcomes({ runsDir: root, ashlarDir: rewardLedger([rewardRow('J1', true)]) });
    expect(result.outcomes[0]).toMatchObject({ cost_usd: 1.5, pool_pct_used: 2.5 });
  });

  it('requires a reward merge verdict to fill a missing time to merge', async () => {
    const root = runsDir([
      '{"job":"J1","lane":"alpha","phase":"MERGED","ts":"2026-11-01T01:00:00Z"}',
      '{"job":"J2","lane":"alpha","phase":"MERGED","ts":"2026-11-01T01:00:00Z"}',
    ].join('\n'));
    const ashlarDir = rewardLedger([
      rewardRow('J1', false, { timeToMergeMs: 5_000 }),
      rewardRow('J2', true, { timeToMergeMs: 5_000 }),
    ]);
    const result = await readRouterOutcomes({ runsDir: root, ashlarDir, authorityEvidence: null });
    expect(result.outcomes).toMatchObject([
      { job_id: 'J1', merged: true, ttm_s: null, pool_pct_used: 2.5 },
      { job_id: 'J2', merged: true, ttm_s: 5, pool_pct_used: 2.5 },
    ]);
  });

  it('keeps jobs-ledger values and reports reward_state when the ledger is absent, refused or the jobs read failed', async () => {
    const missing = await readRouterOutcomes({ runsDir: runsDir('{"job":"J1","phase":"MERGED","ts":"2026-11-01T00:00:00Z"}\n') });
    expect(missing).toMatchObject({ state: 'read', reward_state: 'missing', reward_truncated: false });
    expect(missing.outcomes[0]).toMatchObject({ merged: true, pool_pct_used: null });

    const root = runsDir('{"job":"J1","phase":"MERGED","ts":"2026-11-01T00:00:00Z"}\n');
    const ashlar = mkdtempSync(join(tmpdir(), 'ledger-612s-reward-link-'));
    roots.push(ashlar);
    mkdirSync(join(ashlar, 'metrics'), { recursive: true });
    const target = join(ashlar, 'real-reward-signals.jsonl');
    writeFileSync(target, JSON.stringify(rewardRow('J1', true)) + '\n');
    symlinkSync(target, rewardSignalsPath(ashlar));
    const linked = await readRouterOutcomes({ runsDir: root, ashlarDir: ashlar });
    expect(linked).toMatchObject({ state: 'read', reward_state: 'unreadable' });
    expect(linked.outcomes[0]).toMatchObject({ merged: true, pool_pct_used: null });

    // The reward read still reports its health when the jobs ledger is missing.
    const noJobs = runsDir();
    const withReward = await readRouterOutcomes({ runsDir: noJobs, ashlarDir: rewardLedger([rewardRow('J1', true)]) });
    expect(withReward).toMatchObject({ state: 'missing', reward_state: 'read', reward_truncated: false, outcomes: [] });
  });

  it('flags a cut reward tail so joined evidence reads as newest-bytes coverage', async () => {
    const root = runsDir('{"job":"J1","phase":"VERIFIED","ts":"2026-11-01T00:00:00Z"}\n');
    const ashlar = rewardLedger([rewardRow('J1', true)]);
    writeFileSync(rewardSignalsPath(ashlar), '');
    truncateSync(rewardSignalsPath(ashlar), ROUTER_OUTCOME_LEDGER_LIMIT + 1);
    const result = await readRouterOutcomes({ runsDir: root, ashlarDir: ashlar });
    expect(result).toMatchObject({ state: 'read', reward_state: 'read', reward_truncated: true });
    // A cut tail that parses no valid rows in its retained window joins nothing.
    expect(result.outcomes[0]).toMatchObject({ merged: null, pool_pct_used: null });
  });
});

describe('router outcome launch-cost join', () => {
  it('foldLaunchCosts keeps only fleet.launch-cost.v1 rows under the producer contract and collapses repeats last-wins', () => {
    const costs = foldLaunchCosts([
      JSON.stringify(launchCostRow('J1-aaaabbbbcccc', 'measured')),
      'not json',
      JSON.stringify({ ...launchCostRow('J2', 'unknown'), schema: 'fleet.launch-cost.v2' }),
      JSON.stringify(launchCostRow('bad id!', 'measured')),
      JSON.stringify(launchCostRow('J3', 'measured', { windowSeconds: 30 })),
      JSON.stringify(launchCostRow('J4', 'unknown', { peakProcesses: 2 })),
      JSON.stringify(launchCostRow('J5', 'measured', { meanCpuPercentOneCore: 50, peakCpuPercentOneCore: 40 })),
      JSON.stringify(launchCostRow('J6', 'measured', { sampledSeconds: 30 })),
      JSON.stringify(launchCostRow('J7', 'partial', { samples: 0 })),
      JSON.stringify(launchCostRow('J8-hash00000001', 'measured')),
      JSON.stringify(launchCostRow('J8-hash00000002', 'partial', { peakProcesses: 9, meanCpuPercentOneCore: 3, peakCpuPercentOneCore: 8 })),
    ].join('\n'));
    expect([...costs.keys()].sort()).toEqual(['J1-aaaabbbbcccc', 'J8-hash00000001', 'J8-hash00000002']);
    expect(costs.get('J1-aaaabbbbcccc')).toEqual({
      status: 'measured', peakProcesses: 4, meanCpuPct: 12.5, peakCpuPct: 40,
    });
    // Distinct launchIds are distinct attempts — both rows stand.
    expect(costs.get('J8-hash00000002')).toEqual({
      status: 'partial', peakProcesses: 9, meanCpuPct: 3, peakCpuPct: 8,
    });
  });

  it('joins measured, partial and unknown probes through the producer\'s launchId forms', async () => {
    const root = runsDir([
      '{"job":"J1","lane":"alpha","phase":"MERGED","ts":"2026-11-01T00:00:00Z"}',
      '{"job":"J2","lane":"alpha","phase":"VERIFIED","ts":"2026-11-01T00:00:00Z"}',
      '{"job":"J3","lane":"beta","phase":"CLOSED","ts":"2026-11-01T00:00:00Z"}',
      // JX has launch-cost rows but no jobs outcome: it never creates one.
    ].join('\n'));
    writeLaunchCosts(root, [
      // Measured rows key <job>-<12-hex claim hash> — the suffix strips to the job.
      launchCostRow('J1-aaaabbbbcccc', 'measured'),
      launchCostRow('J2-ddddeeeeffff', 'partial', { peakProcesses: 7, meanCpuPercentOneCore: 20, peakCpuPercentOneCore: 55 }),
      // Unknown probes key the bare job id.
      launchCostRow('J3', 'unknown'),
      launchCostRow('JX-999988887777', 'measured'),
      // Malformed rows never join.
      launchCostRow('J1-ffffeeee1111', 'measured', { samples: 'lots' }),
    ]);
    const result = await readRouterOutcomes({ runsDir: root });
    expect(result).toMatchObject({ state: 'read', launch_cost_state: 'read', launch_cost_truncated: false });
    const byId = new Map(result.outcomes.map(o => [o.job_id, o]));
    expect(byId.get('J1')).toMatchObject({
      launch_cost_status: 'measured', launch_peak_processes: 4,
      launch_mean_cpu_pct: 12.5, launch_peak_cpu_pct: 40,
    });
    expect(byId.get('J2')).toMatchObject({
      launch_cost_status: 'partial', launch_peak_processes: 7,
      launch_mean_cpu_pct: 20, launch_peak_cpu_pct: 55,
    });
    // An unknown probe records the verdict but no figures — never zeros.
    expect(byId.get('J3')).toMatchObject({
      launch_cost_status: 'unknown', launch_peak_processes: null,
      launch_mean_cpu_pct: null, launch_peak_cpu_pct: null,
    });
    expect(byId.has('JX')).toBe(false);
    expect(result.outcomes.map(o => o.job_id)).toEqual(['J1', 'J2', 'J3']);
  });

  it('keeps a job id ending in a 12-hex segment from being stripped into a different job', async () => {
    const root = runsDir([
      '{"job":"RQ-X","phase":"MERGED","ts":"2026-11-01T00:00:00Z"}',
      '{"job":"RQ-X-deadbeefcafe","phase":"VERIFIED","ts":"2026-11-01T00:00:00Z"}',
    ].join('\n'));
    writeLaunchCosts(root, [
      // The bare unknown probe belongs to the hex-suffixed job id itself.
      launchCostRow('RQ-X-deadbeefcafe', 'unknown'),
      // A measured row for RQ-X strips its own attempt suffix.
      launchCostRow('RQ-X-0123456789ab', 'measured', { peakProcesses: 6, meanCpuPercentOneCore: 8, peakCpuPercentOneCore: 30 }),
    ]);
    const result = await readRouterOutcomes({ runsDir: root });
    const byId = new Map(result.outcomes.map(o => [o.job_id, o]));
    expect(byId.get('RQ-X')).toMatchObject({
      launch_cost_status: 'measured', launch_peak_processes: 6,
      launch_mean_cpu_pct: 8, launch_peak_cpu_pct: 30,
    });
    expect(byId.get('RQ-X-deadbeefcafe')).toMatchObject({
      launch_cost_status: 'unknown', launch_peak_processes: null,
    });
  });

  it('leaves the last appended row standing when several attempts recorded probes for one job', async () => {
    const root = runsDir('{"job":"J1","phase":"MERGED","ts":"2026-11-01T00:00:00Z"}\n');
    writeLaunchCosts(root, [
      launchCostRow('J1-aaaabbbbcccc', 'measured', { peakProcesses: 4, meanCpuPercentOneCore: 12.5, peakCpuPercentOneCore: 40 }),
      launchCostRow('J1-ddddeeeeffff', 'partial', { peakProcesses: 9, meanCpuPercentOneCore: 3, peakCpuPercentOneCore: 8 }),
    ]);
    const result = await readRouterOutcomes({ runsDir: root });
    expect(result.outcomes[0]).toMatchObject({
      launch_cost_status: 'partial', launch_peak_processes: 9,
      launch_mean_cpu_pct: 3, launch_peak_cpu_pct: 8,
    });
  });

  it('joins a repeated launch receipt appended after another attempt for the same job', async () => {
    const root = runsDir('{"job":"J1","phase":"MERGED","ts":"2026-11-01T00:00:00Z"}\n');
    writeLaunchCosts(root, [
      launchCostRow('J1-aaaabbbbcccc', 'partial'),
      launchCostRow('J1-ddddeeeeffff', 'unknown'),
      launchCostRow('J1-aaaabbbbcccc', 'measured', { peakProcesses: 6 }),
    ]);

    const result = await readRouterOutcomes({ runsDir: root });
    expect(result.outcomes[0]).toMatchObject({
      launch_cost_status: 'measured', launch_peak_processes: 6,
    });
  });

  it('keeps launch_cost fields null and reports launch_cost_state when the ledger is absent, refused or the jobs read failed', async () => {
    const missing = await readRouterOutcomes({ runsDir: runsDir('{"job":"J1","phase":"MERGED","ts":"2026-11-01T00:00:00Z"}\n') });
    expect(missing).toMatchObject({ state: 'read', launch_cost_state: 'missing', launch_cost_truncated: false });
    expect(missing.outcomes[0]).toMatchObject({
      launch_cost_status: null, launch_peak_processes: null,
      launch_mean_cpu_pct: null, launch_peak_cpu_pct: null,
    });

    const root = runsDir('{"job":"J1","phase":"MERGED","ts":"2026-11-01T00:00:00Z"}\n');
    const target = join(root, 'real-launch-cost.jsonl');
    writeFileSync(target, JSON.stringify(launchCostRow('J1-aaaabbbbcccc', 'measured')) + '\n');
    symlinkSync(target, launchCostsPath(root));
    const linked = await readRouterOutcomes({ runsDir: root });
    expect(linked).toMatchObject({ state: 'read', launch_cost_state: 'unreadable' });
    expect(linked.outcomes[0]).toMatchObject({ launch_cost_status: null, launch_peak_processes: null });

    // The launch-cost read still reports its health when the jobs ledger is missing.
    const noJobs = runsDir();
    writeLaunchCosts(noJobs, [launchCostRow('J1', 'measured')]);
    const withCosts = await readRouterOutcomes({ runsDir: noJobs });
    expect(withCosts).toMatchObject({ state: 'missing', launch_cost_state: 'read', launch_cost_truncated: false, outcomes: [] });
  });

  it('flags a cut launch-cost tail so joined evidence reads as newest-bytes coverage', async () => {
    const root = runsDir('{"job":"J1","phase":"MERGED","ts":"2026-11-01T00:00:00Z"}\n');
    writeFileSync(launchCostsPath(root), '');
    truncateSync(launchCostsPath(root), ROUTER_OUTCOME_LEDGER_LIMIT + 1);
    const result = await readRouterOutcomes({ runsDir: root });
    expect(result).toMatchObject({ state: 'read', launch_cost_state: 'read', launch_cost_truncated: true });
    expect(result.outcomes[0]).toMatchObject({ launch_cost_status: null, launch_peak_processes: null });
  });
});

describe('router outcome authority revert join', () => {
  /** Evidence rows in the authority ledger's index shape (structural subset). */
  const ev = (kind: string, landingId: string | null, revertsLandingId?: string | null): RouterOutcomeEvidenceRow =>
    revertsLandingId === undefined ? { kind, landingId } : { kind, landingId, revertsLandingId };

  const MERGE = 'ashlrai/phantom#42@abc123def456';
  const REVERT = 'ashlrai/phantom#43@fff000aaa111';

  it('resolves a revert:landed row to its merge landing\'s PR key', () => {
    const keys = authorityRevertedPrKeys([
      ev('merge:landed', MERGE),
      ev('merge:landed', 'ashlrai/phantom#7@000000000000'),
      ev('revert:landed', REVERT, MERGE),
      ev('post-merge:result', MERGE, null),
      ev('revert:failed', 'ashlrai/phantom#9@111111111111', null),
    ]);
    expect([...keys]).toEqual(['ashlrai/phantom#42']);
  });

  it('ignores malformed landing ids, missing targets and reverts of non-merge landings', () => {
    const keys = authorityRevertedPrKeys([
      ev('merge:landed', 'not-a-landing-id'),
      ev('merge:landed', null),
      ev('merge:landed', 'ashlrai/phantom#42'),        // no @sha suffix: unparseable
      ev('revert:landed', REVERT),                       // no revertsLandingId
      ev('revert:landed', REVERT, null),                 // explicit null target
      ev('revert:landed', REVERT, 'ashlrai/phantom#99@deadbeef0000'), // targets no merge row
      ev('revert:landed', REVERT, 'unparseable'),        // target never entered the merge map
      ev('post-merge:result', MERGE, MERGE),             // wrong kind carrying a target
    ]);
    expect(keys.size).toBe(0);
  });

  it('marks a job reverted through its unambiguous canonical PR claim only', () => {
    const keys = authorityRevertedPrKeys([ev('merge:landed', MERGE), ev('revert:landed', REVERT, MERGE)]);
    const fold = foldRouterOutcomes([
      '{"job":"J1","lane":"alpha","phase":"MERGED","pr_url":"https://github.com/ashlrai/phantom/pull/42","ts":"2026-11-01T00:00:00Z"}',
      '{"job":"J2","phase":"MERGED","pr_url":"https://github.com/ashlrai/phantom/pull/7"}',
      '{"job":"J3","phase":"MERGED","pr_url":"https://github.com/other/repo/pull/42"}',
      '{"job":"J1","pr_url":"https://github.com/ashlrai/phantom/pull/42/"}',
      '{"url":"https://github.com/AshlrAI/Phantom/pull/42","cost_usd":9}',
      '{"job":"J6","phase":"MERGED","pr_url":"https://github.com/ashlrai/phantom/pull/42?x=1"}',
      '{"job":"J7","phase":"MERGED","pr":"https://github.com/ashlrai/phantom/issues/42"}',
    ].join('\n'), { revertedPrKeys: keys });
    const byId = new Map(fold.outcomes.map(o => [o.job_id, o]));
    // Canonical claim (any url alias) + case-insensitive repo: marked.
    expect(byId.get('J1')).toMatchObject({ reverted: true, cost_usd: 9 });
    expect(fold.ambiguous_urls).toBe(0);
    expect(fold.unattached_rows).toBe(0);
    // Different PR, different repo, non-canonical or non-pull URL: untouched.
    for (const id of ['J2', 'J3', 'J6', 'J7']) expect(byId.get(id)?.reverted).toBeNull();
  });

  it('withholds PR evidence when different jobs claim aliases of the same PR', () => {
    const fold = foldRouterOutcomes([
      '{"job":"A","pr_url":"https://github.com/ashlrai/phantom/pull/42"}',
      '{"job":"B","pr_url":"https://github.com/AshlrAI/Phantom/pull/42/"}',
      '{"pr_url":"https://github.com/ashlrai/phantom/pull/42","phase":"MERGED"}',
    ].join('\n'), {
      revertedPrKeys: new Set(['ashlrai/phantom#42']),
      crossReviews: foldCrossReviews(JSON.stringify(crossReview(42, 'approve'))),
      mergeEvents: foldMergeEvents(JSON.stringify(mergeEvent(42, 'checks_passed'))),
    });
    expect(fold.ambiguous_urls).toBe(1);
    expect(fold.unattached_rows).toBe(1);
    expect(fold.outcomes).toHaveLength(2);
    for (const outcome of fold.outcomes) {
      expect(outcome).toMatchObject({
        merged: null, reverted: null, cross_review: null, merge_queue: null, ci_first_pass: null,
      });
    }
  });

  it('never marks through an ambiguous PR claim or a foreign row', () => {
    const keys = authorityRevertedPrKeys([ev('merge:landed', MERGE), ev('revert:landed', REVERT, MERGE)]);
    const fold = foldRouterOutcomes([
      '{"job":"A","phase":"MERGED","pr_url":"https://github.com/ashlrai/phantom/pull/42"}',
      '{"job":"B","phase":"MERGED","pr_url":"https://github.com/ashlrai/phantom/pull/42"}',
      '{"job":"C","phase":"MERGED"}',
      '{"job":"C","pr_url":"https://github.com/ashlrai/phantom/pull/42"}', // third claimant of the same URL
      '{"job":"D","phase":"MERGED","pr_url":"https://github.com/ashlrai/phantom/pull/43"}',
      '{"job":"D","pr_url":"https://github.com/ashlrai/phantom/pull/42"}',  // fourth claimant on a foreign row
    ].join('\n'), { revertedPrKeys: keys });
    const byId = new Map(fold.outcomes.map(o => [o.job_id, o]));
    // Four jobs claim pull/42, so none is marked — contested evidence stays unknown.
    for (const id of ['A', 'B', 'C', 'D']) expect(byId.get(id)?.reverted).toBeNull();
    expect(fold.ambiguous_urls).toBe(1);
  });

  it('authority revert evidence is sticky-true over reverted:false', () => {
    const keys = authorityRevertedPrKeys([
      ev('merge:landed', MERGE), ev('revert:landed', REVERT, MERGE),
      ev('merge:landed', 'ashlrai/phantom#7@000000000000'),
      ev('revert:landed', 'ashlrai/phantom#8@111111111111', 'ashlrai/phantom#7@000000000000'),
    ]);
    const fold = foldRouterOutcomes([
      '{"job":"J1","phase":"MERGED","pr_url":"https://github.com/ashlrai/phantom/pull/42"}',
      '{"job":"J1","reverted":false,"ts":"2026-11-03T00:00:00Z"}',
      '{"job":"J2","phase":"MERGED","reverted":false,"pr_url":"https://github.com/ashlrai/phantom/pull/7"}',
    ].join('\n'), { revertedPrKeys: keys });
    const byId = new Map(fold.outcomes.map(o => [o.job_id, o]));
    // A later reverted:false cannot undo the verified revert.
    expect(byId.get('J1')?.reverted).toBe(true);
    // Same row carries explicit false and the reverted claim: verified evidence wins.
    expect(byId.get('J2')?.reverted).toBe(true);
  });

  it('joins side-ledger reverts only to the standing merge PR', () => {
    const fold = foldRouterOutcomes([
      { job: 'replacement', phase: 'MERGED', pr_url: 'https://github.com/o/r/pull/2', ts: '2026-11-03T00:00:00Z' },
      { job: 'replacement', phase: 'MERGED', pr_url: 'https://github.com/o/r/pull/1', ts: '2026-11-02T00:00:00Z' },
      { job: 'legacy', pr_url: 'https://github.com/o/r/pull/3' },
      { job: 'legacy', phase: 'MERGED' },
      { job: 'ambiguous-legacy', pr_url: 'https://github.com/o/r/pull/4' },
      { job: 'ambiguous-legacy', pr_url: 'https://github.com/o/r/pull/5' },
      { job: 'ambiguous-legacy', phase: 'MERGED' },
      { job: 'closed', phase: 'CLOSED', pr_url: 'https://github.com/o/r/pull/6' },
      { job: 'open', phase: 'PUBLISHED', pr_url: 'https://github.com/o/r/pull/7' },
    ].map(row => JSON.stringify(row)).join('\n'), {
      revertedPrKeys: new Set(['o/r#1', 'o/r#3', 'o/r#4', 'o/r#6', 'o/r#7']),
    });
    expect(fold.outcomes.map(({ job_id, reverted }) => [job_id, reverted])).toEqual([
      ['replacement', null], ['legacy', true], ['ambiguous-legacy', null], ['closed', null], ['open', null],
    ]);
  });

  it('leaves reverted untouched when no join is supplied or the PR was never reverted', () => {
    const text = '{"job":"J1","phase":"MERGED","pr_url":"https://github.com/ashlrai/phantom/pull/42"}\n';
    // No option: pure jobs-ledger fold, reverted stays unknown.
    expect(foldRouterOutcomes(text).outcomes[0]?.reverted).toBeNull();
    // Empty key set: the join ran but found nothing.
    expect(foldRouterOutcomes(text, { revertedPrKeys: new Set() }).outcomes[0]?.reverted).toBeNull();
    // A different PR's revert does not leak onto this job.
    const other = authorityRevertedPrKeys([ev('merge:landed', 'ashlrai/phantom#7@000000000000'), ev('revert:landed', 'ashlrai/phantom#8@111111111111', 'ashlrai/phantom#7@000000000000')]);
    expect(foldRouterOutcomes(text, { revertedPrKeys: other }).outcomes[0]?.reverted).toBeNull();
  });

  it('readRouterOutcomes joins injected authority evidence and honours null', async () => {
    const root = runsDir('{"job":"J1","phase":"MERGED","pr_url":"https://github.com/ashlrai/phantom/pull/42"}\n{"job":"J2","phase":"MERGED"}\n');
    const evidence = [ev('merge:landed', MERGE), ev('revert:landed', REVERT, MERGE)];
    const joined = await readRouterOutcomes({ runsDir: root, authorityEvidence: evidence });
    const byId = new Map(joined.outcomes.map(o => [o.job_id, o]));
    expect(byId.get('J1')?.reverted).toBe(true);
    expect(byId.get('J2')?.reverted).toBeNull();

    // null skips the join entirely: same ledger, no authority mark.
    const skipped = await readRouterOutcomes({ runsDir: root, authorityEvidence: null });
    expect(skipped.outcomes.find(o => o.job_id === 'J1')?.reverted).toBeNull();
  });
});

describe('router outcome scan-ledger revert join', () => {
  const scanRecord = (over: Partial<RevertOutcomeRecord> = {}): RevertOutcomeRecord => ({
    repository: 'ashlrai/phantom', number: 42, pr: 'ashlrai/phantom#42',
    mergeSha: 'a'.repeat(40), mergedAt: '2026-11-01T00:00:00.000Z',
    revertedBy: 'c'.repeat(40), revertedAt: '2026-11-01T10:00:00.000Z',
    revertLatencyMs: 10 * 3_600_000, relandedBy: null, ...over,
  });

  /** ashlarDir root carrying improve/revert-outcomes.jsonl via the real writer. */
  function ashlarWithLedger(records: RevertOutcomeRecord[]): string {
    const root = ashlarDir();
    const path = revertOutcomesLedgerPath(root);
    mkdirSync(join(root, 'improve'), { recursive: true });
    recordRevertOutcomes(records, { path });
    return root;
  }

  const jobsLedger = '{"job":"J1","phase":"MERGED","pr_url":"https://github.com/ashlrai/phantom/pull/42","ts":"2026-11-01T00:00:00Z"}\n'
    + '{"job":"J2","phase":"MERGED","pr_url":"https://github.com/ashlrai/phantom/pull/7"}\n';

  it('marks an outcome reverted through its unambiguous PR claim from a recorded scan detection', async () => {
    const root = runsDir(jobsLedger);
    const ashlar = ashlarWithLedger([scanRecord()]);
    const read = await readRouterOutcomes({ runsDir: root, ashlarDir: ashlar, authorityEvidence: [] });
    expect(read.revert_ledger_state).toBe('read');
    const byId = new Map(read.outcomes.map(o => [o.job_id, o]));
    expect(byId.get('J1')?.reverted).toBe(true);
    expect(byId.get('J2')?.reverted).toBeNull();
  });

  it('unions with authority keys and honours reland clearing newest-record-wins', async () => {
    const root = runsDir(jobsLedger);
    // A reland record after the revert clears the key: J1 must not mark.
    const relanded = ashlarWithLedger([scanRecord(), scanRecord({ relandedBy: 'd'.repeat(40) })]);
    const cleared = await readRouterOutcomes({ runsDir: root, ashlarDir: relanded, authorityEvidence: [] });
    expect(cleared.revert_ledger_state).toBe('read');
    expect(cleared.outcomes.find(o => o.job_id === 'J1')?.reverted).toBeNull();

    // Authority evidence for a different PR still joins alongside scan keys.
    const ev = (kind: string, landingId: string | null, revertsLandingId?: string | null): RouterOutcomeEvidenceRow =>
      revertsLandingId === undefined ? { kind, landingId } : { kind, landingId, revertsLandingId };
    const authority = [ev('merge:landed', 'ashlrai/phantom#7@000000000000'), ev('revert:landed', 'ashlrai/phantom#8@111111111111', 'ashlrai/phantom#7@000000000000')];
    const both = await readRouterOutcomes({ runsDir: root, ashlarDir: ashlarWithLedger([scanRecord()]), authorityEvidence: authority });
    const byId = new Map(both.outcomes.map(o => [o.job_id, o]));
    expect(byId.get('J1')?.reverted).toBe(true);   // scan ledger
    expect(byId.get('J2')?.reverted).toBe(true);   // authority ledger
  });

  it('reports ledger health and contributes no keys when missing, corrupt or oversized', async () => {
    const root = runsDir(jobsLedger);
    const missing = await readRouterOutcomes({ runsDir: root, ashlarDir: ashlarDir(), authorityEvidence: [] });
    expect(missing.revert_ledger_state).toBe('missing');
    expect(missing.outcomes.find(o => o.job_id === 'J1')?.reverted).toBeNull();

    const corrupt = ashlarDir();
    mkdirSync(join(corrupt, 'improve'), { recursive: true });
    writeFileSync(revertOutcomesLedgerPath(corrupt), 'not json\n');
    const bad = await readRouterOutcomes({ runsDir: root, ashlarDir: corrupt, authorityEvidence: [] });
    expect(bad.revert_ledger_state).toBe('unreadable');
    expect(bad.outcomes.find(o => o.job_id === 'J1')?.reverted).toBeNull();

    const huge = ashlarDir();
    mkdirSync(join(huge, 'improve'), { recursive: true });
    writeFileSync(revertOutcomesLedgerPath(huge), 'x'.repeat(8 * 1024 * 1024 + 1));
    const big = await readRouterOutcomes({ runsDir: root, ashlarDir: huge, authorityEvidence: [] });
    expect(big.revert_ledger_state).toBe('too-large');
    expect(big.outcomes.find(o => o.job_id === 'J1')?.reverted).toBeNull();
  });
});

describe('router outcome session-handoff advisory fold', () => {
  /** A session-failover.v1 advisory row in the producer's own shape (contrib/mac/session_handoff.py).
   *  dispatchd appends rate-limit verdicts to jobs.jsonl and quota-exhausted
   *  verdicts to work-market.jsonl; fixtures here exercise the fold's full
   *  closed vocabulary on the jobs ledger. */
  const advisory = (job: string, trigger: string, extra: Record<string, unknown> = {}): object => ({
    schema: 'session-failover.v1', event: 'session_handoff_advisory', advisory: true,
    job, lane: 'alpha', trigger, target: null, packet: `handoffs/${job}.jsonl`,
    next: 'validate-packet-repo-capabilities-and-claim', dispatched: false, ...extra,
  });

  it('folds both trigger verdicts with their lane and target', () => {
    const fold = foldRouterOutcomes([
      '{"job":"J1","lane":"alpha","phase":"MERGED","ts":"2026-11-01T00:00:00Z"}',
      JSON.stringify(advisory('J1', 'rate-limit', { lane: 'codex-personal' })),
      '{"job":"J2","lane":"alpha","phase":"VERIFIED","ts":"2026-11-01T00:00:00Z"}',
      JSON.stringify(advisory('J2', 'quota-exhausted', { lane: 'alpha', target: 'devin' })),
      '{"job":"J3","phase":"MERGED"}',
    ].join('\n'));
    const byId = new Map(fold.outcomes.map(o => [o.job_id, o]));
    expect(byId.get('J1')).toMatchObject({
      handoff_trigger: 'rate-limit', handoff_lane: 'codex-personal', handoff_target: null,
    });
    expect(byId.get('J2')).toMatchObject({
      handoff_trigger: 'quota-exhausted', handoff_lane: 'alpha', handoff_target: 'devin',
    });
    // J3 has no advisory row: unknown stays null, never a guessed verdict.
    expect(byId.get('J3')).toMatchObject({ handoff_trigger: null, handoff_lane: null, handoff_target: null });
  });

  it('lets the newest recognized advisory replace the triple and never clears it on other events', () => {
    const fold = foldRouterOutcomes([
      '{"job":"J1","phase":"MERGED"}',
      JSON.stringify(advisory('J1', 'rate-limit', { lane: 'alpha' })),
      // A later launch/finish lifecycle row is not a launch decision about
      // the advisory — it leaves the recorded wall verdict standing.
      '{"job":"J1","event":"finish","exit_code":1,"ts":"2026-11-02T00:00:00Z"}',
      JSON.stringify(advisory('J1', 'quota-exhausted', { lane: 'beta', target: 'gamma' })),
    ].join('\n'));
    expect(fold.outcomes[0]).toMatchObject({
      handoff_trigger: 'quota-exhausted', handoff_lane: 'beta', handoff_target: 'gamma',
    });
  });

  it('skips rows outside the closed schema/event/trigger vocabulary without touching the verdict', () => {
    const fold = foldRouterOutcomes([
      '{"job":"J1","phase":"MERGED"}',
      JSON.stringify(advisory('J1', 'rate-limit', { lane: 'alpha' })),
      // Wrong schema, wrong event, and a trigger outside the producer's
      // vocabulary are all unrecognized — the standing verdict survives.
      JSON.stringify(advisory('J1', 'rate-limit', { schema: 'session-failover.v2' })),
      JSON.stringify({ ...advisory('J1', 'rate-limit'), event: 'session_handoff' }),
      JSON.stringify(advisory('J1', 'provider-error')),
      // Trigger matching is case-sensitive like the producer's own labels.
      JSON.stringify(advisory('J1', 'Rate-Limit')),
      // An event-alias row (type instead of event) still counts.
      JSON.stringify({ ...advisory('J2', 'rate-limit'), event: undefined, type: 'session_handoff_advisory' }),
      '{"job":"J2","phase":"VERIFIED"}',
    ].join('\n'));
    const byId = new Map(fold.outcomes.map(o => [o.job_id, o]));
    expect(byId.get('J1')).toMatchObject({ handoff_trigger: 'rate-limit', handoff_lane: 'alpha' });
    expect(byId.get('J2')).toMatchObject({ handoff_trigger: 'rate-limit' });
  });

  it('drops malformed lane and target to null while keeping the recorded trigger', () => {
    const fold = foldRouterOutcomes([
      '{"job":"J1","phase":"MERGED"}',
      // Lane with a space and a 65-char target both fail the bounded
      // lane-id shape; the trigger is still the fleet's recorded verdict.
      JSON.stringify(advisory('J1', 'quota-exhausted', {
        lane: 'not a lane!', target: `t${'x'.repeat(64)}`,
      })),
      // Non-string lane/target values are equally unrecorded.
      '{"job":"J2","phase":"MERGED"}',
      JSON.stringify(advisory('J2', 'rate-limit', { lane: 42, target: ['devin'] })),
    ].join('\n'));
    const byId = new Map(fold.outcomes.map(o => [o.job_id, o]));
    expect(byId.get('J1')).toMatchObject({ handoff_trigger: 'quota-exhausted', handoff_lane: null, handoff_target: null });
    expect(byId.get('J2')).toMatchObject({ handoff_trigger: 'rate-limit', handoff_lane: null, handoff_target: null });
  });

  it('lets an advisory-only job stand as its own outcome and tolerates malformed rows', () => {
    // The advisory lives in the primary jobs ledger, so its job is a real
    // ledger job: the outcome exists with merged unknown and the wall
    // verdict attached — the same standing every lifecycle row gets.
    const fold = foldRouterOutcomes([
      JSON.stringify(advisory('J-ONLY', 'rate-limit', { lane: 'alpha' })),
      '{"job":"J1","phase":"MERGED"}',
      'not json',
      '[1,2]',
    ].join('\n'));
    const byId = new Map(fold.outcomes.map(o => [o.job_id, o]));
    expect(byId.get('J-ONLY')).toMatchObject({
      merged: null, handoff_trigger: 'rate-limit', handoff_lane: 'alpha', handoff_target: null,
    });
    expect(byId.get('J1')?.handoff_trigger).toBeNull();
    expect(fold.malformed_rows).toBe(2);
  });
});

describe('router outcome provider-wall hold fold', () => {
  /** An autobackoff_hold row in the producer's own shape (contrib/mac/dispatchd.py):
   *  the usage/quota scanner's hold carries pattern/until/src and the auth
   *  scanner's streak hold adds auth_failures. */
  const hold = (job: string, pattern: string, extra: Record<string, unknown> = {}): object => ({
    event: 'autobackoff_hold', lane: 'alpha', job, pattern,
    until: '2026-11-02T00:00:00-05:00', src: 'cli_line', ...extra,
  });

  it('folds usage-limit and auth-failure holds with their lane', () => {
    const fold = foldRouterOutcomes([
      '{"job":"J1","lane":"alpha","phase":"MERGED","ts":"2026-11-01T00:00:00Z"}',
      JSON.stringify(hold('J1', 'codex_usage_limit')),
      '{"job":"J2","lane":"claude","phase":"VERIFIED","ts":"2026-11-01T00:00:00Z"}',
      JSON.stringify(hold('J2', 'claude_auth_401', { lane: 'claude', src: 'default', auth_failures: 3 })),
      '{"job":"J3","phase":"MERGED"}',
    ].join('\n'));
    const byId = new Map(fold.outcomes.map(o => [o.job_id, o]));
    expect(byId.get('J1')).toMatchObject({
      provider_wall_trigger: 'usage-limit', provider_wall_pattern: 'codex_usage_limit', provider_wall_lane: 'alpha',
    });
    expect(byId.get('J2')).toMatchObject({
      provider_wall_trigger: 'auth-failure', provider_wall_pattern: 'claude_auth_401', provider_wall_lane: 'claude',
    });
    // J3 has no hold row: unknown stays null, never a guessed verdict.
    expect(byId.get('J3')).toMatchObject({
      provider_wall_trigger: null, provider_wall_pattern: null, provider_wall_lane: null,
    });
  });

  it('derives the trigger from the producer tables and the auth_failures marker', () => {
    const fold = foldRouterOutcomes([
      '{"job":"J1","phase":"MERGED"}',
      // A devin weekly-quota id sits in the usage table.
      JSON.stringify(hold('J1', 'devin_weekly_quota')),
      '{"job":"J2","phase":"MERGED"}',
      // auth_failures marks the auth scanner's streak holds outright —
      // even a pattern id outside both mirrored tables.
      JSON.stringify(hold('J2', 'some_new_pattern', { auth_failures: 2 })),
      '{"job":"J3","phase":"MERGED"}',
      // An unrecognized pattern still records the bounded hold with
      // trigger null rather than guessing a family.
      JSON.stringify(hold('J3', 'some_new_pattern')),
      // claude_oauth_expired sits in the producer's usage table.
      '{"job":"J4","phase":"MERGED"}',
      JSON.stringify(hold('J4', 'claude_oauth_expired')),
    ].join('\n'));
    const byId = new Map(fold.outcomes.map(o => [o.job_id, o]));
    expect(byId.get('J1')).toMatchObject({ provider_wall_trigger: 'usage-limit', provider_wall_pattern: 'devin_weekly_quota' });
    expect(byId.get('J2')).toMatchObject({ provider_wall_trigger: 'auth-failure', provider_wall_pattern: 'some_new_pattern' });
    expect(byId.get('J3')).toMatchObject({ provider_wall_trigger: null, provider_wall_pattern: 'some_new_pattern' });
    expect(byId.get('J4')).toMatchObject({ provider_wall_trigger: 'usage-limit', provider_wall_pattern: 'claude_oauth_expired' });
  });

  it('lets the newest recognized hold replace the triple and ignores skip receipts and other events', () => {
    const fold = foldRouterOutcomes([
      '{"job":"J1","phase":"MERGED"}',
      JSON.stringify(hold('J1', 'codex_usage_limit', { lane: 'alpha' })),
      // The helper-unavailable skip receipts record no verdict — a scan
      // that could not classify the run never holds and never joins.
      JSON.stringify({ event: 'autobackoff_skip', lane: 'alpha', job: 'J1', pattern: 'codex_usage_limit', src: 'helper_unavailable' }),
      JSON.stringify({ event: 'authbackoff_skip', lane: 'alpha', job: 'J1', pattern: 'claude_auth_401', src: 'helper_unavailable' }),
      // A finish row is attempt evidence but not a hold verdict — the
      // standing hold survives it.
      '{"job":"J1","event":"finish","exit_code":1,"ts":"2026-11-02T00:00:00Z"}',
      JSON.stringify(hold('J1', 'claude_auth_401', { lane: 'beta', auth_failures: 2, src: 'default' })),
    ].join('\n'));
    expect(fold.outcomes[0]).toMatchObject({
      provider_wall_trigger: 'auth-failure', provider_wall_pattern: 'claude_auth_401', provider_wall_lane: 'beta',
    });
  });

  it('skips rows outside the event/pattern bounds without touching the verdict', () => {
    const fold = foldRouterOutcomes([
      '{"job":"J1","phase":"MERGED"}',
      JSON.stringify(hold('J1', 'codex_usage_limit', { lane: 'alpha' })),
      // A different event name, a pattern with spaces and an overlong
      // pattern are all unrecognized — the standing verdict survives.
      JSON.stringify({ ...hold('J1', 'codex_usage_limit'), event: 'autobackoff' }),
      JSON.stringify(hold('J1', 'not a pattern!')),
      JSON.stringify(hold('J1', 'x'.repeat(200))),
      // An event-alias row (type instead of event) still counts.
      JSON.stringify({ ...hold('J2', 'devin_usage_limit'), event: undefined, type: 'autobackoff_hold' }),
      '{"job":"J2","phase":"VERIFIED"}',
    ].join('\n'));
    const byId = new Map(fold.outcomes.map(o => [o.job_id, o]));
    expect(byId.get('J1')).toMatchObject({
      provider_wall_trigger: 'usage-limit', provider_wall_pattern: 'codex_usage_limit', provider_wall_lane: 'alpha',
    });
    expect(byId.get('J2')).toMatchObject({ provider_wall_trigger: 'usage-limit', provider_wall_pattern: 'devin_usage_limit' });
  });

  it('drops a malformed lane to null while keeping the recorded hold', () => {
    const fold = foldRouterOutcomes([
      '{"job":"J1","phase":"MERGED"}',
      // A lane with a space fails the bounded lane-id shape; the hold's
      // pattern and trigger still join.
      JSON.stringify(hold('J1', 'codex_usage_limit', { lane: 'not a lane!' })),
      // A non-string lane is equally unrecorded.
      '{"job":"J2","phase":"MERGED"}',
      JSON.stringify(hold('J2', 'devin_acu_exhausted', { lane: 42 })),
    ].join('\n'));
    const byId = new Map(fold.outcomes.map(o => [o.job_id, o]));
    expect(byId.get('J1')).toMatchObject({
      provider_wall_trigger: 'usage-limit', provider_wall_pattern: 'codex_usage_limit', provider_wall_lane: null,
    });
    expect(byId.get('J2')).toMatchObject({
      provider_wall_trigger: 'usage-limit', provider_wall_pattern: 'devin_acu_exhausted', provider_wall_lane: null,
    });
  });

  it('lets a hold-only job stand as its own outcome and tolerates malformed rows', () => {
    // The hold lives in the primary jobs ledger, so its job is a real
    // ledger job: the outcome exists with merged unknown and the wall
    // verdict attached — the same standing every lifecycle row gets.
    const fold = foldRouterOutcomes([
      JSON.stringify(hold('J-ONLY', 'codex_auth_failure', { auth_failures: 2 })),
      '{"job":"J1","phase":"MERGED"}',
      'not json',
      '[1,2]',
    ].join('\n'));
    const byId = new Map(fold.outcomes.map(o => [o.job_id, o]));
    expect(byId.get('J-ONLY')).toMatchObject({
      merged: null, provider_wall_trigger: 'auth-failure',
      provider_wall_pattern: 'codex_auth_failure', provider_wall_lane: 'alpha',
    });
    expect(byId.get('J1')?.provider_wall_trigger).toBeNull();
    expect(fold.malformed_rows).toBe(2);
  });
});

describe('router outcome slot-throttle (pool) fold', () => {
  /** A pool row in the producer's own shape (contrib/mac/dispatchd.py):
   *  the per-tick ratelimited() scan appends {event:'pool', lane, job,
   *  kind, mem_free_pct, swap_gb} once per (job, class). */
  const pool = (job: string, kind: string, extra: Record<string, unknown> = {}): object => ({
    event: 'pool', lane: 'alpha', job, kind,
    mem_free_pct: 42.5, swap_gb: 3.25, ...extra,
  });

  it('folds pool receipts with their throttle class and host memory readings', () => {
    const fold = foldRouterOutcomes([
      '{"job":"J1","lane":"alpha","phase":"MERGED","ts":"2026-11-01T00:00:00Z"}',
      JSON.stringify(pool('J1', 'rate_limit')),
      '{"job":"J2","lane":"claude","phase":"VERIFIED","ts":"2026-11-01T00:00:00Z"}',
      JSON.stringify(pool('J2', 'credits_exhausted', { lane: 'claude', mem_free_pct: 12, swap_gb: 40 })),
      '{"job":"J3","phase":"MERGED"}',
    ].join('\n'));
    const byId = new Map(fold.outcomes.map(o => [o.job_id, o]));
    expect(byId.get('J1')).toMatchObject({
      pool_kind: 'rate_limit', pool_mem_free_pct: 42.5, pool_swap_gb: 3.25,
    });
    expect(byId.get('J2')).toMatchObject({
      pool_kind: 'credits_exhausted', pool_mem_free_pct: 12, pool_swap_gb: 40,
    });
    // J3 has no pool row: unknown stays null, never a guessed verdict.
    expect(byId.get('J3')).toMatchObject({
      pool_kind: null, pool_mem_free_pct: null, pool_swap_gb: null,
    });
  });

  it('accepts every class in the producer CLS vocabulary', () => {
    const fold = foldRouterOutcomes([
      '{"job":"J1","phase":"MERGED"}', JSON.stringify(pool('J1', 'credits_exhausted')),
      '{"job":"J2","phase":"MERGED"}', JSON.stringify(pool('J2', 'usage_limit')),
      '{"job":"J3","phase":"MERGED"}', JSON.stringify(pool('J3', 'model_capacity')),
      '{"job":"J4","phase":"MERGED"}', JSON.stringify(pool('J4', 'rate_limit')),
    ].join('\n'));
    const byId = new Map(fold.outcomes.map(o => [o.job_id, o]));
    for (const [id, kind] of [['J1', 'credits_exhausted'], ['J2', 'usage_limit'], ['J3', 'model_capacity'], ['J4', 'rate_limit']] as const) {
      expect(byId.get(id)?.pool_kind).toBe(kind);
    }
  });

  it('lets the newest recognized pool row replace the triple and ignores other events', () => {
    const fold = foldRouterOutcomes([
      '{"job":"J1","phase":"MERGED"}',
      JSON.stringify(pool('J1', 'rate_limit', { mem_free_pct: 50, swap_gb: 1 })),
      // A finish row is attempt evidence but not a throttle verdict —
      // the standing detection survives it.
      '{"job":"J1","event":"finish","exit_code":0,"ts":"2026-11-02T00:00:00Z"}',
      JSON.stringify(pool('J1', 'usage_limit', { mem_free_pct: 8, swap_gb: 22 })),
      // A different event name never touches the triple.
      JSON.stringify({ event: 'throttle', lane: 'alpha', job: 'J1', kind: 'rate_limit' }),
    ].join('\n'));
    expect(fold.outcomes[0]).toMatchObject({
      pool_kind: 'usage_limit', pool_mem_free_pct: 8, pool_swap_gb: 22,
    });
  });

  it('skips rows outside the event/kind bounds without touching the verdict', () => {
    const fold = foldRouterOutcomes([
      '{"job":"J1","phase":"MERGED"}',
      JSON.stringify(pool('J1', 'rate_limit', { lane: 'alpha' })),
      // A different event name, a kind outside the CLS vocabulary and
      // an overlong kind are all unrecognized — the standing verdict
      // survives.
      JSON.stringify({ ...pool('J1', 'rate_limit'), event: 'throttled' }),
      JSON.stringify(pool('J1', 'not_a_class')),
      JSON.stringify(pool('J1', 'x'.repeat(200))),
      // An event-alias row (type instead of event) still counts.
      JSON.stringify({ ...pool('J2', 'model_capacity'), event: undefined, type: 'pool' }),
      '{"job":"J2","phase":"VERIFIED"}',
    ].join('\n'));
    const byId = new Map(fold.outcomes.map(o => [o.job_id, o]));
    expect(byId.get('J1')).toMatchObject({
      pool_kind: 'rate_limit', pool_mem_free_pct: 42.5, pool_swap_gb: 3.25,
    });
    expect(byId.get('J2')).toMatchObject({ pool_kind: 'model_capacity' });
  });

  it('drops malformed memory readings to null while keeping the recorded class', () => {
    const fold = foldRouterOutcomes([
      '{"job":"J1","phase":"MERGED"}',
      // mem_free_pct outside [0,100], a string swap_gb and a negative
      // swap figure are all unrecorded — the class still joins.
      JSON.stringify(pool('J1', 'rate_limit', { mem_free_pct: 140, swap_gb: 'lots' })),
      '{"job":"J2","phase":"MERGED"}',
      JSON.stringify(pool('J2', 'usage_limit', { mem_free_pct: -5, swap_gb: -1 })),
      // Missing readings join as null, never zero.
      '{"job":"J3","phase":"MERGED"}',
      JSON.stringify({ event: 'pool', lane: 'alpha', job: 'J3', kind: 'rate_limit' }),
    ].join('\n'));
    const byId = new Map(fold.outcomes.map(o => [o.job_id, o]));
    expect(byId.get('J1')).toMatchObject({
      pool_kind: 'rate_limit', pool_mem_free_pct: null, pool_swap_gb: null,
    });
    expect(byId.get('J2')).toMatchObject({
      pool_kind: 'usage_limit', pool_mem_free_pct: null, pool_swap_gb: null,
    });
    expect(byId.get('J3')).toMatchObject({
      pool_kind: 'rate_limit', pool_mem_free_pct: null, pool_swap_gb: null,
    });
  });

  it('lets a pool-only job stand as its own outcome and tolerates malformed rows', () => {
    // The receipt lives in the primary jobs ledger, so its job is a
    // real ledger job: the outcome exists with merged unknown and the
    // throttle detection attached — the same standing every lifecycle
    // row gets.
    const fold = foldRouterOutcomes([
      JSON.stringify(pool('J-ONLY', 'credits_exhausted', { mem_free_pct: 30, swap_gb: 0 })),
      '{"job":"J1","phase":"MERGED"}',
      'not json',
      '[1,2]',
    ].join('\n'));
    const byId = new Map(fold.outcomes.map(o => [o.job_id, o]));
    expect(byId.get('J-ONLY')).toMatchObject({
      merged: null, pool_kind: 'credits_exhausted',
      pool_mem_free_pct: 30, pool_swap_gb: 0,
    });
    expect(byId.get('J1')?.pool_kind).toBeNull();
    expect(fold.malformed_rows).toBe(2);
  });
});
