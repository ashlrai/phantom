/**
 * RQ-PHX-RUNTIMEOBSERVATIONCLOCK392S — the advertised observation instant is the
 * claim-execution join's own post-read clock, not the frozen entry instant that
 * made fresh generatedAt read as future-dated. These tests run the REAL default
 * join and the REAL single captured board; only the filesystem root, the clock
 * and the process table are substituted.
 */
import { mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FleetBoard } from '../src/core/fleet/coordination.js';
import * as workers from '../src/core/fleet/runs-live-workers.js';
import { defaults, readRuntimeSnapshot, type FleetRuntimeDeps } from '../src/core/fleet/runtime-snapshot.js';

const NOW = Date.parse('2026-11-14T20:00:00.000Z');
const READ_MS = 2_000; // what the worker read costs on the observation clock
const iso = (ms: number): string => new Date(ms).toISOString();
const claim = (id: string, expiresInMs = 60_000) => ({
  id, repo: 'fake/repo', task: 'fake private task text', agent: 'fake-agent',
  claimedAt: NOW - 60_000, expiresAt: NOW + expiresInMs,
});
const board = (...claims: ReturnType<typeof claim>[]): FleetBoard => ({
  schema: 'fleet.coordination.v1', state: 'known', expiredClaims: 0, messages: [], proposals: [], claims,
});
const liveWorker = (job: string, pid = 100): workers.LiveWorker => ({
  job, pid, repo: 'repo', lane: 'fake', tier: 'work', ageSeconds: 1,
});
const ps = (list: workers.LiveWorker[], generatedAt: number): workers.LiveWorkersSnapshot =>
  ({ v: 1, generatedAt: iso(generatedAt), sourceState: 'healthy', leaders: [], orchestratorAgents: 0, workers: list });

let root: string;
let now: number;
function deps(readBoard: FleetRuntimeDeps['board'], clock: () => number = () => now): FleetRuntimeDeps {
  return {
    now: clock, home: () => root, stateRoot: () => root,
    host: () => 'fake-host', tailnet: () => 'fake-tailnet', installedVersion: () => '1.0.0',
    sourceVersion: () => '1.0.0', pid: () => 123, uptime: () => 10,
    platform: () => 'fake-os', arch: () => 'fake-arch', board: readBoard,
  };
}
/** A worker reader that costs READ_MS of clock, like the bounded real `ps` read. */
const advancingWorkers = (list: workers.LiveWorker[], generatedAt?: () => number) => async () => {
  const stamped = now;
  now += READ_MS;
  return ps(list, generatedAt?.() ?? stamped);
};

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'runtime-elapsed-392s-'));
  const state = join(root, 'fake-state');
  await writeFile(state, 'fake');
  await utimes(state, (NOW - 30_000) / 1000, (NOW - 30_000) / 1000);
  now = NOW;
  vi.spyOn(workers, 'listLiveWorkers').mockImplementation(advancingWorkers([liveWorker('RQ-FAKE-TWO')]));
  // The production seam routes the join's board read through defaults.board.
  vi.spyOn(defaults, 'board').mockImplementation(() => { throw new Error('wrong board'); });
  vi.spyOn(defaults, 'now');
});
afterEach(async () => { vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }); });

