/**
 * Learned seat evidence: the fleet's own outcome record becomes the seat
 * router's pooled penalty — computed from the same bounded ledgers
 * `phm fleet outcomes` reads, cached for the route call rate, and
 * fail-closed to an unchanged ranking when evidence is absent.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { SeatCapacity } from '../src/core/routing/headroom.js';
import {
  computeLearnedSeatEvidence,
  LEARNED_SEAT_EVIDENCE_TTL_MS,
  learnedSeatRouteEvidence,
  resetLearnedSeatEvidenceCacheForTests,
} from '../src/core/routing/learned-seat-evidence.js';
import {
  learnFleetOutcomes,
  learnedFleetSeatPenalty,
  learnedSeatPenalty,
} from '../src/core/routing/outcome-learning.js';
import { defaultBudgetPolicy } from '../src/core/routing/policy.js';
import { routeSeat } from '../src/core/routing/router.js';

const NOW = Date.parse('2026-11-02T00:00:00.000Z');

function launch(job: string, lane: string, model: string, ts: string, tier = 'work', repo = 'phantom'): string {
  return JSON.stringify({ event: 'launch', job, repo, lane, tier, model, ts });
}
function finish(job: string, lane: string, tokens: number): string {
  return JSON.stringify({ event: 'finish', job, lane, tokens_total: tokens, wall_s: 600 });
}
function merged(job: string, pr: number, mergedAt: string): string {
  return JSON.stringify({
    event: 'publish', source: 'metrics-outcomes-reconciler', jobId: job,
    prUrl: `https://github.com/ashlrai/phantom/pull/${pr}`, outcome: 'MERGED', mergedAt, ts: mergedAt,
  });
}
function closed(job: string, pr: number, closedAt: string): string {
  return JSON.stringify({
    event: 'publish', source: 'metrics-outcomes-reconciler', jobId: job,
    prUrl: `https://github.com/ashlrai/phantom/pull/${pr}`, outcome: 'CLOSED', closedAt, ts: closedAt,
  });
}

/**
 * devin ships cheaply (two merges at 500 tokens each); codex-cmp burns
 * without shipping (two closed jobs at 5000 tokens each). A grok-build job
 * outside the work/phantom cell proves pooling ignores jobType and repo.
 */
const LEDGER = [
  launch('J-D1', 'devin', 'swe-2-max', '2026-11-01T00:00:00+00:00'),
  finish('J-D1', 'devin', 500),
  merged('J-D1', 1, '2026-11-01T01:00:00+00:00'),
  launch('J-D2', 'devin', 'swe-2-max', '2026-11-01T02:00:00+00:00'),
  finish('J-D2', 'devin', 500),
  merged('J-D2', 2, '2026-11-01T03:00:00+00:00'),
  launch('J-C1', 'codex-cmp', 'gpt-5.4', '2026-11-01T00:00:00+00:00'),
  finish('J-C1', 'codex-cmp', 5000),
  closed('J-C1', 3, '2026-11-01T01:00:00+00:00'),
  launch('J-C2', 'codex-cmp', 'gpt-5.4', '2026-11-01T02:00:00+00:00'),
  finish('J-C2', 'codex-cmp', 5000),
  closed('J-C2', 4, '2026-11-01T03:00:00+00:00'),
  launch('J-G1', 'grok-build', 'grok', '2026-11-01T00:00:00+00:00', 'review', 'elsewhere'),
  finish('J-G1', 'grok-build', 800),
  closed('J-G1', 5, '2026-11-01T01:00:00+00:00'),
].join('\n');

function localSeat(seatId: string): SeatCapacity {
  return {
    seatId, engine: 'local', label: seatId, free: true, windows: [],
    signedOut: false, reachable: true, contextWindow: 65_536, observedAt: null, spentTodayUsd: null,
  };
}

const dirs: string[] = [];
let savedRunsDir: string | undefined;
afterEach(() => {
  resetLearnedSeatEvidenceCacheForTests();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  if (savedRunsDir === undefined) delete process.env['ASHLR_RUNS_DIR'];
  else process.env['ASHLR_RUNS_DIR'] = savedRunsDir;
  savedRunsDir = undefined;
});

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'phm-learned-seat-'));
  dirs.push(dir);
  return dir;
}

