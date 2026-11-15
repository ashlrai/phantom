import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetRuntime, type FleetRuntimeDeps } from '../src/cli/fleet-runtime.js';
import { readClaimExecution } from '../src/core/fleet/claim-execution-evidence.js';
import type { FleetBoard } from '../src/core/fleet/coordination.js';
import type { LiveWorker } from '../src/core/fleet/runs-live-workers.js';

const now = Date.parse('2026-11-13T14:00:00.000Z');
const asOf = new Date(now).toISOString();
const board: FleetBoard = { schema: 'fleet.coordination.v1', state: 'known', messages: [], proposals: [], expiredClaims: 0,
  claims: ['RQ-FAKE-JOB1', 'RQ-FAKE-JOB2'].map(id => ({ id, repo: 'fake/repo', task: 'fake', agent: 'fake-agent', claimedAt: now - 1000, expiresAt: now + 60000 })) };
const worker: LiveWorker = { pid: 123, job: 'RQ-FAKE-JOB1', repo: 'repo', lane: 'fake', tier: 'work', ageSeconds: 1 };
const home = mkdtempSync(join(tmpdir(), 'runtime-text-'));
const deps: FleetRuntimeDeps = {
  now: () => now, home: () => home, stateRoot: () => home, host: () => 'fake-host', platform: () => 'fakeos', arch: () => 'fakearch',
  pid: () => 1, uptime: () => 10, installedVersion: () => '1.0.0', sourceVersion: () => '1.0.0', tailnet: () => 'fake-net', board: () => board,
};
const execution = (workers: LiveWorker[]) => () => readClaimExecution({ board: () => board, now: () => now,
  workers: async () => ({ v: 1, generatedAt: asOf, sourceState: 'healthy', workers, leaders: [], orchestratorAgents: 0 }) });
afterEach(() => vi.restoreAllMocks());

describe('fleet runtime execution text', () => {
  it('distinguishes matching workers from advisory claims and preserves JSON', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const injected = { ...deps, execution: execution([worker]) };
    expect(await cmdFleetRuntime([], injected)).toBe(0);
    expect(log.mock.calls[0]![0]).toContain('active claims: 2');
    expect(log.mock.calls[0]![0]).toContain('execution: known; running: 1; claimedNoWorker: 1; unknown: 0');
    expect(log.mock.calls[0]![0]).toContain(`asOf: ${asOf}`);
    await cmdFleetRuntime(['--json'], injected);
    expect(JSON.parse(log.mock.calls[1]![0])).toMatchObject({ asOf, coordination: { activeClaims: 2 },
      execution: { state: 'known', running: 1, claimedNoWorker: 1, unknown: 0 } });
    await cmdFleetRuntime([], { ...deps, execution: execution([]) });
    expect(log.mock.calls[2]![0]).toContain('running: 0; claimedNoWorker: 2; unknown: 0');
  });

  it('reports unavailable evidence with a fixed reason and hides reader exceptions', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await cmdFleetRuntime([], { ...deps, execution: async () => { throw new Error('private reader text'); } });
    expect(log.mock.calls[0]![0]).toContain('execution: UNKNOWN');
    expect(log.mock.calls[0]![0]).toContain('execution: read failed');
    expect(log.mock.calls[0]![0]).not.toContain('private reader text');
    await cmdFleetRuntime([], { ...deps, execution: () => readClaimExecution({ board: () => board, now: () => now,
      workers: async () => { throw new Error('private worker text'); } }) });
    expect(log.mock.calls[1]![0]).toContain('execution: UNKNOWN; running: 0; claimedNoWorker: 0; unknown: 2; execution: process table unavailable');
    expect(log.mock.calls[1]![0]).not.toContain('private worker text');
  });

  it('does not read state for help or invalid arguments', async () => {
    const read = vi.fn(() => { throw new Error('unexpected read'); });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const unreadable = { ...deps, now: read };
    expect(await cmdFleetRuntime(['--help'], unreadable)).toBe(0);
    expect(await cmdFleetRuntime(['--bad'], unreadable)).toBe(2);
    expect(read).not.toHaveBeenCalled();
  });
});
process.on('exit', () => rmSync(home, { recursive: true, force: true }));
