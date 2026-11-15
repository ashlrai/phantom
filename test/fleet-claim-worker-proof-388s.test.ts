/** RQ-PHX-CLAIMWORKERPROOF388S — RUNNING must mean a valid live worker
 * identity: a malformed matching record (bad pid, wrong field types) is
 * never emitted as `pid: 0` execution evidence, never hides a usable older
 * match, and turns the claim UNKNOWN rather than a dishonest
 * CLAIMED_NO_WORKER. Readers and the `ps` table are faked or plainly fake
 * fixtures; nothing touches the real home, ledger, processes or network. */
import { describe, expect, it } from 'vitest';
import {
  CLAIM_EXECUTION_SCHEMA,
  joinClaimExecution,
  readClaimExecution,
} from '../src/core/fleet/claim-execution-evidence.js';
import {
  listLiveWorkers,
  type LiveWorker,
  type LiveWorkersSnapshot,
} from '../src/core/fleet/runs-live-workers.js';
import type { FleetBoard, FleetClaim } from '../src/core/fleet/coordination.js';

const NOW = Date.parse('2026-11-14T12:00:00.000Z');
const NOW_ISO = new Date(NOW).toISOString();
const JOB = 'RQ-PHX-FAKEJOB1';
const MALFORMED_REASON = 'matching worker evidence malformed';

function claim(over: Partial<FleetClaim> = {}): FleetClaim {
  return {
    id: JOB, repo: 'ashlrai/phantom', task: 'fake task text',
    agent: 'fake-agent', claimedAt: NOW - 60_000, expiresAt: NOW + 60_000,
    ...over,
  };
}

function board(claims: FleetClaim[], state: 'known' | 'unknown' = 'known'): FleetBoard {
  return { schema: 'fleet.coordination.v1', state, claims, messages: [], proposals: [], expiredClaims: 0 };
}

function worker(over: Partial<LiveWorker> = {}): LiveWorker {
  return {
    pid: 4242, job: JOB, repo: 'phantom', lane: 'devin',
    tier: 'work', ageSeconds: 300, ...over,
  };
}

/** A nominally matching record the process reader could never emit. */
function malformedWorker(over: Record<string, unknown> = {}): LiveWorker {
  return { pid: 0, job: JOB, repo: 'phantom', lane: 'devin', tier: 'work', ageSeconds: 5, ...over } as LiveWorker;
}

function snapshot(
  workers: LiveWorkersSnapshot['workers'],
  sourceState: 'healthy' | 'unavailable' = 'healthy',
): LiveWorkersSnapshot {
  return { v: 1, generatedAt: NOW_ISO, sourceState, workers, leaders: [], orchestratorAgents: 0 };
}

function reportFor(workers: unknown[], claims = [claim()]) {
  return joinClaimExecution(board(claims), snapshot(workers as LiveWorker[]), NOW);
}

