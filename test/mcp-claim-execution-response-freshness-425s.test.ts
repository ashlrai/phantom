/** RQ-PHX-MCPCLAIMFRESH425S — the fleet_claim_execution MCP tool must qualify a
 * settled report's `asOf` at response observation time against the same
 * PROCESS_SNAPSHOT_MAX_AGE_MS bound the verse HTTP API applies: a stamp that
 * parsed at read time but is missing/invalid, ahead of the response clock, or
 * over-age by the time the answer is served — e.g. a board read stalled after
 * the process observation — degrades to the bounded unavailable report with a
 * fixed reason, never retained RUNNING rows/counts under a fresh timestamp.
 * The clock is injected and sequenced; fixtures are plainly fake and nothing
 * touches the real home, `ps` or network. */
import { describe, expect, it, vi } from 'vitest';
import {
  CLAIM_EXECUTION_SCHEMA,
  PROCESS_SNAPSHOT_MAX_AGE_MS,
  type ClaimExecutionDeps,
} from '../src/core/fleet/claim-execution-evidence.js';
import { readFleetClaimExecution } from '../src/mcp/fleet-claim-execution.js';

const T0 = Date.parse('2026-11-14T14:00:00.000Z');
const MAX_AGE = PROCESS_SNAPSHOT_MAX_AGE_MS;
const iso = (ms: number) => new Date(ms).toISOString();
const NOTE = 'Read-only sanitized claim execution evidence: which live advisory claims have a matching worker process on this computer. RUNNING requires a matched worker; otherwise CLAIMED_NO_WORKER or UNKNOWN. Grants no dispatch, claim or merge authority. Accepts no arguments and never writes.';
const OLD_AS_OF_REASON = 'claim execution report: asOf older than freshness bound';
const FUTURE_AS_OF_REASON = 'claim execution report: asOf ahead of response clock';

/** Clock yielding each queued value in turn, then repeating the last — call 1 stamps the report's asOf inside the reader, call 2 is the response observation. */
function sequenceNow(...values: number[]): () => number {
  let calls = 0;
  return () => values[Math.min(calls++, values.length - 1)]!;
}

function fakeBoard() {
  return {
    schema: 'fleet.coordination.v1', state: 'known' as const, messages: [], proposals: [], expiredClaims: 0,
    claims: ['RQ-PHX-FAKEJOB1', 'RQ-PHX-FAKEJOB2'].map(id => ({
      id, agent: 'fake-agent', repo: 'fake-owner/fake-repo', task: 'fake private task text',
      claimedAt: T0 - 60_000, expiresAt: T0 + 60_000,
    })),
  };
}

const healthyWorkers: ClaimExecutionDeps['workers'] = async () => ({
  v: 1, generatedAt: iso(T0), sourceState: 'healthy',
  workers: [{ pid: 123, job: 'RQ-PHX-FAKEJOB1', repo: 'fake-repo', lane: 'fake-lane',
    tier: 'work', ageSeconds: 30 }], leaders: [], orchestratorAgents: 0,
});

function depsWith(now: () => number, board?: ClaimExecutionDeps['board']): ClaimExecutionDeps {
  return { now, board: board ?? (() => fakeBoard()), workers: healthyWorkers };
}

function unavailable(reason: string, asOf: string) {
  return {
    schema: CLAIM_EXECUTION_SCHEMA, authority: 'none' as const, asOf,
    ledger: 'unavailable', processes: 'unavailable', rows: [],
    counts: { running: 0, claimedNoWorker: 0, unknown: 0 },
    reasons: [reason], note: NOTE,
  };
}

const RUNNING_ROWS = [
  { claimId: 'RQ-PHX-FAKEJOB1', agent: 'fake-agent', repo: 'fake-owner/fake-repo',
    jobId: 'RQ-PHX-FAKEJOB1', state: 'RUNNING',
    worker: { pid: 123, lane: 'fake-lane', tier: 'work', ageSeconds: 30 }, expiresInSeconds: 60 },
  { claimId: 'RQ-PHX-FAKEJOB2', agent: 'fake-agent', repo: 'fake-owner/fake-repo',
    jobId: 'RQ-PHX-FAKEJOB2', state: 'CLAIMED_NO_WORKER', worker: null, expiresInSeconds: 60 },
];