describe('learnedFleetSeatPenalty', () => {
  it('pools every recorded cell per resource, ignoring job type and repo', () => {
    const learning = learnFleetOutcomes(null, LEDGER);
    const penalty = learnedFleetSeatPenalty(learning);
    // devin's pooled record (two cheap merges) beats codex-cmp's (two
    // expensive closes); grok-build only appears because pooling spans
    // job types and repos — the (work, phantom) view never saw its cell.
    expect(penalty['devin']).toBe(0);
    expect(penalty['codex-cmp']).toBeGreaterThan(0);
    expect(penalty['codex-cmp']).toBeLessThanOrEqual(1);
    expect(penalty['grok-build']).toBeGreaterThan(0);
    expect(Object.keys(penalty).sort()).toEqual(['codex-cmp', 'devin', 'grok-build']);
    expect(learnedSeatPenalty(learning, 'work', 'phantom')).not.toHaveProperty('grok-build');
    expect(learnedSeatPenalty(learning, 'work', 'phantom')['devin']).toBe(0);
  });

  it('stays empty when nothing was measured', () => {
    expect(learnedFleetSeatPenalty(learnFleetOutcomes(null, null))).toEqual({});
    expect(learnedFleetSeatPenalty(learnFleetOutcomes('', 'not json\n'))).toEqual({});
  });
});

describe('computeLearnedSeatEvidence', () => {
  it('turns the jobs-ledger tail into a penalty and a provenance note', () => {
    const dir = scratch();
    mkdirSync(join(dir, 'metrics'), { recursive: true });
    writeFileSync(join(dir, 'metrics', 'jobs.jsonl'), `${LEDGER}\n`);
    const evidence = computeLearnedSeatEvidence({
      runsDir: dir,
      censor: null,
      revertedPrKeys: new Set(),
    });
    expect(evidence.learnedPenalty['devin']).toBe(0);
    expect(evidence.learnedPenalty['codex-cmp']).toBeGreaterThan(0);
    expect(evidence.learningNote).toContain('Fleet outcome learning');
  });

  it('reads an explicit events log and ledger path', () => {
    const dir = scratch();
    const events = join(dir, 'dispatch-events.log');
    const ledger = join(dir, 'jobs.jsonl');
    writeFileSync(events, [
      '2026-11-01 00:00:00 ASSIGN job=RQ-E1 resource=claude model=haiku type=code repo=phantom priority=normal',
      '2026-11-01 00:10:00 OUTCOME job=RQ-E1 state=merged usage=0.2 minutes=5 breakage=0',
    ].join('\n'));
    writeFileSync(ledger, LEDGER);
    const evidence = computeLearnedSeatEvidence({
      eventsPath: events,
      ledgerPath: ledger,
      censor: null,
      revertedPrKeys: new Set(),
    });
    // The dispatch-log cell joins the pool beside the ledger's. Its
    // allowance-unit usage reading makes it the cheapest record, so it is
    // the zero-penalty seat — the same unit semantics learnedSeatPenalty
    // already applies per cell.
    expect(Object.keys(evidence.learnedPenalty).sort()).toEqual(['claude', 'codex-cmp', 'devin', 'grok-build']);
    expect(evidence.learnedPenalty['claude']).toBe(0);
    expect(evidence.learningNote).toBeDefined();
  });

  it('contributes nothing when every source is missing or unreadable', () => {
    const dir = scratch();
    const evidence = computeLearnedSeatEvidence({
      runsDir: dir,
      eventsPath: join(dir, 'absent.log'),
      ledgerPath: join(dir, 'absent.jsonl'),
      censor: null,
      revertedPrKeys: new Set(),
    });
    expect(evidence).toEqual({ learnedPenalty: {} });
  });

  it('discounts standing-reverted merges enough to flip the pooled winner', () => {
    // devin's two cheap merges and codex-cmp's one cheap merge plus one
    // close are close calls; reverting both devin merges drops its pooled
    // score below codex-cmp's, so the zero-penalty seat changes hands.
    const ledger = [
      launch('J-D1', 'devin', 'swe-2-max', '2026-11-01T00:00:00+00:00'),
      finish('J-D1', 'devin', 500),
      merged('J-D1', 1, '2026-11-01T01:00:00+00:00'),
      launch('J-D2', 'devin', 'swe-2-max', '2026-11-01T02:00:00+00:00'),
      finish('J-D2', 'devin', 500),
      merged('J-D2', 2, '2026-11-01T03:00:00+00:00'),
      launch('J-C1', 'codex-cmp', 'gpt-5.4', '2026-11-01T00:00:00+00:00'),
      finish('J-C1', 'codex-cmp', 500),
      merged('J-C1', 3, '2026-11-01T01:00:00+00:00'),
      launch('J-C2', 'codex-cmp', 'gpt-5.4', '2026-11-01T02:00:00+00:00'),
      finish('J-C2', 'codex-cmp', 500),
      closed('J-C2', 4, '2026-11-01T03:00:00+00:00'),
    ].join('\n');
    const held = computeLearnedSeatEvidence({
      learning: learnFleetOutcomes(null, ledger),
      censor: null,
    });
    const reverted = computeLearnedSeatEvidence({
      learning: learnFleetOutcomes(null, ledger, undefined, new Set(['ashlrai/phantom#1', 'ashlrai/phantom#2'])),
      censor: null,
    });
    expect(held.learnedPenalty['devin']).toBe(0);
    expect(held.learnedPenalty['codex-cmp']).toBeGreaterThan(0);
    expect(reverted.learnedPenalty['codex-cmp']).toBe(0);
    expect(reverted.learnedPenalty['devin']).toBeGreaterThan(0);
  });

  it('reorders routeSeat candidates and appends the note only with evidence', () => {
    const fleet = [localSeat('codex-cmp'), localSeat('devin')];
    const policy = defaultBudgetPolicy();
    const req = { task: 'code' as const, difficulty: 'medium' as const, autonomous: true };
    const learning = learnFleetOutcomes(null, LEDGER);
    const empty = computeLearnedSeatEvidence({ learning: learnFleetOutcomes(null, null), censor: null });
    const plain = routeSeat(req, fleet, policy, { nowMs: NOW, ...empty });
    const evidence = computeLearnedSeatEvidence({ learning, censor: null, revertedPrKeys: new Set() });
    const learned = routeSeat(req, fleet, policy, { nowMs: NOW, ...evidence });
    expect(plain.candidates[0]).toBe('codex-cmp');
    expect(learned.candidates).toEqual(['devin', 'codex-cmp']);
    expect(learned.why.endsWith(evidence.learningNote!)).toBe(true);
    expect(plain.why).not.toContain('Fleet outcome learning');
  });
});

