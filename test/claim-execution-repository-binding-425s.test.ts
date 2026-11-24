import { describe, expect, it } from 'vitest';
import { joinClaimExecution } from '../src/core/fleet/claim-execution-evidence.js';
import type { FleetBoard, FleetClaim } from '../src/core/fleet/coordination.js';
import type { LiveWorker, LiveWorkersSnapshot } from '../src/core/fleet/runs-live-workers.js';

const now = Date.parse('2026-11-15T12:00:00Z');
const job = 'RQ-PHX-FAKE425S';
const worker = (repo: string, pid = 42): LiveWorker => ({
  pid, repo, job, lane: 'fake', tier: 'work', ageSeconds: 10,
});
function join(repo: string, workers: LiveWorker[]) {
  const claim: FleetClaim = { id: job, repo, task: 'fake', agent: 'fake', claimedAt: now - 1, expiresAt: now + 60_000 };
  const board: FleetBoard = { schema: 'fleet.coordination.v1', state: 'known', claims: [claim], messages: [], proposals: [], expiredClaims: 0 };
  const snapshot: LiveWorkersSnapshot = { v: 1, generatedAt: new Date(now).toISOString(), sourceState: 'healthy', workers, leaders: [], orchestratorAgents: 0 };
  return joinClaimExecution(board, snapshot, now);
}

describe('claim execution repository binding', () => {
  it.each([['', 'phantom'], ['ashlrai/phantom', ''], ['bad//identity', 'phantom'], ['ashlrai/phantom', 'bad//identity']])(
  'reports unknown for invalid repository identities', (claimRepo, workerRepo) => {
    const report = join(claimRepo, [worker(workerRepo)]);
    expect(report.rows[0]).toMatchObject({ state: 'UNKNOWN', worker: null });
    expect(report.counts).toEqual({ running: 0, claimedNoWorker: 0, unknown: 1 });
    expect(report.reasons).toEqual(['repository identity invalid']);
    expect(JSON.stringify(report)).not.toContain('bad//identity');
  });
  it.each([['ashlrai/phantom', 'other/phantom'], ['ashlrai/phantom', 'other']])(
  'treats different valid repositories as nonmatches', (claimRepo, workerRepo) => {
    const report = join(claimRepo, [worker(workerRepo)]);
    expect(report.rows[0]).toMatchObject({ state: 'CLAIMED_NO_WORKER', worker: null });
    expect(report.counts).toEqual({ running: 0, claimedNoWorker: 1, unknown: 0 });
  });
  it.each([['ashlrai/phantom', 'phantom'], ['phantom', 'ashlrai/phantom'], ['ashlrai/phantom', 'ashlrai/phantom']])(
  'accepts compatible repository identities', (claimRepo, workerRepo) => {
    const report = join(claimRepo, [worker(workerRepo)]);
    expect(report.rows[0]).toMatchObject({ state: 'RUNNING', worker: { pid: 42 } });
    expect(report.counts).toEqual({ running: 1, claimedNoWorker: 0, unknown: 0 });
  });
  it('selects a correctly bound worker despite malformed same-job evidence', () => {
    const report = join('ashlrai/phantom', [worker('', 1), worker('phantom', 2)]);
    expect(report.rows[0]).toMatchObject({ state: 'RUNNING', worker: { pid: 2 } });
    expect(report.counts).toEqual({ running: 1, claimedNoWorker: 0, unknown: 0 });
    expect(report.reasons).toEqual([]);
  });
});
