/** RQ-PHX-CLAIMPROCESSFRESH389S — RUNNING must mean a *fresh* process
 * observation: a healthy `LiveWorkersSnapshot` whose `generatedAt` is
 * missing, unparseable, ahead of the join clock, or older than
 * PROCESS_SNAPSHOT_MAX_AGE_MS is a retained snapshot, not live evidence, so
 * every row is UNKNOWN with a fixed sanitized reason — never RUNNING or
 * CLAIMED_NO_WORKER. The check is stateless: a later fresh healthy
 * observation recovers on the next read. The ledger half of the recovery
 * test is a real temporary coordination ledger; everything else is faked.
 * Fixtures are plainly fake; nothing touches the real home, `ps` or
 * network. */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CLAIM_EXECUTION_SCHEMA,
  joinClaimExecution,
  PROCESS_SNAPSHOT_MAX_AGE_MS,
  readClaimExecution,
} from '../src/core/fleet/claim-execution-evidence.js';
import { claimFleetWork, readFleetBoard } from '../src/core/fleet/coordination.js';
import type { FleetBoard, FleetClaim } from '../src/core/fleet/coordination.js';
import type { LiveWorker, LiveWorkersSnapshot } from '../src/core/fleet/runs-live-workers.js';

const NOW = Date.parse('2026-11-14T12:00:00.000Z');
const NOW_ISO = new Date(NOW).toISOString();
const JOB = 'RQ-PHX-FAKEJOB389S';
const STALE_REASON = 'process snapshot: older than freshness bound';
const FUTURE_REASON = 'process snapshot: generatedAt ahead of observation clock';
const INVALID_REASON = 'process snapshot: missing or invalid generatedAt';
const UNAVAILABLE_REASON = 'process table: unavailable';

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

function snapshotAt(generatedAt: unknown, workers: LiveWorker[] = [worker()]): LiveWorkersSnapshot {
  return { v: 1, generatedAt, sourceState: 'healthy', workers, leaders: [], orchestratorAgents: 0 } as LiveWorkersSnapshot;
}

const fresh = () => snapshotAt(NOW_ISO);

describe('joinClaimExecution process snapshot freshness', () => {
  it('accepts a snapshot stamped exactly at the freshness bound', () => {
    const report = joinClaimExecution(
      board([claim()]),
      snapshotAt(new Date(NOW - PROCESS_SNAPSHOT_MAX_AGE_MS).toISOString()),
      NOW,
    );
    expect(report.processes).toBe('healthy');
    expect(report.rows[0]).toMatchObject({
      state: 'RUNNING', worker: { pid: 4242, lane: 'devin', tier: 'work', ageSeconds: 300 },
    });
    expect(report.counts).toEqual({ running: 1, claimedNoWorker: 0, unknown: 0 });
    expect(report.reasons).toEqual([]);
  });

  it('marks every row UNKNOWN when the snapshot is one ms past the bound', () => {
    const report = joinClaimExecution(
      board([claim()]),
      snapshotAt(new Date(NOW - PROCESS_SNAPSHOT_MAX_AGE_MS - 1).toISOString()),
      NOW,
    );
    expect(report).toMatchObject({
      schema: CLAIM_EXECUTION_SCHEMA, authority: 'none', processes: 'unavailable',
      counts: { running: 0, claimedNoWorker: 0, unknown: 1 },
      reasons: [STALE_REASON],
    });
    expect(report.rows[0]).toMatchObject({
      claimId: JOB, jobId: JOB, state: 'UNKNOWN', worker: null, expiresInSeconds: 60,
    });
    expect(JSON.stringify(report)).not.toContain('4242');
  });

  it('marks every row UNKNOWN when generatedAt is ahead of the join clock', () => {
    const report = joinClaimExecution(board([claim()]), snapshotAt(new Date(NOW + 1).toISOString()), NOW);
    expect(report.processes).toBe('unavailable');
    expect(report.rows[0]).toMatchObject({ state: 'UNKNOWN', worker: null, jobId: JOB });
    expect(report.counts).toEqual({ running: 0, claimedNoWorker: 0, unknown: 1 });
    expect(report.reasons).toEqual([FUTURE_REASON]);
  });

  it.each([
    ['empty', ''],
    ['unparseable', 'bogus-389s-stamp'],
    ['missing', undefined],
    ['null', null],
    ['non-string', 42],
  ])('marks every row UNKNOWN when generatedAt is %s', (_name, generatedAt) => {
    const report = joinClaimExecution(board([claim()]), snapshotAt(generatedAt), NOW);
    expect(report.processes).toBe('unavailable');
    expect(report.rows[0]).toMatchObject({ state: 'UNKNOWN', worker: null });
    expect(report.counts).toEqual({ running: 0, claimedNoWorker: 0, unknown: 1 });
    expect(report.reasons).toEqual([INVALID_REASON]);
    expect(JSON.stringify(report)).not.toContain('bogus-389s-stamp');
  });

  it('keeps the unavailable-source reason for a non-healthy snapshot regardless of stamp', () => {
    const report = joinClaimExecution(
      board([claim()]),
      { ...fresh(), sourceState: 'unavailable' },
      NOW,
    );
    expect(report.processes).toBe('unavailable');
    expect(report.rows[0]).toMatchObject({ state: 'UNKNOWN', worker: null });
    expect(report.reasons).toEqual([UNAVAILABLE_REASON]);
  });

  it('a stale snapshot never yields CLAIMED_NO_WORKER even with no matching worker', () => {
    const report = joinClaimExecution(
      board([claim()]),
      snapshotAt(new Date(NOW - PROCESS_SNAPSHOT_MAX_AGE_MS - 1).toISOString(), [worker({ job: 'RQ-PHX-OTHERJOB9' })]),
      NOW,
    );
    expect(report.rows[0]).toMatchObject({ state: 'UNKNOWN', worker: null });
    expect(report.counts).toEqual({ running: 0, claimedNoWorker: 0, unknown: 1 });
  });
});