describe('learnedSeatRouteEvidence', () => {
  it('serves the cached penalty inside the TTL and recomputes after it', () => {
    const dir = scratch();
    mkdirSync(join(dir, 'queue'), { recursive: true });
    mkdirSync(join(dir, 'metrics'), { recursive: true });
    const ledgerPath = join(dir, 'metrics', 'jobs.jsonl');
    writeFileSync(ledgerPath, LEDGER);
    savedRunsDir = process.env['ASHLR_RUNS_DIR'];
    process.env['ASHLR_RUNS_DIR'] = dir;

    const first = learnedSeatRouteEvidence(NOW);
    expect(first.learnedPenalty['devin']).toBe(0);
    // A weaker record lands mid-window: inside the TTL the cached answer stands.
    writeFileSync(ledgerPath, [
      launch('J-W1', 'devin', 'swe-2-max', '2026-11-01T00:00:00+00:00'),
      finish('J-W1', 'devin', 9000),
      closed('J-W1', 9, '2026-11-01T01:00:00+00:00'),
    ].join('\n'));
    const within = learnedSeatRouteEvidence(NOW + LEARNED_SEAT_EVIDENCE_TTL_MS - 1);
    expect(within).toBe(first);
    const after = learnedSeatRouteEvidence(NOW + LEARNED_SEAT_EVIDENCE_TTL_MS);
    expect(after.learnedPenalty).not.toEqual(first.learnedPenalty);
  });
});
