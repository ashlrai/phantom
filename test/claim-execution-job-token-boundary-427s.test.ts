import { describe, expect, it } from 'vitest';
import { joinClaimExecution } from '../src/core/fleet/claim-execution-evidence.js';
import type { FleetBoard, FleetClaim } from '../src/core/fleet/coordination.js';
import type { LiveWorker, LiveWorkersSnapshot } from '../src/core/fleet/runs-live-workers.js';

const now = Date.parse('2026-11-15T12:00:00Z');
// Longest supported token: 'RQ-' + 81 body chars = 84 chars total.
const MAX_JOB = 'RQ-PHX-CLAIM-TOKEN-BOUNDARY-427S-PHX-CLAIM-TOKEN-BOUNDARY-427S-PHXCLAIMTOKENBND427SX';
// One character past the limit is a hyphen, so the old \b-terminated pattern
// settled on MAX_JOB as a prefix of this longer token.
const OVER_JOB = `${MAX_JOB}-OVERFLOW427S`;

const worker = (job: string, pid = 42): LiveWorker => ({
  pid, repo: 'phantom', job, lane: 'fake', tier: 'work', ageSeconds: 10,
});

function join(claims: FleetClaim[], workers: LiveWorker[]) {
  const board: FleetBoard = { schema: 'fleet.coordination.v1', state: 'known', claims, messages: [], proposals: [], expiredClaims: 0 };
  const snapshot: LiveWorkersSnapshot = { v: 1, generatedAt: new Date(now).toISOString(), sourceState: 'healthy', workers, leaders: [], orchestratorAgents: 0 };
  return joinClaimExecution(board, snapshot, now);
}

const claim = (over: Partial<FleetClaim>): FleetClaim => ({
  id: 'fake-claim-427s', repo: 'ashlrai/phantom', task: 'fake task',
  agent: 'fake-agent', claimedAt: now - 1_000, expiresAt: now + 60_000, ...over,
});

describe('claim execution job token boundary', () => {
  it('does not borrow the truncated-prefix worker for an overlength token', () => {
    const report = join(
      [claim({ id: OVER_JOB })],
      [worker(MAX_JOB, 42), worker(OVER_JOB, 43)],
    );
    expect(report.rows[0]).toMatchObject({ jobId: null, state: 'UNKNOWN', worker: null });
    expect(report.counts).toEqual({ running: 0, claimedNoWorker: 0, unknown: 1 });
    expect(report.reasons).toEqual(['claim names no job id']);
  });

  it('accepts a valid maximum-length job id', () => {
    const report = join([claim({ id: MAX_JOB })], [worker(MAX_JOB, 42)]);
    expect(report.rows[0]).toMatchObject({ jobId: MAX_JOB, state: 'RUNNING', worker: { pid: 42 } });
    expect(report.counts).toEqual({ running: 1, claimedNoWorker: 0, unknown: 0 });
  });

  it('matches ordinary punctuation-delimited tokens in claim text', () => {
    for (const task of [
      'watch (RQ-PHX-FAKE427S, please)',
      'job RQ-PHX-FAKE427S- done',
      'see RQ-PHX-FAKE427S.',
    ]) {
      const report = join([claim({ task })], [worker('RQ-PHX-FAKE427S', 42)]);
      expect(report.rows[0]).toMatchObject({ jobId: 'RQ-PHX-FAKE427S', state: 'RUNNING', worker: { pid: 42 } });
    }
  });

  it('keeps exact valid id precedence over the task token', () => {
    const report = join(
      [claim({ id: 'RQ-PHX-ID427S', task: 'notes about RQ-PHX-TASK427S' })],
      [worker('RQ-PHX-ID427S', 42), worker('RQ-PHX-TASK427S', 43)],
    );
    expect(report.rows[0]).toMatchObject({ jobId: 'RQ-PHX-ID427S', state: 'RUNNING', worker: { pid: 42 } });
  });

  it('skips an overlength token and still finds a later whole token', () => {
    const report = join(
      [claim({ task: `${OVER_JOB} then RQ-PHX-LATER427S` })],
      [worker(MAX_JOB, 42), worker('RQ-PHX-LATER427S', 43)],
    );
    expect(report.rows[0]).toMatchObject({ jobId: 'RQ-PHX-LATER427S', state: 'RUNNING', worker: { pid: 43 } });
  });

  it('does not treat a lowercase-adjacent run as a job token', () => {
    const report = join([claim({ task: 'see RQ-PHX-ADJ427Sx now' })], [worker('RQ-PHX-ADJ427S', 42)]);
    expect(report.rows[0]).toMatchObject({ jobId: null, state: 'UNKNOWN', worker: null });
    expect(report.reasons).toEqual(['claim names no job id']);
  });
});
