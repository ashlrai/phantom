/**
 * RQ-PHX-RUNTIMECLAIMVALID424S — coordination.activeClaims applies the same
 * temporal qualification as the claim-execution join: only claims whose
 * claimedAt/expiresAt are valid epoch milliseconds, with expiresAt strictly
 * after claimedAt and claimedAt at or before the settled asOf instant, count
 * as live. Future-dated, reversed, expired and malformed timestamp records
 * never inflate the summary while the execution report drops them. These
 * tests run the REAL default join over the REAL single captured board; only
 * the filesystem root, the clock and the process table are substituted.
 */
import { mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { joinClaimExecution } from '../src/core/fleet/claim-execution-evidence.js';
import type { FleetBoard, FleetClaim } from '../src/core/fleet/coordination.js';
import * as workers from '../src/core/fleet/runs-live-workers.js';
import { defaults, readRuntimeSnapshot, type FleetRuntimeDeps } from '../src/core/fleet/runtime-snapshot.js';

const NOW = Date.parse('2026-11-14T20:00:00.000Z');
const READ_MS = 2_000; // what the worker read costs on the observation clock
const iso = (ms: number): string => new Date(ms).toISOString();
const claim = (id: string, claimedAt: number, expiresAt: number): FleetClaim => ({
  id, repo: 'fake/repo', task: 'fake private task text', agent: 'fake-agent', claimedAt, expiresAt,
});
const board = (...claims: FleetClaim[]): FleetBoard => ({
  schema: 'fleet.coordination.v1', state: 'known', expiredClaims: 0, messages: [], proposals: [], claims,
});
const liveWorker = (job: string, pid = 100): workers.LiveWorker => ({
  job, pid, repo: 'repo', lane: 'fake', tier: 'work', ageSeconds: 1,
});
const processSnapshot = (list: workers.LiveWorker[], generatedAt: number): workers.LiveWorkersSnapshot =>
  ({ v: 1, generatedAt: iso(generatedAt), sourceState: 'healthy', leaders: [], orchestratorAgents: 0, workers: list });

let root: string;
let now: number;
function deps(readBoard: FleetRuntimeDeps['board']): FleetRuntimeDeps {
  return {
    now: () => now, home: () => root, stateRoot: () => root,
    host: () => 'fake-host', tailnet: () => 'fake-tailnet', installedVersion: () => '1.0.0',
    sourceVersion: () => '1.0.0', pid: () => 123, uptime: () => 10,
    platform: () => 'fake-os', arch: () => 'fake-arch', board: readBoard,
  };
}
/** A worker reader that costs READ_MS of clock, like the bounded real `ps` read. */
const advancingWorkers = (list: workers.LiveWorker[]) => async () => {
  const stamped = now;
  now += READ_MS;
  return processSnapshot(list, stamped);
};

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'runtime-claim-valid-424s-'));
  const state = join(root, 'fake-state');
  await writeFile(state, 'fake');
  await utimes(state, (NOW - 30_000) / 1000, (NOW - 30_000) / 1000);
  now = NOW;
  vi.spyOn(workers, 'listLiveWorkers').mockImplementation(advancingWorkers([liveWorker('RQ-FAKE-ONE')]));
  // The production seam routes the join's board read through defaults.board;
  // throwing here proves the captured board is the one both readers share.
  vi.spyOn(defaults, 'board').mockImplementation(() => { throw new Error('wrong board'); });
});
afterEach(async () => { vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }); });

