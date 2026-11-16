import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { readClaimExecution } from '../../src/core/fleet/claim-execution-evidence.js';
import { readFleetBoard } from '../../src/core/fleet/coordination.js';
import type { FleetRuntimeDeps } from '../../src/core/fleet/runtime-snapshot.js';
import { parseFleetRuntimeArgs, readFleetRuntime } from '../../src/mcp/fleet-runtime.js';

it('rechecks disconnected and recovered evidence on each MCP runtime read', async () => {
  const home = mkdtempSync(join(tmpdir(), 'fleet-runtime-recovery-474s-'));
  try {
    const ledger = join(home, 'ledger.jsonl');
    writeFileSync(join(home, 'state.json'), '{}');
    let now = Date.parse('2026-11-13T14:00:00Z');
    const claim = { id: 'fake-claim', repo: 'fake/repo', task: 'RQ-FAKE-474 synthetic task', agent: 'fake-agent',
      claimedAt: now - 1000, expiresAt: now + 60_000, leaseHash: 'a'.repeat(64) };
    writeFileSync(ledger, JSON.stringify({ version: 1, kind: 'claim', at: claim.claimedAt, claim }) + '\n', { mode: 0o600 });
    let available = false;
    const board = vi.fn(() => readFleetBoard({ path: available ? ledger : join(home, 'missing', 'ledger'), now }));
    const workers = vi.fn(async () => ({
      v: 1 as const, generatedAt: new Date(now).toISOString(),
      sourceState: available ? 'healthy' as const : 'unavailable' as const,
      workers: available ? [{ pid: 4242, job: 'RQ-FAKE-474', repo: 'repo', lane: 'fake', tier: 'work', ageSeconds: 1 }] : [],
      leaders: [], orchestratorAgents: 0,
    }));
    const deps: FleetRuntimeDeps = {
      now: () => now, home: () => home, stateRoot: () => home, host: () => 'synthetic-host',
      tailnet: () => 'synthetic-tailnet', platform: () => 'fakeos', arch: () => 'fakearch',
      pid: () => 123, uptime: () => 10, installedVersion: () => '1.2.3', sourceVersion: () => '1.2.3', board,
      execution: () => readClaimExecution({ board, now: () => now, workers }),
    };
    for (const args of [{ root: home }, { path: ledger }, { cwd: home }, { dispatch: true }, { claim: true }]) {
      expect(parseFleetRuntimeArgs(args)).toBeNull();
    }
    expect(board).not.toHaveBeenCalled();
    expect(workers).not.toHaveBeenCalled();
    const first = await readFleetRuntime(deps);
    available = true;
    now += 1000;
    const recovered = await readFleetRuntime(deps);
    available = false;
    now += 1000;
    const disconnected = await readFleetRuntime(deps);
    for (const [index, result] of [first, recovered, disconnected].entries()) {
      expect(result.asOf).toBe(new Date(Date.parse('2026-11-13T14:00:00Z') + index * 1000).toISOString());
      expect(result).toMatchObject({ host: 'synthetic-host', tailnetName: 'synthetic-tailnet', authority: 'none' });
      expect(result.note).toContain("another computer reads that computer's state");
      expect(result.note).toContain('no dispatch, claim or merge authority');
    }
    for (const result of [first, disconnected]) {
      expect(result.coordination).toMatchObject({ state: 'UNKNOWN', activeClaims: 'UNKNOWN' });
      expect(result.execution).toMatchObject({ state: 'UNKNOWN', running: 0, claimedNoWorker: 0, unknown: 0 });
    }
    expect(recovered.coordination).toMatchObject({ state: 'known', activeClaims: 1 });
    expect(recovered.execution).toMatchObject({ state: 'known', running: 1, claimedNoWorker: 0, unknown: 0 });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
