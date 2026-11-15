import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { joinClaimExecution } from '../src/core/fleet/claim-execution-evidence.js';
import type { FleetBoard } from '../src/core/fleet/coordination.js';
import * as workers from '../src/core/fleet/runs-live-workers.js';
import { defaults, readRuntimeSnapshot, type FleetRuntimeDeps } from '../src/core/fleet/runtime-snapshot.js';

const NOW = Date.parse('2026-11-14T20:00:00Z');
const board = (count = 2): FleetBoard => ({
  schema: 'fleet.coordination.v1', state: 'known', expiredClaims: 0, messages: [], proposals: [],
  claims: ['RQ-FAKE-ONE', 'RQ-FAKE-TWO'].slice(0, count).map(id => ({
    id, repo: 'fake/repo', task: 'fake task', agent: 'fake-agent',
    claimedAt: NOW - 1_000, expiresAt: NOW + 1_000,
  })),
});
const processSnapshot = (): workers.LiveWorkersSnapshot => ({
  v: 1, generatedAt: new Date(NOW).toISOString(), sourceState: 'healthy',
  leaders: [], orchestratorAgents: 0,
  workers: [{ job: 'RQ-FAKE-ONE', pid: 123, repo: 'repo', lane: 'fake', tier: 'work', ageSeconds: 1 }],
});
let root: string;
function deps(readBoard: FleetRuntimeDeps['board']): FleetRuntimeDeps {
  return {
    now: () => NOW, home: () => root, stateRoot: () => root,
    host: () => 'fake-host', tailnet: () => 'fake-tailnet',
    installedVersion: () => '1.0.0', sourceVersion: () => '1.0.0',
    pid: () => 123, uptime: () => 10, platform: () => 'fake-os', arch: () => 'fake-arch',
    board: readBoard,
  };
}
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'runtime-one-board-'));
  await writeFile(join(root, 'fake-state'), 'fake');
  vi.spyOn(workers, 'listLiveWorkers').mockResolvedValue(processSnapshot());
  // An injected board must also supply the real default execution join.
  vi.spyOn(defaults, 'board').mockImplementation(() => { throw new Error('wrong board'); });
});
afterEach(async () => { vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }); });

describe('one board per runtime snapshot', () => {
  it.each(['omitted', 'production'] as const)('uses one board and clock with %s execution, fresh per request', async mode => {
    const readBoard = vi.fn(() => board(readBoard.mock.calls.length === 1 ? 2 : 1));
    if (mode === 'production') vi.mocked(defaults.board).mockImplementation(readBoard);
    const options = mode === 'production'
      ? { ...deps(defaults.board), execution: defaults.execution } : deps(readBoard);
    const clock = vi.fn().mockReturnValueOnce(NOW).mockReturnValue(NOW + 120_000);
    options.now = clock;
    const first = await readRuntimeSnapshot(options);
    expect(readBoard).toHaveBeenCalledExactlyOnceWith({ now: NOW });
    expect(clock).toHaveBeenCalledTimes(1);
    expect(first.asOf).toBe(new Date(NOW).toISOString());
    expect(first.coordination.activeClaims).toBe(2);
    expect(first.execution).toEqual({ state: 'known', running: 1, claimedNoWorker: 1, unknown: 0 });
    const next = await readRuntimeSnapshot({ ...options, now: () => NOW });
    expect(readBoard).toHaveBeenCalledTimes(2);
    expect(workers.listLiveWorkers).toHaveBeenCalledTimes(2);
    if (mode === 'omitted') expect(defaults.board).not.toHaveBeenCalled();
    expect(next.coordination.activeClaims).toBe(1);
    expect(next.execution).toEqual({ state: 'known', running: 1, claimedNoWorker: 0, unknown: 0 });
  });

  it.each(['throw', 'unknown'] as const)('keeps a %s board unavailable until the next request', async mode => {
    const readBoard = vi.fn(() => {
      if (readBoard.mock.calls.length > 1) return board();
      if (mode === 'throw') throw new Error('fake private failure');
      return { ...board(0), state: 'unknown' as const };
    });
    const first = await readRuntimeSnapshot(deps(readBoard));
    expect(readBoard).toHaveBeenCalledTimes(1);
    expect(first.coordination.state).toBe('UNKNOWN');
    expect(first.coordination.activeClaims).toBe('UNKNOWN');
    expect(first.execution).toEqual({ state: 'UNKNOWN', running: 0, claimedNoWorker: 0, unknown: 0,
      reason: 'execution: ledger unavailable' });
    expect(JSON.stringify(first)).not.toContain('fake private failure');
    const next = await readRuntimeSnapshot(deps(readBoard));
    expect(readBoard).toHaveBeenCalledTimes(2);
    expect(next.coordination.activeClaims).toBe(2);
    expect(next.execution).toEqual({ state: 'known', running: 1, claimedNoWorker: 1, unknown: 0 });
  });

  it('preserves captured ledger evidence when the worker reader fails', async () => {
    vi.mocked(workers.listLiveWorkers).mockRejectedValue(new Error('fake private process failure'));
    const readBoard = vi.fn(() => board());
    const snapshot = await readRuntimeSnapshot(deps(readBoard));
    expect(readBoard).toHaveBeenCalledTimes(1);
    expect(snapshot.coordination.activeClaims).toBe(2);
    expect(snapshot.execution).toEqual({ state: 'UNKNOWN', running: 0, claimedNoWorker: 0, unknown: 2,
      reason: 'execution: process table unavailable' });
    expect(JSON.stringify(snapshot)).not.toContain('fake private process failure');
  });

  it('honors an explicit independent execution override without arguments', async () => {
    const execution = vi.fn(async () => joinClaimExecution(board(1), processSnapshot(), NOW));
    const snapshot = await readRuntimeSnapshot({ ...deps(() => board()), execution });
    expect(execution).toHaveBeenCalledExactlyOnceWith();
    expect(snapshot.coordination.activeClaims).toBe(2);
    expect(snapshot.execution).toEqual({ state: 'known', running: 1, claimedNoWorker: 0, unknown: 0 });
    expect(workers.listLiveWorkers).not.toHaveBeenCalled();
  });
});
