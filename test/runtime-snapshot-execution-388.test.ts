import { afterEach, describe, expect, it, vi } from 'vitest';
import { readClaimExecution, type ClaimExecutionReport } from '../src/core/fleet/claim-execution-evidence.js';
import type { FleetBoard } from '../src/core/fleet/coordination.js';
import * as workers from '../src/core/fleet/runs-live-workers.js';
import { defaults, readRuntimeSnapshot, type FleetRuntimeDeps, type RuntimeSnapshot } from '../src/core/fleet/runtime-snapshot.js';
import { formatRuntimeStatusLines } from '../src/core/fleet/runtime-status-lines.js';

const NOW = Date.parse('2026-11-14T20:00:00.000Z');
const board = (unnamed = false): FleetBoard => ({
  schema: 'fleet.coordination.v1', state: 'known', expiredClaims: 0, messages: [], proposals: [],
  claims: ['RQ-FAKE-ONE', 'RQ-FAKE-TWO', 'RQ-FAKE-THREE', ...(unnamed ? ['fake-unnamed'] : [])]
    .map(id => ({ id, repo: 'fake/repo', task: 'fake task', agent: 'fake-agent',
      claimedAt: NOW - 1_000, expiresAt: NOW + 60_000 })),
});
const workerSnapshot = (sourceState: 'healthy' | 'unavailable' = 'healthy'): workers.LiveWorkersSnapshot => ({
  v: 1, generatedAt: new Date(NOW).toISOString(), sourceState, leaders: [], orchestratorAgents: 0,
  workers: ['RQ-FAKE-ONE', 'RQ-FAKE-TWO'].map((job, index) => ({
    job, pid: 100 + index, repo: 'repo', lane: 'fake', tier: 'work', ageSeconds: 10,
  })),
});
function fakeDeps(over: Partial<FleetRuntimeDeps> = {}): FleetRuntimeDeps {
  const readBoard = () => board();
  return {
    now: () => NOW, home: () => '/fake-home',
    stateRoot: () => { throw new Error('fake unresolved root'); },
    host: () => 'fake-host', tailnet: () => 'fake-tailnet',
    installedVersion: () => '1.0.0', sourceVersion: () => '1.0.0',
    pid: () => 123, uptime: () => 10, platform: () => 'fake-os', arch: () => 'fake-arch',
    board: readBoard,
    execution: () => readClaimExecution({ board: readBoard, workers: async () => workerSnapshot(), now: () => NOW }),
    ...over,
  };
}

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('runtime snapshot execution evidence', () => {
  it('joins fake workers with live claims and formats the measured counts', async () => {
    const snapshot = await readRuntimeSnapshot(fakeDeps());
    expect(snapshot.execution).toEqual({ state: 'known', running: 2, claimedNoWorker: 1, unknown: 0 });
    expect(snapshot.coordination).toEqual({ state: 'known', activeClaims: 3, newestReturnAgeSeconds: 'UNKNOWN',
      reason: 'no readable retained return at or before asOf' });
    expect(formatRuntimeStatusLines({ ...snapshot,
      coordination: { ...snapshot.coordination, newestReturnAgeSeconds: 7 },
    })[2]).toBe('Claims: 3 live (2 running, 1 no worker), newest return 7s ago');
    expect(JSON.parse(JSON.stringify(snapshot)).execution).toEqual(snapshot.execution);
  });

  it('includes unknown rows only when the healthy join has unnamed claims', async () => {
    const snapshot = await readRuntimeSnapshot(fakeDeps({
      board: () => board(true),
      execution: () => readClaimExecution({ board: () => board(true), workers: async () => workerSnapshot(), now: () => NOW }),
    }));
    expect(snapshot.execution).toEqual({ state: 'known', running: 2, claimedNoWorker: 1, unknown: 1 });
    expect(formatRuntimeStatusLines(snapshot)[2]).toBe(
      'Claims: 4 live (2 running, 1 no worker, 1 unknown), newest return UNKNOWN (no readable retained return at or before asOf)',
    );
  });

  it('uses the default board and clock for the default execution reader', async () => {
    const readBoard = vi.spyOn(defaults, 'board').mockImplementation(() => board());
    vi.spyOn(defaults, 'now').mockReturnValue(NOW);
    const readWorkers = vi.spyOn(workers, 'listLiveWorkers').mockResolvedValue(workerSnapshot());
    const snapshot = await readRuntimeSnapshot(fakeDeps({ execution: defaults.execution }));
    expect(snapshot.execution).toEqual({ state: 'known', running: 2, claimedNoWorker: 1, unknown: 0 });
    expect(readBoard).toHaveBeenCalledWith({ now: NOW });
    expect(readWorkers).toHaveBeenCalledTimes(1);
  });

  it('reports an unavailable process table without calling claims RUNNING', async () => {
    const snapshot = await readRuntimeSnapshot(fakeDeps({
      execution: () => readClaimExecution({ board: () => board(), workers: async () => workerSnapshot('unavailable'), now: () => NOW }),
    }));
    expect(snapshot.execution).toEqual({ state: 'UNKNOWN', running: 0, claimedNoWorker: 0, unknown: 3,
      reason: 'execution: process table unavailable' });
    expect(snapshot.coordination.activeClaims).toBe(3);
    expect(formatRuntimeStatusLines(snapshot)[2]).toBe(
      'Claims: 3 live, newest return UNKNOWN (no readable retained return at or before asOf) (running UNKNOWN: execution: process table unavailable)',
    );
  });

  it('keeps an unavailable execution ledger separate from the coordination read', async () => {
    const snapshot = await readRuntimeSnapshot(fakeDeps({
      execution: () => readClaimExecution({ board: () => ({ ...board(), state: 'unknown' }),
        workers: async () => workerSnapshot(), now: () => NOW }),
    }));
    expect(snapshot.execution).toEqual({ state: 'UNKNOWN', running: 0, claimedNoWorker: 0, unknown: 0,
      reason: 'execution: ledger unavailable' });
    expect(snapshot.coordination.activeClaims).toBe(3);
  });

  it.each(['throw', 'reject'])('contains a reader %s with a fixed reason', async mode => {
    const snapshot = await readRuntimeSnapshot(fakeDeps({ execution: () => {
      if (mode === 'throw') throw new Error('fake private exception');
      return Promise.reject(new Error('fake private exception'));
    } }));
    expect(snapshot.execution).toEqual({ state: 'UNKNOWN', running: 0, claimedNoWorker: 0, unknown: 0,
      reason: 'execution: read failed' });
    expect(snapshot.coordination.activeClaims).toBe(3);
    expect(JSON.stringify(snapshot)).not.toContain('fake private exception');
  });

  it('bounds a never-resolving read at 2000ms and clears its timer', async () => {
    vi.useFakeTimers();
    let settled = false;
    const pending = readRuntimeSnapshot(fakeDeps({ execution: () => new Promise<ClaimExecutionReport>(() => {}) }))
      .then(snapshot => { settled = true; return snapshot; });
    await vi.advanceTimersByTimeAsync(1_999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const snapshot = await pending;
    expect(snapshot.execution).toEqual({ state: 'UNKNOWN', running: 0, claimedNoWorker: 0, unknown: 0,
      reason: 'execution: read deadline exceeded' });
    expect(snapshot.coordination.activeClaims).toBe(3);
    expect(vi.getTimerCount()).toBe(0);
    expect((await readRuntimeSnapshot(fakeDeps())).execution?.state).toBe('known');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('consumes a late rejection after its execution deadline', async () => {
    vi.useFakeTimers();
    let rejectRead!: (error: Error) => void;
    const pending = readRuntimeSnapshot(fakeDeps({ execution: () => new Promise<ClaimExecutionReport>((_resolve, reject) => {
      rejectRead = reject;
    }) }));
    await vi.advanceTimersByTimeAsync(2_000);
    const snapshot = await pending;
    rejectRead(new Error('fake late private exception'));
    await vi.advanceTimersByTimeAsync(0);
    expect(snapshot.execution?.reason).toBe('execution: read deadline exceeded');
    expect(JSON.stringify(snapshot)).not.toContain('fake late private exception');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('preserves every original status byte when execution is absent', () => {
    const snapshot: RuntimeSnapshot = {
      host: 'fake-host', tailnetName: 'fake-tailnet', installedVersion: '1.0.0',
      pid: 123, uptimeSeconds: 10, platform: 'fake-os', arch: 'fake-arch', stateRoot: '~/state',
      lastFleetStateRead: { mtime: new Date(NOW).toISOString(), ageSeconds: 12 },
      coordination: { state: 'known', activeClaims: 3, newestReturnAgeSeconds: 7 },
      asOf: new Date(NOW).toISOString(), reasons: [],
    };
    expect(formatRuntimeStatusLines(snapshot)).toEqual([
      'Runtime: fake-host (fake-tailnet) v1.0.0 as of 2026-11-14T20:00:00.000Z',
      'Fleet state: last write 12s ago',
      'Claims: 3 live, newest return 7s ago',
    ]);
    expect(formatRuntimeStatusLines({ ...snapshot,
      coordination: { state: 'UNKNOWN', activeClaims: 'UNKNOWN', newestReturnAgeSeconds: 'UNKNOWN', reason: 'fake unavailable' },
      execution: { state: 'UNKNOWN', running: 0, claimedNoWorker: 0, unknown: 0, reason: 'execution: ledger unavailable' },
    })[2]).toBe('Claims: UNKNOWN (fake unavailable) (running UNKNOWN: execution: ledger unavailable)');
  });
});