describe('elapsed observation clock', () => {
  it.each(['omitted', 'production'] as const)(
    'joins the real default reader at the post-read instant with %s execution', async mode => {
      const readBoard = vi.fn(() => board(claim('RQ-FAKE-ONE'), claim('RQ-FAKE-TWO')));
      if (mode === 'production') vi.mocked(defaults.board).mockImplementation(readBoard);
      const clock = vi.fn(() => now);
      const options = mode === 'production'
        ? { ...deps(defaults.board, clock), execution: defaults.execution }
        : deps(readBoard, clock);
      const snapshot = await readRuntimeSnapshot(options);
      // One board read at the entry instant serves coordination and the join.
      expect(readBoard).toHaveBeenCalledExactlyOnceWith({ now: NOW });
      if (mode === 'omitted') expect(defaults.board).not.toHaveBeenCalled();
      // The injected clock is sampled at entry and again inside the join after
      // the worker read — never frozen, never defaults.now.
      expect(clock).toHaveBeenCalledTimes(2);
      expect(defaults.now).not.toHaveBeenCalled();
      // asOf and the counts describe the post-read instant; ages too (32s not 30s).
      expect(snapshot.asOf).toBe(iso(NOW + READ_MS));
      expect(snapshot.lastFleetStateRead.ageSeconds).toBe(32);
      expect(snapshot.coordination.activeClaims).toBe(2);
      expect(snapshot.execution).toEqual({ state: 'known', running: 1, claimedNoWorker: 1, unknown: 0 });
      const serialized = JSON.stringify(snapshot);
      for (const privateText of ['fake private task text', root]) expect(serialized).not.toContain(privateText);
      // A second request captures a fresh board and a fresh instant.
      const second = await readRuntimeSnapshot(options);
      expect(readBoard).toHaveBeenCalledTimes(2);
      expect(second.asOf).toBe(iso(NOW + 2 * READ_MS));
      expect(second.execution).toEqual({ state: 'known', running: 1, claimedNoWorker: 1, unknown: 0 });
    });

  it('never counts a claim expiring during the worker read as live or RUNNING at asOf', async () => {
    // RQ-FAKE-ONE dies inside the read window even though a worker matches it.
    const readBoard = vi.fn(() => board(claim('RQ-FAKE-ONE', READ_MS - 1), claim('RQ-FAKE-TWO')));
    vi.mocked(workers.listLiveWorkers).mockImplementation(
      advancingWorkers([liveWorker('RQ-FAKE-ONE', 101), liveWorker('RQ-FAKE-TWO', 102)]));
    const snapshot = await readRuntimeSnapshot(deps(readBoard));
    expect(snapshot.asOf).toBe(iso(NOW + READ_MS));
    expect(snapshot.coordination.activeClaims).toBe(1);
    expect(snapshot.execution).toEqual({ state: 'known', running: 1, claimedNoWorker: 0, unknown: 0 });
  });

  it.each(['future', 'stale'] as const)('keeps a %s process snapshot unavailable at the join instant', async mode => {
    const offset = mode === 'future' ? 30_000 : -120_000;
    vi.mocked(workers.listLiveWorkers).mockImplementation(
      advancingWorkers([liveWorker('RQ-FAKE-TWO')], () => now + offset));
    const readBoard = vi.fn(() => board(claim('RQ-FAKE-ONE'), claim('RQ-FAKE-TWO')));
    const snapshot = await readRuntimeSnapshot(deps(readBoard));
    expect(snapshot.asOf).toBe(iso(NOW + READ_MS));
    expect(snapshot.coordination.activeClaims).toBe(2);
    expect(snapshot.execution).toEqual({ state: 'UNKNOWN', running: 0, claimedNoWorker: 0, unknown: 2,
      reason: 'execution: process table unavailable' });
  });

  it('recovers actual RUNNING evidence on the read after a failed process read', async () => {
    vi.mocked(workers.listLiveWorkers)
      .mockRejectedValueOnce(new Error('fake private process failure /fake-private-path'))
      .mockImplementation(advancingWorkers([liveWorker('RQ-FAKE-TWO')]));
    const readBoard = vi.fn(() => board(claim('RQ-FAKE-ONE'), claim('RQ-FAKE-TWO')));
    const options = deps(readBoard);
    const first = await readRuntimeSnapshot(options);
    expect(first.asOf).toBe(iso(NOW)); // the worker reader never advanced the clock
    expect(first.execution).toEqual({ state: 'UNKNOWN', running: 0, claimedNoWorker: 0, unknown: 2,
      reason: 'execution: process table unavailable' });
    expect(JSON.stringify(first)).not.toMatch(/fake private process failure|\/fake-private-path/);
    const next = await readRuntimeSnapshot(options);
    expect(next.execution).toEqual({ state: 'known', running: 1, claimedNoWorker: 1, unknown: 0 });
    expect(readBoard).toHaveBeenCalledTimes(2);
  });
});
