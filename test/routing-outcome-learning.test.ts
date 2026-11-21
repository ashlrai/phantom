/**
 * Outcome learning: log posteriors, Thompson exploration, usage-before-reset,
 * critical jobs, and the shared desktop/CLI view.
 */
import { mkdirSync, readFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cmdFleetOutcomes } from '../src/cli/fleet-outcomes.js';
import { formatOutcomeLearning } from '../desktop/outcome-learning-view.js';
import {
  learnFleetOutcomes,
  learnOutcomes,
  learnedSeatPenalty,
  offersFromLearning,
  outcomeLearningView,
  replayLearnedRoutes,
  routeLearnedJob,
  type LearnedJob,
  type ResourceOffer,
} from '../src/core/routing/outcome-learning.js';
import { routeSeat } from '../src/core/routing/router.js';
import { defaultBudgetPolicy } from '../src/core/routing/policy.js';
import type { SeatCapacity } from '../src/core/routing/headroom.js';

const LOG_PATH = join(import.meta.dirname, 'fixtures/routing/outcome-events.txt');
const LOG = readFileSync(LOG_PATH, 'utf8');
const NOW = Date.parse('2026-11-02T00:00:00.000Z');
const PROBE: LearnedJob = { id: 'probe', repo: 'phantom', jobType: 'code', priority: 'normal' };

function offer(resource: string, model: string, usageLeftPercent: number | null, minutesToReset: number | null, slots = 1): ResourceOffer {
  return {
    resource,
    model,
    usageLeftPercent,
    resetAt: minutesToReset === null ? null : new Date(NOW + minutesToReset * 60_000).toISOString(),
    slots,
  };
}

function localSeat(seatId: string): SeatCapacity {
  return {
    seatId, engine: 'local', label: seatId, free: true, windows: [],
    signedOut: false, reachable: true, contextWindow: 65_536, observedAt: null, spentTodayUsd: null,
  };
}

async function run(args: string[]) {
  let out = '';
  let err = '';
  const stdout = process.stdout.write;
  const stderr = process.stderr.write;
  process.stdout.write = ((chunk: unknown) => { out += String(chunk); return true; }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: unknown) => { err += String(chunk); return true; }) as typeof process.stderr.write;
  try { return { code: await cmdFleetOutcomes(args), out, err }; }
  finally { process.stdout.write = stdout; process.stderr.write = stderr; }
}

let home: string | undefined;
afterEach(() => { if (home !== undefined) rmSync(home, { recursive: true, force: true }); home = undefined; });

