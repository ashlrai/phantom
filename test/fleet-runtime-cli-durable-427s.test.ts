import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { cmdFleetRuntime, type FleetRuntimeDeps } from '../src/cli/fleet-runtime.js';
import { readClaimExecution } from '../src/core/fleet/claim-execution-evidence.js';
import { claimFleetWork, handoffFleetClaim, readFleetBoard, type FleetCoordinationResult } from '../src/core/fleet/coordination.js';
import { returnFleetClaim } from '../src/core/fleet/coordination-return.js';
import type { LiveWorker } from '../src/core/fleet/runs-live-workers.js';

function must<T>(result: FleetCoordinationResult<T>): T {
  if (!result.ok) throw new Error('fake coordination operation failed');
  return result.value;
}

it('observes durable ownership and matching execution on each CLI invocation', async () => {
  const home = mkdtempSync(join(tmpdir(), 'runtime-cli-427s-'));
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  try {
    const path = join(home, 'ledger.jsonl');
    writeFileSync(path, '', { mode: 0o600 });
    let now = Date.parse('2026-11-13T14:00:00.000Z');
    const options = () => ({ path, now });
    const board = () => readFleetBoard(options());
    const task = 'RQ-FAKE-CLI427S fake private task body';
    const leases: string[] = [];
    let workers: LiveWorker[] = [];
    const deps: FleetRuntimeDeps = {
      now: () => now, home: () => home, stateRoot: () => home, host: () => 'fake-host',
      platform: () => 'fakeos', arch: () => 'fakearch', pid: () => 123, uptime: () => 10,
      installedVersion: () => '1.2.3', sourceVersion: () => '1.2.3', tailnet: () => 'fake-net', board,
      execution: () => readClaimExecution({ board, now: () => now, workers: async () => ({
        v: 1, generatedAt: new Date(now).toISOString(), sourceState: 'healthy', workers, leaders: [], orchestratorAgents: 0,
      }) }),
    };
    const read = async (activeClaims: number, running: number, claimedNoWorker: number, returnAge: number | string) => {
      log.mockClear();
      expect(await cmdFleetRuntime(['--json'], deps)).toBe(0);
      const output = String(log.mock.calls[0]?.[0]);
      // Boolean assertions avoid including private fixture values in assertion failures.
      expect([task, ...leases].every(value => !output.includes(value))).toBe(true);
      expect(JSON.parse(output)).toMatchObject({ asOf: new Date(now).toISOString(),
        coordination: { state: 'known', activeClaims, newestReturnAgeSeconds: returnAge },
        execution: { state: 'known', running, claimedNoWorker, unknown: 0 } });
    };
    await read(0, 0, 0, 'UNKNOWN');
    const claim = must(claimFleetWork({ repo: 'fake-owner/fake-cli427s', task, agent: 'fake-owner-a' }, options()));
    leases.push(claim.lease);
    now += 1000;
    await read(1, 0, 1, 'UNKNOWN');
    workers = [{ pid: 4242, job: 'RQ-FAKE-CLI427S', repo: 'fake-cli427s', lane: 'fake', tier: 'work', ageSeconds: 1 }];
    now += 1000;
    await read(1, 1, 0, 'UNKNOWN');
    log.mockClear();
    expect(await cmdFleetRuntime([], deps)).toBe(0);
    const text = String(log.mock.calls[0]?.[0]);
    expect(text).toContain('execution: known; running: 1; claimedNoWorker: 0; unknown: 0');
    expect([task, ...leases].every(value => !text.includes(value))).toBe(true);
    const handoff = must(handoffFleetClaim({ id: claim.claim.id, agent: 'fake-owner-a', lease: claim.lease, to: 'fake-owner-b' }, options()));
    leases.push(handoff.lease);
    now += 1000;
    await read(1, 1, 0, 'UNKNOWN');
    expect(returnFleetClaim({ id: claim.claim.id, agent: 'fake-owner-a', lease: claim.lease, tests: 'fake tests' }, options()).outcome).toBe('not-owner');
    expect(board().claims.map(item => item.agent)).toEqual(['fake-owner-b']);
    now += 1000;
    await read(1, 1, 0, 'UNKNOWN');
    const input = { id: claim.claim.id, agent: 'fake-owner-b', lease: handoff.lease, tests: 'fake tests' };
    expect(returnFleetClaim(input, options()).outcome).toBe('returned');
    now += 1000;
    await read(0, 0, 0, 1);
    expect(board().claims).toEqual([]);
    expect(returnFleetClaim(input, options()).outcome).toBe('already-returned');
    now += 1000;
    await read(0, 0, 0, 2);
    expect(board().claims).toEqual([]);
  } finally {
    log.mockRestore();
    rmSync(home, { recursive: true, force: true });
  }
});