describe('runtime snapshot claim temporal validity', () => {
  it('counts only temporally qualified live claims at the settled asOf', async () => {
    const claims = [
      claim('RQ-FAKE-ONE', NOW - 60_000, NOW + 60_000), // the one valid live claim
      claim('RQ-FAKE-FUTURE', NOW + 120_000, NOW + 180_000), // claimedAt ahead of asOf
      claim('RQ-FAKE-REVERSED', NOW + 120_000, NOW + 60_000), // expiresAt <= claimedAt, still ahead of asOf
      claim('RQ-FAKE-EXPIRED', NOW - 120_000, NOW - 1_000), // sane interval already ended
      claim('RQ-FAKE-INFINITE', NOW - 60_000, Number.POSITIVE_INFINITY),
      claim('RQ-FAKE-FRACTION', NOW - 60_000, NOW + 60_000.5),
      claim('RQ-FAKE-RANGE', NOW - 60_000, 8_640_000_000_000_001),
      claim('RQ-FAKE-NAN', Number.NaN, NOW + 60_000),
      claim('RQ-FAKE-FUTURECLAIM', NOW + 60_000.5, NOW + 120_000),
      { ...claim('RQ-FAKE-STRING', NOW - 60_000, NOW + 60_000), expiresAt: String(NOW + 60_000) } as unknown as FleetClaim,
    ];
    const readBoard = vi.fn(() => board(...claims));
    const snapshot = await readRuntimeSnapshot(deps(readBoard));
    expect(readBoard).toHaveBeenCalledExactlyOnceWith({ now: NOW });
    expect(snapshot.asOf).toBe(iso(NOW + READ_MS));
    expect(snapshot.coordination.activeClaims).toBe(1);
    // Timestamp consistency: the summary count and the execution join agree on
    // the same settled instant, and no invalid record invents a RUNNING row.
    const expected = joinClaimExecution(board(...claims), processSnapshot([liveWorker('RQ-FAKE-ONE')], NOW), NOW + READ_MS);
    expect(expected.rows).toHaveLength(1);
    expect(expected.rows[0]).toMatchObject({ claimId: 'RQ-FAKE-ONE', state: 'RUNNING' });
    expect(snapshot.execution).toEqual({ state: 'known', ...expected.counts });
    expect(snapshot.execution).toEqual({ state: 'known', running: 1, claimedNoWorker: 0, unknown: 0 });
    const serialized = JSON.stringify(snapshot);
    expect(serialized).not.toContain('fake private task text');
    expect(serialized).not.toContain('RQ-FAKE-FUTURE');
  });

  it('drops a claim that expires while the worker read settles', async () => {
    const claims = [
      claim('RQ-FAKE-DYING', NOW - 60_000, NOW + READ_MS - 1), // dead at asOf, alive at entry
      claim('RQ-FAKE-STABLE', NOW - 60_000, NOW + 60_000),
    ];
    vi.mocked(workers.listLiveWorkers).mockImplementation(
      advancingWorkers([liveWorker('RQ-FAKE-DYING', 101), liveWorker('RQ-FAKE-STABLE', 102)]));
    const snapshot = await readRuntimeSnapshot(deps(() => board(...claims)));
    expect(snapshot.asOf).toBe(iso(NOW + READ_MS));
    expect(snapshot.coordination.activeClaims).toBe(1);
    // The expired claim produces no row and no RUNNING evidence at asOf.
    const expected = joinClaimExecution(board(...claims),
      processSnapshot([liveWorker('RQ-FAKE-DYING', 101), liveWorker('RQ-FAKE-STABLE', 102)], NOW), NOW + READ_MS);
    expect(expected.rows).toHaveLength(1);
    expect(expected.rows[0]).toMatchObject({ claimId: 'RQ-FAKE-STABLE', state: 'RUNNING' });
    expect(snapshot.execution).toEqual({ state: 'known', ...expected.counts });
    expect(snapshot.execution).toEqual({ state: 'known', running: 1, claimedNoWorker: 0, unknown: 0 });
  });

  it('counts more than fifty valid claims without the execution row cap', async () => {
    const claims = Array.from({ length: 60 }, (_, i) =>
      claim(`RQ-FAKE-${String(i + 1).padStart(3, '0')}`, NOW - 60_000, NOW + 60_000));
    vi.mocked(workers.listLiveWorkers).mockImplementation(advancingWorkers([]));
    const snapshot = await readRuntimeSnapshot(deps(() => board(...claims)));
    expect(snapshot.asOf).toBe(iso(NOW + READ_MS));
    // The summary count is uncapped; only the execution rows cap at 50.
    expect(snapshot.coordination.activeClaims).toBe(60);
    const expected = joinClaimExecution(board(...claims), processSnapshot([], NOW), NOW + READ_MS);
    expect(expected.rows).toHaveLength(50);
    expect(snapshot.execution).toEqual({ state: 'known', ...expected.counts });
    expect(snapshot.execution).toEqual({ state: 'known', running: 0, claimedNoWorker: 50, unknown: 0 });
  });

  it('recovers valid claim evidence on the next read after a degraded one', async () => {
    const claims = [claim('RQ-FAKE-ONE', NOW - 60_000, NOW + 60_000)];
    const readBoard = vi.fn()
      .mockImplementationOnce(() => { throw new Error('fake private board failure'); })
      .mockImplementation(() => board(...claims));
    const options = deps(readBoard);
    const first = await readRuntimeSnapshot(options);
    expect(first.coordination).toMatchObject({ state: 'UNKNOWN', activeClaims: 'UNKNOWN' });
    expect(first.execution).toEqual({ state: 'UNKNOWN', running: 0, claimedNoWorker: 0, unknown: 0,
      reason: 'execution: ledger unavailable' });
    expect(JSON.stringify(first)).not.toContain('fake private board failure');
    const next = await readRuntimeSnapshot(options);
    expect(readBoard).toHaveBeenCalledTimes(2);
    expect(next.asOf).toBe(iso(NOW + 2 * READ_MS));
    expect(next.coordination.activeClaims).toBe(1);
    expect(next.execution).toEqual({ state: 'known', running: 1, claimedNoWorker: 0, unknown: 0 });
  });
});
