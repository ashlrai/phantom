import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  authorityRevertedPrKeys,
  foldEmptyTags,
  foldRouteDecisionWorkClasses,
  foldRouteDecisions,
  foldRouterOutcomes,
  foldSpendCosts,
  readLedgerFile,
  readLedgerTail,
  readRouterOutcomes,
  ROUTER_OUTCOME_LEDGER_LIMIT,
  type RouterOutcomeEvidenceRow,
} from '../src/core/router/outcomes.js';

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
      schema: 'router.outcome.v1', job_id: 'U1', lane: null, model: null, tier: null, work_class: null,
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
      market_lane: null, market_preferred: null, market_override: null, market_reasons: null,
      market_rejected: null,
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
      // P9: batch-session infrastructure rows never mint publish evidence.
      '{"job":"RQ-BATCH-p9","event":"finish","ts":"2026-11-01T10:00:00Z"}',
      '{"job":"RQ-BATCH-p9","event":"publish","ts":"2026-11-01T10:10:00Z"}',
      // P10: an eventless PUBLISHED phase row is the publish claim itself.
      '{"job":"P10","event":"finish","ts":"2026-11-01T10:00:00Z"}',
      '{"job":"P10","outcome":"PUBLISHED","ts":"2026-11-01T10:15:00Z"}',
      // P11: boundary rows without a readable stamp cannot pair.
      '{"job":"P11","event":"finish"}',
      '{"job":"P11","event":"publish","ts":"not a date"}',
    ].join('\n'));
    const byId = new Map(fold.outcomes.map(o => [o.job_id, o]));
    expect(byId.get('P1')).toMatchObject({ merged: true, publish_wait_s: 1200 });
    expect(byId.get('P2')).toMatchObject({ merged: false, publish_wait_s: 300 });
    expect(byId.get('P7')).toMatchObject({ publish_wait_s: 1800 });
    expect(byId.get('P8')).toMatchObject({ merged: true, publish_wait_s: 1200 });
    expect(byId.get('P10')).toMatchObject({ publish_wait_s: 900 });
    for (const id of ['P3', 'P4', 'P5', 'P6', 'P11']) expect(byId.get(id)?.publish_wait_s).toBeNull();
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
      // verdict the same way (the paired DONE-NOOP outcome row never
      // touches it either).
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
    expect(byId.get('D6')).toMatchObject({ deferred: false, defer_reason: null, defer_repeat_of: null });
    expect(byId.get('D7')).toMatchObject({ deferred: false, defer_reason: null, defer_repeat_of: null, skipped: true, skip_reason: 'prompt_empty_same_base_24h' });
    expect(byId.get('D8')).toMatchObject({ deferred: false, defer_reason: null, defer_repeat_of: null });
    // Malformed labels and covers join null while the verdict stands; the
    // unrecognized recut action leaves it untouched.
    expect(byId.get('D9')).toMatchObject({ deferred: true, defer_reason: null, defer_repeat_of: null });
    expect(byId.get('D10')).toMatchObject({ deferred: true, defer_reason: 'duplicate-request', defer_repeat_of: 'RQ-OWNER-10', empty: true });
    expect(byId.get('D11')).toMatchObject({ deferred: true, defer_reason: 'recut-in-flight', defer_repeat_of: 'RQ-RECUT-11' });
    expect(byId.get('D12')).toMatchObject({ deferred: null, defer_reason: null, defer_repeat_of: null });
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
      '{"job":"J3","model":"m"}',
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
    // Calls with no reported cost stay unknown, never zero; spend rows for
    // jobs outside the jobs window never create outcomes.
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

  it('flags a cut spend tail so joined costs read as lower bounds', async () => {
    const root = runsDir('{"job":"J1","phase":"MERGED"}\n');
    writeSpend(root, '');
    // Sparse file past the bound: the retained window holds no whole line.
    truncateSync(spendPath(root), ROUTER_OUTCOME_LEDGER_LIMIT + 1);
    const result = await readRouterOutcomes({ runsDir: root });
    expect(result).toMatchObject({ state: 'read', spend_state: 'read', spend_truncated: true });
    expect(result.outcomes[0]?.cost_usd).toBeNull();
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
      JSON.stringify({ schema: 'work-market.v1', event: 'route_decision', job: 'J3', ts: 100 }), // no work_class
      JSON.stringify(decision('J4', 'bad class!', 100)),
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
      decision('J-UNDECIDED', 'bulk', 100), // no jobs outcome: never creates one
    ]);
    const result = await readRouterOutcomes({ runsDir: root });
    expect(result).toMatchObject({ state: 'read', market_state: 'read', market_truncated: false });
    const byId = new Map(result.outcomes.map(o => [o.job_id, o]));
    expect(byId.get('J1')?.work_class).toBe('bulk');
    expect(byId.get('J2')?.work_class).toBe('docs');
    expect(byId.get('J3')?.work_class).toBe('judgment');
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
      '{"job":"J4","phase":"MERGED","pr_url":"https://github.com/ashlrai/phantom/pull/42/"}',
      '{"job":"J5","phase":"MERGED","url":"https://github.com/AshlrAI/Phantom/pull/42"}',
      '{"job":"J6","phase":"MERGED","pr_url":"https://github.com/ashlrai/phantom/pull/42?x=1"}',
      '{"job":"J7","phase":"MERGED","pr":"https://github.com/ashlrai/phantom/issues/42"}',
    ].join('\n'), { revertedPrKeys: keys });
    const byId = new Map(fold.outcomes.map(o => [o.job_id, o]));
    // Canonical claim (any url alias) + case-insensitive repo: marked.
    expect(byId.get('J1')?.reverted).toBe(true);
    expect(byId.get('J4')?.reverted).toBe(true);
    expect(byId.get('J5')?.reverted).toBe(true);
    // Different PR, different repo, non-canonical or non-pull URL: untouched.
    for (const id of ['J2', 'J3', 'J6', 'J7']) expect(byId.get(id)?.reverted).toBeNull();
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
