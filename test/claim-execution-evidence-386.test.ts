/** RQ-PHX-CLAIMEXECEVIDENCE386 — `joinClaimExecution`/`readClaimExecution`
 * join live advisory claims with the live worker process table. Both readers
 * are faked here: nothing touches the real home, ledger, `ps` or network.
 * Fixtures are plainly fake (RQ-PHX-FAKEJOB1, fake-agent, pid 4242). */
import { describe, expect, it } from 'vitest';
import {
  CLAIM_EXECUTION_SCHEMA,
  joinClaimExecution,
  readClaimExecution,
} from '../src/core/fleet/claim-execution-evidence.js';
import type { FleetBoard, FleetClaim } from '../src/core/fleet/coordination.js';
import type { LiveWorker, LiveWorkersSnapshot } from '../src/core/fleet/runs-live-workers.js';

const NOW = Date.parse('2026-11-14T12:00:00.000Z');
const NOW_ISO = new Date(NOW).toISOString();

function claim(over: Partial<FleetClaim> = {}): FleetClaim {
  return {
    id: 'fake-claim-1', repo: 'ashlrai/phantom', task: 'fake task text',
    agent: 'fake-agent', claimedAt: NOW - 60_000, expiresAt: NOW + 60_000,
    ...over,
  };
}

function board(claims: FleetClaim[], state: 'known' | 'unknown' = 'known'): FleetBoard {
  return { schema: 'fleet.coordination.v1', state, claims, messages: [], proposals: [], expiredClaims: 0 };
}

function worker(over: Partial<LiveWorker> = {}): LiveWorker {
  return {
    pid: 4242, job: 'RQ-PHX-FAKEJOB1', repo: 'phantom', lane: 'devin',
    tier: 'work', ageSeconds: 300, ...over,
  };
}

function snapshot(workers: LiveWorker[], sourceState: 'healthy' | 'unavailable' = 'healthy'): LiveWorkersSnapshot {
  return { v: 1, generatedAt: NOW_ISO, sourceState, workers, leaders: [], orchestratorAgents: 0 };
}