describe('outcome learning', () => {
  it('learns merge, time, usage, and breakage, and ignores legacy launch lines', () => {
    const view = outcomeLearningView(learnOutcomes(LOG));
    expect(view).toMatchObject({ schema: 'routing.outcome-learning.v1', finished: 60, malformed: 1 });
    const devin = view.cells.find((cell) => cell.resource === 'devin' && cell.model === 'swe-2-max' && cell.jobType === 'code');
    const cmp = view.cells.find((cell) => cell.resource === 'codex-cmp' && cell.jobType === 'code');
    expect(devin).toMatchObject({ attempts: 12, merges: 10, goodMerges: 10, breakages: 0, meanMinutesToMerge: 30 });
    expect(devin?.meanUsage).toBeCloseTo(0.35);
    expect(cmp).toMatchObject({ attempts: 10, merges: 7, goodMerges: 4, breakages: 3, meanMinutesToMerge: 70 });
    expect(cmp?.meanUsage).toBeCloseTo(1.2);
    expect(view.improvementJobs.map((job) => job.pattern)).toEqual(expect.arrayContaining(['breakage', 'dirty', 'fixup', 'low-merge']));
    expect(view.improvementJobs.every((job) => job.id.startsWith('improve-') && job.task.length > 40)).toBe(true);
  });

  it('shifts a replay from the early cheap arm to the arm that ships', () => {
    const learning = learnOutcomes(LOG);
    const routes = replayLearnedRoutes(LOG, PROBE, offersFromLearning(learning), { nowMs: NOW, explore: false });
    expect(routes[0]).toMatchObject({ action: 'dispatch', resource: 'claude', model: 'haiku' });
    expect(routes.at(-1)).toMatchObject({ action: 'dispatch', resource: 'devin', model: 'swe-2-max' });
    const code = learning.cells.filter((cell) => cell.jobType === 'code' && cell.repo === 'phantom');
    const mix = (cells: typeof code) => {
      const attempts = cells.reduce((sum, cell) => sum + cell.attempts, 0);
      return {
        good: cells.reduce((sum, cell) => sum + cell.goodMerges, 0) / attempts,
        usage: cells.reduce((sum, cell) => sum + cell.usage, 0) / attempts,
      };
    };
    const chosen = code.find((cell) => cell.resource === 'devin' && cell.model === 'swe-2-max')!;
    expect(mix([chosen]).good).toBeGreaterThan(mix(code).good);
    expect(mix([chosen]).usage).toBeLessThan(mix(code).usage);
    expect(chosen.meanUsage).toBeLessThan(code.find((cell) => cell.resource === 'codex-cmp')!.meanUsage);
  });

  it('explores while the log is empty', () => {
    const empty = learnOutcomes('');
    const offers = [
      offer('devin', 'swe-2-max', null, null),
      offer('codex-cmp', 'gpt-5.4', null, null),
      offer('claude', 'haiku', null, null),
      offer('local-omlx', 'local', null, null),
    ];
    const picked = new Set<string>();
    for (let i = 0; i < 24; i += 1) {
      const route = routeLearnedJob(empty, { ...PROBE, id: `seed-${i}` }, offers, { nowMs: NOW });
      picked.add(`${route.resource}/${route.model}`);
      expect(route.action).toBe('dispatch');
    }
    expect(picked.size).toBeGreaterThan(1);
  });

  it('sends the job to Devin when CMP Codex cannot finish before reset', () => {
    const learning = learnOutcomes(LOG);
    const offers = [offer('codex-cmp', 'gpt-5.4', 5, 40), offer('devin', 'swe-2-max', 55, 7 * 24 * 60)];
    const route = routeLearnedJob(learning, PROBE, offers, { nowMs: NOW, explore: false });
    expect(route).toMatchObject({ action: 'dispatch', resource: 'devin', model: 'swe-2-max', explored: false });
    expect(route.explanation).toBe('Sent to Devin because CMP Codex resets in 40 min with 5% left.');
  });

  it('spends the allowance that resets soon when that resource still ships', () => {
    const learning = learnOutcomes(LOG);
    const offers = [offer('claude', 'opus', 70, 25), offer('devin', 'swe-2-max', 80, 7 * 24 * 60)];
    const route = routeLearnedJob(learning, PROBE, offers, { nowMs: NOW, explore: false });
    expect(route).toMatchObject({ action: 'dispatch', resource: 'claude', model: 'opus' });
    expect(route.explanation).toBe('Sent to Claude because it resets in 25 min with 70% left and still ships this work.');
  });

  it('does not make a critical job wait on an exhausted resource', () => {
    const learning = learnOutcomes(LOG);
    const offers = [offer('codex-cmp', 'gpt-5.4', 5, 40)];
    const critical = routeLearnedJob(learning, { ...PROBE, priority: 'critical' }, offers, { nowMs: NOW, explore: false });
    const patient = routeLearnedJob(learning, PROBE, offers, { nowMs: NOW, explore: false });
    expect(critical).toMatchObject({
      action: 'nowhere',
      resource: null,
      explanation: 'No resource can take this critical job right now, so it is not waiting on a reset.',
    });
    expect(patient).toMatchObject({ action: 'wait', resource: 'codex-cmp' });
    expect(patient.explanation).toBe('Waiting until CMP Codex resets in 40 min with 5% left, because nothing else can take this job.');
  });

  it('feeds posterior means into seat ranking without changing the default sentence', () => {
    const learning = learnOutcomes(LOG);
    const penalty = learnedSeatPenalty(learning, 'code', 'phantom');
    expect(penalty['devin']).toBe(0);
    expect(penalty['codex-cmp']).toBeGreaterThan(0);
    const fleet = [localSeat('codex-cmp'), localSeat('devin')];
    const policy = defaultBudgetPolicy();
    const req = { task: 'code' as const, difficulty: 'medium' as const, autonomous: true };
    const plain = routeSeat(req, fleet, policy, { nowMs: NOW });
    const same = routeSeat(req, fleet, policy, { nowMs: NOW, learnedPenalty: {} });
    expect(same.why).toBe(plain.why);
    expect(plain.why).not.toContain('Sent to');
    expect(plain.candidates[0]).toBe('codex-cmp');
    const learned = routeSeat(req, fleet, policy, { nowMs: NOW, learnedPenalty: penalty, learningNote: 'Sent to Devin because it ships.' });
    expect(learned.candidates).toEqual(['devin', 'codex-cmp']);
    expect(learned.why.endsWith('Sent to Devin because it ships.')).toBe(true);
  });

  it('parses a positional launch and shows the same sentences in the desktop view', () => {
    const text = [
      '2026-11-01 00:00:00 LAUNCH RQ-POS phantom devin swe-2-max code',
      '2026-11-01 00:10:00 OUTCOME RQ-POS merged usage=0.2 minutes=5 breakage=0',
    ].join('\n');
    const view = outcomeLearningView(learnOutcomes(text));
    expect(view.finished).toBe(1);
    const panel = formatOutcomeLearning(view, {
      action: 'dispatch', resource: 'devin', model: 'swe-2-max', explored: false, score: 1,
      explanation: 'Sent to Devin because CMP Codex resets in 40 min with 5% left.',
    });
    expect(panel.startsWith('Sent to Devin because CMP Codex resets in 40 min with 5% left.')).toBe(true);
    expect(panel).toContain('100% merge');
    expect(panel).toContain('5 min to merge');
  });

  it('serves the view and a route from the fleet CLI', async () => {
    const help = await run(['--help']);
    expect(help.code).toBe(0);
    expect(help.out).toContain('Usage: phm fleet outcomes');
    expect(help.out).toContain('--events');
    const missing = await run(['--events', join(tmpdir(), 'missing-outcome-log.log')]);
    expect(missing).toMatchObject({ code: 1, out: '', err: 'error: event log unavailable\n' });
    expect((await run(['--bogus'])).code).toBe(2);
    expect((await run(['route', '--events', LOG_PATH])).code).toBe(2);
    const report = await run(['--events', LOG_PATH, '--json']);
    expect(report.code).toBe(0);
    const body = JSON.parse(report.out) as { schema: string; finished: number; route: null; improvementJobs: unknown[] };
    expect(body).toMatchObject({ schema: 'routing.outcome-learning.v1', finished: 60, route: null });
    expect(body.improvementJobs.length).toBeGreaterThan(0);
    const routed = await run(['route', '--events', LOG_PATH, '--repo', 'phantom', '--type', 'code', '--job', 'probe', '--json']);
    expect(routed.code).toBe(0);
    const decision = JSON.parse(routed.out) as { route: { action: string; explanation: string } };
    expect(decision.route.action).toBe('dispatch');
    expect(decision.route.explanation.startsWith('Sent to ')).toBe(true);
    home = mkdtempSync(join(tmpdir(), 'outcome-offers-'));
    const offers = join(home, 'offers.json');
    const at = Date.now();
    writeFileSync(offers, JSON.stringify([
      { resource: 'codex-cmp', model: 'gpt-5.4', usageLeftPercent: 5, resetAt: new Date(at + 40 * 60_000).toISOString(), slots: 1 },
      { resource: 'devin', model: 'swe-2-max', usageLeftPercent: 55, resetAt: new Date(at + 7 * 24 * 60 * 60_000).toISOString(), slots: 2 },
    ]));
    const explained = await run(['route', '--events', LOG_PATH, '--repo', 'phantom', '--type', 'code', '--priority', 'critical', '--offers', offers, '--json']);
    expect(explained.code).toBe(0);
    const critical = JSON.parse(explained.out) as { route: { explanation: string; action: string; resource: string } };
    expect(critical.route).toMatchObject({ action: 'dispatch', resource: 'devin' });
    expect(critical.route.explanation).toBe('Sent to Devin because CMP Codex resets in 40 min with 5% left.');
  });

  describe('jobs ledger outcomes', () => {
    const LEDGER = [
      JSON.stringify({ event: 'launch', job: 'J-1', repo: 'phantom', lane: 'devin', tier: 'work', model: 'swe-2-max', ts: '2026-11-01T00:00:00+00:00' }),
      JSON.stringify({ event: 'finish', job: 'J-1', lane: 'devin', tokens_total: 1200, wall_s: 600 }),
      JSON.stringify({ event: 'launch', job: 'J-2', repo: 'phantom', lane: 'devin', tier: 'work', model: 'swe-2-max', ts: '2026-11-01T01:00:00+00:00' }),
      JSON.stringify({ event: 'finish', job: 'J-2', lane: 'devin', tokens_total: 800, wall_s: 300 }),
      JSON.stringify({ event: 'launch', job: 'J-3', repo: 'phantom', lane: 'devin', tier: 'work', model: 'swe-2-max', ts: '2026-11-01T02:00:00+00:00' }),
      JSON.stringify({ event: 'concurrency', from: 1, to: 2, reason: 'test', zones: {} }),
      JSON.stringify({ event: 'publish', source: 'metrics-outcomes-reconciler', jobId: 'J-1', prUrl: 'https://github.com/ashlrai/phantom/pull/1', outcome: 'MERGED', mergedAt: '2026-11-01T00:30:00+00:00', ts: '2026-11-01T00:31:00+00:00' }),
      JSON.stringify({ event: 'publish', source: 'metrics-outcomes-reconciler', jobId: 'J-2', prUrl: 'https://github.com/ashlrai/phantom/pull/2', outcome: 'CLOSED', closedAt: '2026-11-01T02:00:00+00:00', ts: '2026-11-01T02:01:00+00:00' }),
      JSON.stringify({ event: 'publish', source: 'metrics-outcomes-reconciler', jobId: 'J-3', prUrl: 'https://github.com/ashlrai/phantom/pull/3', outcome: 'MERGED', mergedAt: '2026-11-01T03:00:00+00:00', ts: '2026-11-01T03:01:00+00:00' }),
      'not json at all',
    ].join('\n');

    it('folds launch, finish and reconciler rows into outcome cells', () => {
      const view = outcomeLearningView(learnFleetOutcomes(null, LEDGER));
      expect(view.finished).toBe(3);
      expect(view.malformed).toBe(1);
      const cell = view.cells.find((c) => c.resource === 'devin' && c.jobType === 'work');
      // J-3 merged with no finish row: its usage is charged the cell mean (1000), never zeroed.
      expect(cell).toMatchObject({
        resource: 'devin', model: 'swe-2-max', jobType: 'work', repo: 'phantom',
        attempts: 3, merges: 2, goodMerges: 2, censored: 0,
      });
      expect(cell?.meanUsage).toBeCloseTo(1000);
      expect(cell?.meanMinutesToMerge).toBeCloseTo(45);
    });

    it('counts each recorded dead launch as a failed attempt a relaunch cannot erase', () => {
      const ledger = [
        JSON.stringify({ event: 'launch', job: 'J-9', repo: 'phantom', lane: 'devin', tier: 'work', model: 'swe-2-max', ts: '2026-11-01T00:00:00+00:00' }),
        JSON.stringify({ event: 'launch_failed', job: 'J-9', lane: 'devin', reason: 'launcher_exited', action: 'retry', attempt: 1, ts: '2026-11-01T00:05:00+00:00' }),
        // The sweep emits launch_terminal beside every dead launch; the second
        // row for the same attempt must not count a second failure.
        JSON.stringify({ event: 'launch_terminal', job: 'J-9', reason: 'launcher-exited', ts: '2026-11-01T00:05:01+00:00' }),
        // Requeued relaunch of the same job id: a fresh assign, not an overwrite.
        JSON.stringify({ event: 'launch', job: 'J-9', repo: 'phantom', lane: 'devin', tier: 'work', model: 'swe-2-max', ts: '2026-11-01T01:00:00+00:00' }),
        JSON.stringify({ event: 'finish', job: 'J-9', lane: 'devin', tokens_total: 700, wall_s: 300 }),
        JSON.stringify({ event: 'publish', source: 'metrics-outcomes-reconciler', jobId: 'J-9', prUrl: 'https://github.com/ashlrai/phantom/pull/9', outcome: 'MERGED', mergedAt: '2026-11-01T02:00:00+00:00', ts: '2026-11-01T02:01:00+00:00' }),
        // A spawn failure never wrote a launch row: no assign to resolve, and
        // the row is operational evidence, not malformed input.
        JSON.stringify({ event: 'launch_terminal', job: 'J-ORPHAN', reason: 'spawn-failed', ts: '2026-11-01T03:00:00+00:00' }),
        // A give_up verdict resolves the same way; no relaunch follows.
        JSON.stringify({ event: 'launch', job: 'J-10', repo: 'phantom', lane: 'devin', tier: 'work', model: 'swe-2-max', ts: '2026-11-01T04:00:00+00:00' }),
        JSON.stringify({ event: 'launch_failed', job: 'J-10', lane: 'devin', reason: 'provider_credits', action: 'give_up', attempt: 3, ts: '2026-11-01T04:10:00+00:00' }),
      ].join('\n');
      const view = outcomeLearningView(learnFleetOutcomes(null, ledger));
      expect(view.finished).toBe(3);
      expect(view.malformed).toBe(0);
      const cell = view.cells.find((c) => c.resource === 'devin' && c.jobType === 'work');
      // Two attempts on J-9 (dead launch + merged relaunch) plus J-10's
      // give_up: three attempts, one merge — the dead launches are counted,
      // not erased by the relaunch's assign.
      expect(cell).toMatchObject({ attempts: 3, merges: 1, goodMerges: 1, censored: 0 });
      expect(cell?.mergeRate).toBeCloseTo(1 / 3);
    });

    it('folds batch members per line and never the session id', () => {
      // A typical session id fits ident(): before this fold it opened an
      // attempt that could never resolve. It must now skip as infrastructure.
      const bid = 'RQ-BATCH-PHANTOM-CONTRIB-MAC-A1B2C3D4E5F6';
      const ledger = [
        JSON.stringify({ event: 'batch_claim', job: 'J-A', batch: bid, repo: 'phantom', lane: 'claude', tier: 'work', area: 'core', model: 'sonnet', ts: '2026-11-01T00:00:00+00:00' }),
        JSON.stringify({ event: 'batch_claim', job: 'J-B', batch: bid, repo: 'phantom', lane: 'claude', tier: 'work', area: 'core', model: 'sonnet', ts: '2026-11-01T00:00:00+00:00' }),
        JSON.stringify({ event: 'launch', job: bid, repo: 'phantom', lane: 'claude', tier: 'work', model: 'sonnet', batch_size: 2, ts: '2026-11-01T00:10:00+00:00' }),
        JSON.stringify({ event: 'finish', job: bid, lane: 'claude', tokens_total: 9000, wall_s: 3600, batch_size: 2 }),
        // done publishes on its own and resolves on the reconciler verdict;
        // failed requeues with no publish, so its attempt is dead.
        JSON.stringify({ event: 'task_outcome', job: 'J-A', batch: bid, lane: 'claude', repo: 'phantom', outcome: 'done', model: 'sonnet', ts: '2026-11-01T01:10:00+00:00' }),
        JSON.stringify({ event: 'task_outcome', job: 'J-B', batch: bid, lane: 'claude', repo: 'phantom', outcome: 'failed', model: 'sonnet', reason: 'no diff', ts: '2026-11-01T01:10:00+00:00' }),
        JSON.stringify({ event: 'publish', source: 'metrics-outcomes-reconciler', jobId: 'J-A', prUrl: 'https://github.com/ashlrai/phantom/pull/11', outcome: 'MERGED', mergedAt: '2026-11-01T02:00:00+00:00', ts: '2026-11-01T02:01:00+00:00' }),
        // J-B requeued and relaunched solo: a fresh attempt, not an overwrite.
        JSON.stringify({ event: 'launch', job: 'J-B', repo: 'phantom', lane: 'claude', tier: 'work', model: 'sonnet', ts: '2026-11-01T03:00:00+00:00' }),
        JSON.stringify({ event: 'finish', job: 'J-B', lane: 'claude', tokens_total: 1500, wall_s: 600 }),
        JSON.stringify({ event: 'publish', source: 'metrics-outcomes-reconciler', jobId: 'J-B', prUrl: 'https://github.com/ashlrai/phantom/pull/12', outcome: 'MERGED', mergedAt: '2026-11-01T04:00:00+00:00', ts: '2026-11-01T04:01:00+00:00' }),
      ].join('\n');
      const view = outcomeLearningView(learnFleetOutcomes(null, ledger));
      expect(view.finished).toBe(3);
      expect(view.malformed).toBe(0);
      const cell = view.cells.find((c) => c.resource === 'claude' && c.jobType === 'work');
      // J-A merged in the batch, J-B's batch attempt died and its solo
      // relaunch merged: three attempts, two merges. Member usage is
      // unmeasured (no per-member finish), so the cell mean is imputed.
      expect(cell).toMatchObject({ attempts: 3, merges: 2, goodMerges: 2, censored: 0 });
      expect(cell?.meanUsage).toBeCloseTo(1500);
      // J-A merged 110 min after the session launch; J-B's solo relaunch 60.
      expect(cell?.meanMinutesToMerge).toBeCloseTo(85);
    });

    it('closes member attempts when the batch session dies, and counts nothing for a batch that never launched', () => {
      // Past the 64-char ident bound: the session rows must skip cleanly
      // rather than count malformed.
      const dead = 'RQ-BATCH-PHANTOM-CONTRIB-MAC-DISPATCHD-QUEUE-BATCH-SESSIONS-2-A1B2C3D4';
      const unborn = 'RQ-BATCH-PHANTOM-CONTRIB-MAC-C3D4E5F6A7B8';
      const ledger = [
        JSON.stringify({ event: 'batch_claim', job: 'J-C', batch: dead, repo: 'phantom', lane: 'devin', tier: 'work', model: 'swe-2-max', ts: '2026-11-01T00:00:00+00:00' }),
        JSON.stringify({ event: 'batch_claim', job: 'J-D', batch: dead, repo: 'phantom', lane: 'devin', tier: 'work', model: 'swe-2-max', ts: '2026-11-01T00:00:00+00:00' }),
        JSON.stringify({ event: 'launch', job: dead, repo: 'phantom', lane: 'devin', tier: 'work', model: 'swe-2-max', batch_size: 2, ts: '2026-11-01T00:10:00+00:00' }),
        // The launcher died before the session reported: both member
        // attempts close unmerged, like a solo dead launch.
        JSON.stringify({ event: 'launch_terminal', job: dead, reason: 'launcher-exited', ts: '2026-11-01T00:20:00+00:00' }),
        // J-C requeued and relaunched solo, then merged.
        JSON.stringify({ event: 'launch', job: 'J-C', repo: 'phantom', lane: 'devin', tier: 'work', model: 'swe-2-max', ts: '2026-11-01T01:00:00+00:00' }),
        JSON.stringify({ event: 'finish', job: 'J-C', lane: 'devin', tokens_total: 900, wall_s: 400 }),
        JSON.stringify({ event: 'publish', source: 'metrics-outcomes-reconciler', jobId: 'J-C', prUrl: 'https://github.com/ashlrai/phantom/pull/13', outcome: 'MERGED', mergedAt: '2026-11-01T02:00:00+00:00', ts: '2026-11-01T02:01:00+00:00' }),
        // Claims for a bundle released before launch (spawn failure writes
        // launch_terminal with no launch row): no attempt ever opened.
        JSON.stringify({ event: 'batch_claim', job: 'J-E', batch: unborn, repo: 'phantom', lane: 'devin', tier: 'work', model: 'swe-2-max', ts: '2026-11-01T03:00:00+00:00' }),
        JSON.stringify({ event: 'launch_terminal', job: unborn, reason: 'spawn-failed', ts: '2026-11-01T03:01:00+00:00' }),
      ].join('\n');
      const view = outcomeLearningView(learnFleetOutcomes(null, ledger));
      expect(view.finished).toBe(3);
      expect(view.malformed).toBe(0);
      const cell = view.cells.find((c) => c.resource === 'devin' && c.jobType === 'work');
      // J-C dead-in-batch + J-C merged solo + J-D dead-in-batch = 3 attempts,
      // 1 merge. J-E's unborn bundle contributes nothing.
      expect(cell).toMatchObject({ attempts: 3, merges: 1, goodMerges: 1, censored: 0 });
      expect(cell?.mergeRate).toBeCloseTo(1 / 3);
    });

    it('keeps dispatch-log learning identical when the ledger is absent', () => {
      const viaFleet = learnFleetOutcomes(LOG, null);
      const viaPlain = learnOutcomes(LOG);
      expect(viaFleet).toEqual(viaPlain);
      expect(learnFleetOutcomes(null, null)).toMatchObject({ finished: 0, malformed: 0, cells: [] });
    });

    it('serves the ledger view through --ledger and the default runs path', async () => {
      home = mkdtempSync(join(tmpdir(), 'outcome-ledger-'));
      const ledgerPath = join(home, 'jobs.jsonl');
      writeFileSync(ledgerPath, LEDGER);
      const flagged = await run(['--ledger', ledgerPath, '--json']);
      expect(flagged.code).toBe(0);
      expect(JSON.parse(flagged.out)).toMatchObject({ schema: 'routing.outcome-learning.v1', finished: 3 });
      // Default path: <runs>/metrics/jobs.jsonl, runs dir pinned for determinism.
      const runsDir = join(home, 'runs');
      const priorRunsDir = process.env['ASHLR_RUNS_DIR'];
      process.env['ASHLR_RUNS_DIR'] = runsDir;
      try {
        mkdirSync(join(runsDir, 'metrics'), { recursive: true });
        writeFileSync(join(runsDir, 'metrics', 'jobs.jsonl'), LEDGER);
        const def = await run(['--json']);
        expect(def.code).toBe(0);
        expect(JSON.parse(def.out)).toMatchObject({ finished: 3 });
      } finally {
        if (priorRunsDir === undefined) delete process.env['ASHLR_RUNS_DIR'];
        else process.env['ASHLR_RUNS_DIR'] = priorRunsDir;
      }
    });
  });
});
