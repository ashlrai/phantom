/** RQ-PHX-CLAIMEXECUTIONTIME422S — a claim must be *current* evidence before
 * it can contribute live execution: missing, nonfinite, out-of-Date-range or
 * future `claimedAt`, a reversed or empty interval, and an expiry at or before
 * the observation all fail temporal qualification. An invalid claim is
 * dropped before the 50-row cap, displaces no valid claim, and can never
 * produce RUNNING or CLAIMED_NO_WORKER. Both readers are faked; fixtures are
 * plainly fake and nothing touches the real home, ledger, `ps` or network. */
import { describe, expect, it } from 'vitest';
import {
  joinClaimExecution,
  readClaimExecution,
} from '../src/core/fleet/claim-execution-evidence.js';
import type { FleetBoard, FleetClaim } from '../src/core/fleet/coordination.js';
import type { LiveWorker, LiveWorkersSnapshot } from '../src/core/fleet/runs-live-workers.js';

const NOW = Date.parse('2026-11-15T12:00:00.000Z');
const NOW_ISO = new Date(NOW).toISOString();
const JOB = 'RQ-PHX-FAKETIME422S';
const INVALID_REASON = 'claim timestamps invalid';

function claim(over: Record<string, unknown> = {}): FleetClaim {
  return {
    id: JOB, repo: 'ashlrai/phantom', task: 'fake task text',
    agent: 'fake-agent', claimedAt: NOW - 60_000, expiresAt: NOW + 60_000,
    ...over,
  } as FleetClaim;
}

function board(claims: unknown[], state: 'known' | 'unknown' = 'known'): FleetBoard {
  return { schema: 'fleet.coordination.v1', state, claims: claims as FleetClaim[], messages: [], proposals: [], expiredClaims: 0 };
}

function worker(over: Partial<LiveWorker> = {}): LiveWorker {
  return {
    pid: 4242, job: JOB, repo: 'phantom', lane: 'devin',
    tier: 'work', ageSeconds: 300, ...over,
  };
}

function snapshot(workers: LiveWorker[] = [worker()]): LiveWorkersSnapshot {
  return { v: 1, generatedAt: NOW_ISO, sourceState: 'healthy', workers, leaders: [], orchestratorAgents: 0 };
}