describe('joinClaimExecution worker proof', () => {
  it.each([
    ['zero', 0],
    ['negative', -7],
    ['fractional', 12.5],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['-Infinity', Number.NEGATIVE_INFINITY],
    ['unsafe integer', Number.MAX_SAFE_INTEGER + 1],
    ['string', '4242'],
    ['null', null],
    ['undefined', undefined],
    ['object', { pid: 1 }],
  ])('a matching worker with malformed pid (%s) is UNKNOWN, never RUNNING pid 0', (_name, pid) => {
    const report = reportFor([malformedWorker({ pid })]);
    expect(report.processes).toBe('healthy');
    expect(report.rows[0]).toMatchObject({ state: 'UNKNOWN', worker: null, jobId: JOB });
    expect(report.counts).toEqual({ running: 0, claimedNoWorker: 0, unknown: 1 });
    expect(report.reasons).toContain(MALFORMED_REASON);
    expect(JSON.stringify(report)).not.toContain('"pid":0');
  });

  it.each([
    ['non-string lane', { lane: 7 }],
    ['non-string tier', { tier: ['work'] }],
    ['non-string repo', { repo: 42 }],
    ['fractional ageSeconds', { ageSeconds: 1.5 }],
    ['negative ageSeconds', { ageSeconds: -1 }],
    ['nonfinite ageSeconds', { ageSeconds: Number.POSITIVE_INFINITY }],
  ])('a matching worker with contract-broken evidence (%s) is UNKNOWN', (_name, over) => {
    const report = reportFor([malformedWorker({ pid: 99, ...over })]);
    expect(report.rows[0]).toMatchObject({ state: 'UNKNOWN', worker: null });
    expect(report.reasons).toContain(MALFORMED_REASON);
  });

  it('an invalid youngest record cannot hide a valid older matching worker', () => {
    const report = reportFor([
      malformedWorker({ ageSeconds: 1 }),
      worker({ pid: 4242, ageSeconds: 900 }),
    ]);
    expect(report.rows[0]).toMatchObject({
      state: 'RUNNING',
      worker: { pid: 4242, lane: 'devin', tier: 'work', ageSeconds: 900 },
    });
    expect(report.counts.running).toBe(1);
    expect(report.reasons).not.toContain(MALFORMED_REASON);
  });

  it('keeps youngest-wins and first-on-ties selection among valid workers', () => {
    const report = reportFor([
      worker({ pid: 11, ageSeconds: 900 }),
      worker({ pid: 22, ageSeconds: 120 }),
      worker({ pid: 33, ageSeconds: 120 }),
    ]);
    expect(report.rows[0]).toMatchObject({ state: 'RUNNING', worker: { pid: 22 } });
  });

  it('valid unrelated workers neither satisfy the claim nor turn it UNKNOWN', () => {
    const report = reportFor([
      worker({ pid: 77, job: 'RQ-PHX-OTHERJOB9' }),
      worker({ pid: 88, job: JOB, repo: 'locus' }),
      malformedWorker({ job: 'RQ-PHX-OTHERJOB9' }),
    ]);
    expect(report.rows[0]).toMatchObject({ state: 'CLAIMED_NO_WORKER', worker: null });
    expect(report.counts).toEqual({ running: 0, claimedNoWorker: 1, unknown: 0 });
    expect(report.reasons).toEqual([]);
  });

  it('a malformed record for a different repo is no evidence about this claim', () => {
    const report = reportFor([malformedWorker({ repo: 'locus' })]);
    expect(report.rows[0]).toMatchObject({ state: 'CLAIMED_NO_WORKER', worker: null });
    expect(report.reasons).toEqual([]);
  });

  it('expired claims stay excluded even when a malformed record names their job', () => {
    const report = reportFor(
      [malformedWorker({ job: 'RQ-PHX-LIVEJOB3' })],
      [claim({ expiresAt: NOW - 1 }), claim({ id: 'RQ-PHX-LIVEJOB3' })],
    );
    expect(report.rows).toHaveLength(1);
    expect(report.rows[0]!.claimId).toBe('RQ-PHX-LIVEJOB3');
    expect(report.rows[0]).toMatchObject({ state: 'UNKNOWN', worker: null });
    expect(report.reasons).toContain(MALFORMED_REASON);
  });

  it('an unavailable process table keeps every row UNKNOWN with the existing reason', () => {
    const report = joinClaimExecution(
      board([claim()]),
      snapshot([worker()], 'unavailable'),
      NOW,
    );
    expect(report.processes).toBe('unavailable');
    expect(report.rows[0]).toMatchObject({ state: 'UNKNOWN', worker: null });
    expect(report.reasons).toEqual(['process table: unavailable']);
  });

  it('a healthy snapshot whose workers field is not a list is malformed, not empty', () => {
    const bad = { ...snapshot([]), workers: 'oops' } as unknown as LiveWorkersSnapshot;
    const report = joinClaimExecution(board([claim()]), bad, NOW);
    expect(report.rows[0]).toMatchObject({ state: 'UNKNOWN', worker: null });
    expect(report.reasons).toEqual(['process table: malformed worker list']);
    expect(JSON.stringify(report)).not.toContain('"pid":0');
  });

  it('null board and null snapshot inputs still degrade to honest emptiness', () => {
    const report = joinClaimExecution(null, null, NOW);
    expect(report).toMatchObject({
      schema: CLAIM_EXECUTION_SCHEMA, authority: 'none', ledger: 'unavailable',
      processes: 'unavailable', rows: [],
      reasons: ['coordination ledger: missing or unreadable'],
    });
  });
});

describe('reader-to-report round trip', () => {
  const PS_TABLE = [
    '  4242 00:05:00 /Users/fake/.ashlr-runs/bin/launch.sh RQ-PHX-FAKEJOB1 phantom devin work',
    '  5151 00:01:40 /Users/fake/.ashlr-runs/bin/launch.sh RQ-PHX-OTHERJOB9 phantom codex fast',
  ].join('\n');

  it('a malformed sibling record cannot steal a claim from the parsed worker', async () => {
    const parsed = await listLiveWorkers({ runPs: async () => PS_TABLE, now: () => NOW });
    expect(parsed.sourceState).toBe('healthy');
    expect(parsed.workers).toHaveLength(2);
    const workers: unknown[] = [
      { pid: 0, job: JOB, repo: 'phantom', lane: 'devin', tier: 'work', ageSeconds: 1 },
      ...parsed.workers,
    ];
    const report = await readClaimExecution({
      board: () => board([claim()]),
      workers: async () => ({ ...parsed, workers: workers as LiveWorker[] }),
      now: () => NOW,
    });
    expect(report.processes).toBe('healthy');
    expect(report.rows[0]).toMatchObject({
      state: 'RUNNING',
      worker: { pid: 4242, lane: 'devin', tier: 'work', ageSeconds: 300 },
    });
    expect(report.counts).toEqual({ running: 1, claimedNoWorker: 0, unknown: 0 });
  });

  it('a parsed table plus only malformed matching evidence reports UNKNOWN', async () => {
    const parsed = await listLiveWorkers({ runPs: async () => PS_TABLE, now: () => NOW });
    const workers: unknown[] = [
      ...parsed.workers.filter(w => w.job !== JOB),
      malformedWorker(),
    ];
    const report = await readClaimExecution({
      board: () => board([claim()]),
      workers: async () => ({ ...parsed, workers: workers as LiveWorker[] }),
      now: () => NOW,
    });
    expect(report.rows[0]).toMatchObject({ state: 'UNKNOWN', worker: null });
    expect(report.reasons).toContain(MALFORMED_REASON);
    expect(JSON.stringify(report)).not.toContain('"pid":0');
  });

  it('a throwing workers reader still reports the table unavailable', async () => {
    const report = await readClaimExecution({
      board: () => board([claim()]),
      workers: async () => { throw new Error('/Users/fake/secret'); },
      now: () => NOW,
    });
    expect(report.processes).toBe('unavailable');
    expect(report.rows[0]).toMatchObject({ state: 'UNKNOWN', worker: null });
    expect(JSON.stringify(report)).not.toContain('/Users/');
  });
});