describe('fleet_claim_execution response-time asOf freshness', () => {
  it('passes a fresh report through unchanged', async () => {
    const report = await readFleetClaimExecution(depsWith(() => T0));
    expect(report).toEqual({
      schema: 'fleet.claim-execution.v1', authority: 'none', asOf: iso(T0),
      ledger: 'known', processes: 'healthy', rows: RUNNING_ROWS,
      counts: { running: 1, claimedNoWorker: 1, unknown: 0 }, reasons: [], note: NOTE,
    });
  });

  it('keeps a report whose asOf sits exactly at the freshness bound', async () => {
    const report = await readFleetClaimExecution(depsWith(sequenceNow(T0, T0 + MAX_AGE)));
    expect(report).toMatchObject({
      asOf: iso(T0), ledger: 'known', processes: 'healthy', rows: RUNNING_ROWS,
      counts: { running: 1, claimedNoWorker: 1, unknown: 0 }, reasons: [],
    });
  });

  it('degrades a report one ms past the freshness bound without retaining RUNNING evidence', async () => {
    const observed = T0 + MAX_AGE + 1;
    const report = await readFleetClaimExecution(depsWith(sequenceNow(T0, observed)));
    expect(report).toEqual(unavailable(OLD_AS_OF_REASON, iso(observed)));
    const text = JSON.stringify(report);
    expect(text).not.toContain('"state":"RUNNING"');
    expect(text).not.toContain('"pid":123');
    expect(text).not.toContain('fake private task text');
  });

  it('degrades a report stamped ahead of the response clock', async () => {
    const observed = T0 - 1;
    const report = await readFleetClaimExecution(depsWith(sequenceNow(T0, observed)));
    expect(report).toEqual(unavailable(FUTURE_AS_OF_REASON, iso(observed)));
  });

  it('a board read stalled after the process observation cannot advertise old RUNNING evidence', async () => {
    let clock = T0;
    let boardNow: number | undefined;
    const board: ClaimExecutionDeps['board'] = options => {
      boardNow = options?.now;
      clock = T0 + MAX_AGE + 1; // the board read took longer than the freshness bound
      return fakeBoard();
    };
    const report = await readFleetClaimExecution(depsWith(() => clock, board));
    // The join still qualified the claim at T0, but the response clock saw the
    // elapsed stall, so the answer carries no retained RUNNING rows.
    expect(boardNow).toBe(T0);
    expect(report).toEqual(unavailable(OLD_AS_OF_REASON, iso(T0 + MAX_AGE + 1)));
  });

  it.each([
    ['throwing', () => { throw new Error('fake clock exploded /fake/secret-path'); }],
    ['non-finite', () => Number.NaN],
  ])('keeps a %s response clock bounded without leaking exception text', async (_name, bad) => {
    const now = vi.fn()
      .mockImplementationOnce(() => T0)
      .mockImplementationOnce(bad as () => number);
    const report = await readFleetClaimExecution(depsWith(now));
    expect(report).toMatchObject({
      ledger: 'unavailable', processes: 'unavailable', rows: [],
      counts: { running: 0, claimedNoWorker: 0, unknown: 0 }, reasons: [OLD_AS_OF_REASON],
    });
    const text = JSON.stringify(report);
    expect(text).not.toContain('fake clock exploded');
    expect(text).not.toContain('/fake/secret-path');
  });

  it('recovers immediately when the next read observes a fresh stamp', async () => {
    const now = sequenceNow(T0, T0 + MAX_AGE + 1, T0, T0);
    const deps = depsWith(now);
    expect(await readFleetClaimExecution(deps)).toEqual(
      unavailable(OLD_AS_OF_REASON, iso(T0 + MAX_AGE + 1)));
    expect(await readFleetClaimExecution(deps)).toMatchObject({
      ledger: 'known', processes: 'healthy', rows: RUNNING_ROWS,
      counts: { running: 1, claimedNoWorker: 1, unknown: 0 }, reasons: [],
    });
  });
});