describe('joinClaimExecution claim temporal qualification', () => {
  it('a temporally valid claim with a matching worker still reports RUNNING', () => {
    const report = joinClaimExecution(board([claim()]), snapshot(), NOW);
    expect(report.rows).toHaveLength(1);
    expect(report.rows[0]).toMatchObject({
      state: 'RUNNING', jobId: JOB, worker: { pid: 4242, lane: 'devin' },
    });
    expect(report.counts).toEqual({ running: 1, claimedNoWorker: 0, unknown: 0 });
    expect(report.reasons).toEqual([]);
  });

  it.each([
    ['missing', undefined],
    ['null', null],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['-Infinity', Number.NEGATIVE_INFINITY],
    ['negative', -1],
    ['fractional', NOW - 60_000.5],
    ['unsafe integer', Number.MAX_SAFE_INTEGER],
    ['beyond Date range', 9_000_000_000_000_000],
    ['string', String(NOW - 60_000)],
  ])('claimedAt %s never produces RUNNING or CLAIMED_NO_WORKER', (_name, claimedAt) => {
    const report = joinClaimExecution(
      board([claim({ claimedAt, id: `${JOB}-BAD` })]),
      snapshot([worker({ job: `${JOB}-BAD` })]), NOW);
    expect(report.rows).toEqual([]);
    expect(report.counts).toEqual({ running: 0, claimedNoWorker: 0, unknown: 0 });
    expect(report.reasons).toEqual([INVALID_REASON]);
  });

  it.each([
    ['missing', undefined],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['unsafe integer', Number.MAX_SAFE_INTEGER],
    ['beyond Date range', 9_000_000_000_000_000],
    ['string', String(NOW + 60_000)],
  ])('expiresAt %s never produces RUNNING or CLAIMED_NO_WORKER', (_name, expiresAt) => {
    const report = joinClaimExecution(
      board([claim({ expiresAt, id: `${JOB}-BAD` })]),
      snapshot([worker({ job: `${JOB}-BAD` })]), NOW);
    expect(report.rows).toEqual([]);
    expect(report.counts).toEqual({ running: 0, claimedNoWorker: 0, unknown: 0 });
    expect(report.reasons).toEqual([INVALID_REASON]);
  });

  it('a claimedAt ahead of the observation is invalid even when expiry is later', () => {
    const report = joinClaimExecution(
      board([claim({ claimedAt: NOW + 60_000, expiresAt: NOW + 120_000 })]),
      snapshot(), NOW);
    expect(report.rows).toEqual([]);
    expect(report.reasons).toEqual([INVALID_REASON]);
  });

  it('a claimedAt exactly at the observation still qualifies', () => {
    const report = joinClaimExecution(
      board([claim({ claimedAt: NOW })]), snapshot(), NOW);
    expect(report.rows[0]).toMatchObject({ state: 'RUNNING' });
  });

  it.each([
    ['expiresAt before claimedAt', { claimedAt: NOW - 1_000, expiresAt: NOW - 2_000 }],
    ['expiresAt equal to claimedAt', { claimedAt: NOW - 1_000, expiresAt: NOW - 1_000 }],
    ['reversed but both future', { claimedAt: NOW + 60_000, expiresAt: NOW + 30_000 }],
  ])('a reversed interval (%s) is invalid', (_name, times) => {
    const report = joinClaimExecution(board([claim(times)]), snapshot(), NOW);
    expect(report.rows).toEqual([]);
    expect(report.reasons).toEqual([INVALID_REASON]);
  });

  it('expiry exactly at the observation boundary is not live', () => {
    const report = joinClaimExecution(
      board([claim({ expiresAt: NOW })]), snapshot(), NOW);
    expect(report.rows).toEqual([]);
    expect(report.counts).toEqual({ running: 0, claimedNoWorker: 0, unknown: 0 });
  });

  it('expiry one millisecond past the observation is live', () => {
    const report = joinClaimExecution(
      board([claim({ expiresAt: NOW + 1 })]), snapshot(), NOW);
    expect(report.rows[0]).toMatchObject({ state: 'RUNNING', expiresInSeconds: 0 });
  });

  it('a sane but expired interval still drops silently without the invalid reason', () => {
    const report = joinClaimExecution(
      board([claim({ claimedAt: NOW - 120_000, expiresAt: NOW - 1 })]), snapshot(), NOW);
    expect(report.rows).toEqual([]);
    expect(report.reasons).toEqual([]);
  });

  it('invalid claims never consume the 50-row cap or displace valid claims', () => {
    const invalid = Array.from({ length: 60 }, (_, i) =>
      claim({ id: `fake-bad-${i}`, claimedAt: i % 2 === 0 ? Number.NaN : NOW + 1, expiresAt: NOW + 60_000 }));
    const valid = Array.from({ length: 5 }, (_, i) =>
      claim({ id: `fake-valid-${i}`, claimedAt: NOW - (i + 1) * 1_000 }));
    const report = joinClaimExecution(board([...invalid, ...valid]), snapshot([]), NOW);
    expect(report.rows).toHaveLength(5);
    expect(report.rows.map(row => row.claimId)).toEqual(valid.map(c => c.id));
    expect(report.reasons).toEqual([INVALID_REASON, 'claim names no job id']);
  });

  it('an invalid claim naming a job with no worker is dropped, not CLAIMED_NO_WORKER', () => {
    const report = joinClaimExecution(
      board([claim({ claimedAt: NOW + 60_000, expiresAt: NOW + 120_000 })]),
      snapshot([]), NOW);
    expect(report.rows).toEqual([]);
    expect(report.counts).toEqual({ running: 0, claimedNoWorker: 0, unknown: 0 });
  });

  it('mixed invalid and valid claims keep valid rows and report the fixed reason once', () => {
    const report = joinClaimExecution(
      board([
        claim({ id: 'RQ-PHX-FAKEGOOD1' }),
        claim({ id: 'RQ-PHX-FAKEBAD1', claimedAt: Number.NaN }),
        claim({ id: 'RQ-PHX-FAKEBAD2', expiresAt: NOW - 5_000, claimedAt: NOW - 10_000 }),
      ]),
      snapshot([worker({ job: 'RQ-PHX-FAKEGOOD1' })]), NOW);
    expect(report.rows).toHaveLength(1);
    expect(report.rows[0]).toMatchObject({ claimId: 'RQ-PHX-FAKEGOOD1', state: 'RUNNING' });
    expect(report.reasons).toEqual([INVALID_REASON]);
    expect(report.counts).toEqual({ running: 1, claimedNoWorker: 0, unknown: 0 });
  });

  it('never leaks malformed raw labels or task text from excluded claims', () => {
    const marker = 'FAKE-TASK-NARRATIVE-422S';
    const report = joinClaimExecution(
      board([claim({
        id: 'RQ-PHX-FAKELEAK1', agent: 'bad agent\u001b[0m', task: `narrative ${marker}`,
        claimedAt: Number.NaN,
      })]),
      snapshot([worker({ job: 'RQ-PHX-FAKELEAK1' })]), NOW);
    expect(report.rows).toEqual([]);
    const json = JSON.stringify(report);
    expect(json).not.toContain(marker);
    expect(json).not.toContain('narrative');
    expect(json).not.toContain('[0m');
  });
});

describe('readClaimExecution temporal qualification', () => {
  it('drops temporally invalid claims through the injected readers', async () => {
    const report = await readClaimExecution({
      board: () => board([
        claim({ id: 'RQ-PHX-FAKEREAD1' }),
        claim({ id: 'RQ-PHX-FAKEREAD2', claimedAt: NOW + 60_000, expiresAt: NOW + 120_000 }),
      ]),
      workers: async () => snapshot([worker({ job: 'RQ-PHX-FAKEREAD1' })]),
      now: () => NOW,
    });
    expect(report.rows).toHaveLength(1);
    expect(report.rows[0]).toMatchObject({ claimId: 'RQ-PHX-FAKEREAD1', state: 'RUNNING' });
    expect(report.reasons).toEqual([INVALID_REASON]);
  });
});