describe('readClaimExecution freshness on a real temporary ledger', () => {
  it('a stale observation degrades to UNKNOWN and a fresh one recovers without sticky failure', async () => {
    const root = mkdtempSync(join(tmpdir(), 'claim-process-freshness-'));
    const path = join(root, 'coordination.jsonl');
    try {
      const taken = claimFleetWork(
        { repo: 'ashlrai/phantom', task: `fake work tracking ${JOB}`, agent: 'fake-agent', ttlMs: 3_600_000 },
        { path, now: NOW - 60_000 },
      );
      if (!taken.ok) throw new Error('fixture claim failed');
      const deps = {
        board: (o?: { now?: number }) => readFleetBoard({ path, now: o?.now ?? NOW }),
        now: () => NOW,
      };
      const stale = await readClaimExecution({
        ...deps,
        workers: async () => snapshotAt(new Date(NOW - PROCESS_SNAPSHOT_MAX_AGE_MS - 1).toISOString()),
      });
      expect(stale).toMatchObject({
        schema: CLAIM_EXECUTION_SCHEMA, authority: 'none', asOf: NOW_ISO,
        ledger: 'known', processes: 'unavailable',
        counts: { running: 0, claimedNoWorker: 0, unknown: 1 },
        reasons: [STALE_REASON],
      });
      // Claim identity and expiry stay readable while process evidence is out.
      expect(stale.rows[0]).toMatchObject({
        claimId: taken.value.claim.id, jobId: JOB, agent: 'fake-agent',
        repo: 'ashlrai/phantom', state: 'UNKNOWN', worker: null, expiresInSeconds: 3_540,
      });
      const freshReport = await readClaimExecution({ ...deps, workers: async () => fresh() });
      expect(freshReport).toMatchObject({
        ledger: 'known', processes: 'healthy',
        counts: { running: 1, claimedNoWorker: 0, unknown: 0 },
        reasons: [],
      });
      expect(freshReport.rows[0]).toMatchObject({
        claimId: taken.value.claim.id, state: 'RUNNING',
        worker: { pid: 4242, lane: 'devin', tier: 'work', ageSeconds: 300 },
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