describe('joinClaimExecution', () => {
  it('marks a claim RUNNING when a live worker carries the job id its claim names', () => {
    const report = joinClaimExecution(board([claim({ id: 'RQ-PHX-FAKEJOB1' })]), snapshot([worker()]), NOW);
    expect(report).toMatchObject({
      schema: CLAIM_EXECUTION_SCHEMA, authority: 'none', asOf: NOW_ISO,
      ledger: 'known', processes: 'healthy', reasons: [],
      counts: { running: 1, claimedNoWorker: 0, unknown: 0 },
    });
    expect(report.rows).toEqual([{
      claimId: 'RQ-PHX-FAKEJOB1', agent: 'fake-agent', repo: 'ashlrai/phantom',
      jobId: 'RQ-PHX-FAKEJOB1', state: 'RUNNING',
      worker: { pid: 4242, lane: 'devin', tier: 'work', ageSeconds: 300 },
      expiresInSeconds: 60,
    }]);
  });

  it('extracts the job id from claim task text when the claim id names none', () => {
    const report = joinClaimExecution(
      board([claim({ id: 'fake-claim-2', task: 'watch fake RQ-PHX-FAKEJOB2 output' })]),
      snapshot([worker({ job: 'RQ-PHX-FAKEJOB2', pid: 777 })]), NOW);
    expect(report.rows[0]).toMatchObject({
      jobId: 'RQ-PHX-FAKEJOB2', state: 'RUNNING', worker: { pid: 777, lane: 'devin' },
    });
    expect(report.counts.running).toBe(1);
  });

  it('prefers the job id in claim.id over one in the task text', () => {
    const report = joinClaimExecution(
      board([claim({ id: 'RQ-PHX-FAKEJOB1', task: 'fake notes about RQ-PHX-FAKEJOB2' })]),
      snapshot([worker({ job: 'RQ-PHX-FAKEJOB1' }), worker({ job: 'RQ-PHX-FAKEJOB2', pid: 1 })]), NOW);
    expect(report.rows[0]).toMatchObject({ jobId: 'RQ-PHX-FAKEJOB1', state: 'RUNNING' });
  });

  it('reports CLAIMED_NO_WORKER when no worker carries the named job', () => {
    const report = joinClaimExecution(
      board([claim({ id: 'RQ-PHX-FAKEJOB1' })]),
      snapshot([worker({ job: 'RQ-PHX-OTHERJOB9' })]), NOW);
    expect(report.rows[0]).toMatchObject({ state: 'CLAIMED_NO_WORKER', jobId: 'RQ-PHX-FAKEJOB1', worker: null });
    expect(report.counts).toEqual({ running: 0, claimedNoWorker: 1, unknown: 0 });
  });

  it('reports CLAIMED_NO_WORKER when the worker repo last segment differs', () => {
    const report = joinClaimExecution(
      board([claim({ id: 'RQ-PHX-FAKEJOB1', repo: 'ashlrai/phantom' })]),
      snapshot([worker({ repo: 'locus' })]), NOW);
    expect(report.rows[0]).toMatchObject({ state: 'CLAIMED_NO_WORKER', worker: null });
  });

  it('matches when either repo is empty and picks the youngest matching worker', () => {
    const report = joinClaimExecution(
      board([claim({ id: 'RQ-PHX-FAKEJOB1', repo: 'ashlrai/phantom' })]),
      snapshot([
        worker({ pid: 11, repo: 'other/phantom', ageSeconds: 900 }),
        worker({ pid: 22, repo: '', ageSeconds: 120 }),
        worker({ pid: 33, repo: 'phantom', ageSeconds: 450 }),
      ]), NOW);
    expect(report.rows[0]).toMatchObject({ state: 'RUNNING', worker: { pid: 22 } });
  });

  it('excludes expired claims, caps rows at 50 and keeps newest claimedAt first', () => {
    const claims = Array.from({ length: 60 }, (_, i) =>
      claim({ id: `fake-claim-${i}`, claimedAt: NOW - i * 1_000 }));
    claims.push(claim({ id: 'fake-claim-expired', expiresAt: NOW - 1 }));
    const report = joinClaimExecution(board(claims), snapshot([]), NOW);
    expect(report.rows).toHaveLength(50);
    expect(report.rows[0]!.claimId).toBe('fake-claim-0');
    expect(report.rows[49]!.claimId).toBe('fake-claim-49');
    expect(report.rows.every(row => row.claimId !== 'fake-claim-expired')).toBe(true);
    expect(report.counts.unknown).toBe(50);
    expect(report.reasons).toEqual(['claim names no job id']);
  });

  it('marks every row UNKNOWN when the process table is unavailable', () => {
    const report = joinClaimExecution(
      board([claim({ id: 'RQ-PHX-FAKEJOB1' }), claim({ id: 'fake-claim-plain' })]),
      snapshot([], 'unavailable'), NOW);
    expect(report.processes).toBe('unavailable');
    expect(report.rows).toHaveLength(2);
    expect(report.rows.every(row => row.state === 'UNKNOWN' && row.worker === null)).toBe(true);
    expect(report.counts).toEqual({ running: 0, claimedNoWorker: 0, unknown: 2 });
    expect(report.reasons).toEqual(['process table: unavailable']);
  });

  it('reports an empty unavailable ledger when the board is unknown or null', () => {
    for (const input of [board([], 'unknown'), null]) {
      const report = joinClaimExecution(input, snapshot([worker()]), NOW);
      expect(report).toMatchObject({
        ledger: 'unavailable', processes: 'healthy', rows: [],
        counts: { running: 0, claimedNoWorker: 0, unknown: 0 },
        reasons: ['coordination ledger: missing or unreadable'],
      });
    }
  });

  it('marks rows UNKNOWN with the no-job-id reason when a claim names no RQ- token', () => {
    const report = joinClaimExecution(board([claim({ id: 'fake-claim-plain' })]), snapshot([worker()]), NOW);
    expect(report.rows[0]).toMatchObject({ jobId: null, state: 'UNKNOWN', worker: null });
    expect(report.reasons).toEqual(['claim names no job id']);
  });

  it('replaces unsafe labels with UNKNOWN and never emits claim task text', () => {
    const taskText = 'phony task narrative for RQ-PHX-FAKEJOB1 eyes only';
    const report = joinClaimExecution(
      board([claim({ id: 'fake-claim-9', agent: 'a b\u001b[0m', task: taskText })]),
      snapshot([worker({ job: 'RQ-PHX-FAKEJOB1' })]), NOW);
    expect(report.rows[0]).toMatchObject({ agent: 'UNKNOWN', jobId: 'RQ-PHX-FAKEJOB1', state: 'RUNNING' });
    const json = JSON.stringify(report);
    expect(json).not.toContain(taskText);
    expect(json).not.toContain('phony task narrative');
    expect(json).not.toContain('[0m');
  });
});

describe('readClaimExecution', () => {
  it('reports both sources unavailable without throwing or leaking exception text', async () => {
    const report = await readClaimExecution({
      board: () => { throw new Error('/Users/fake/secret'); },
      workers: async () => { throw new Error('/Users/fake/secret'); },
      now: () => NOW,
    });
    expect(report).toMatchObject({
      schema: CLAIM_EXECUTION_SCHEMA, asOf: NOW_ISO,
      ledger: 'unavailable', processes: 'unavailable', rows: [],
      reasons: ['coordination ledger: missing or unreadable'],
    });
    expect(JSON.stringify(report)).not.toContain('/Users/');
  });

  it('reads through injected readers and marks a matched claim RUNNING', async () => {
    const report = await readClaimExecution({
      board: () => board([claim({ id: 'RQ-PHX-FAKEJOB1' })]),
      workers: async () => snapshot([worker()]),
      now: () => NOW,
    });
    expect(report.rows[0]).toMatchObject({ state: 'RUNNING', worker: { pid: 4242, lane: 'devin' } });
    expect(report.ledger).toBe('known');
    expect(report.processes).toBe('healthy');
  });
});
