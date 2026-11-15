import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { claimFleetWork, handoffFleetClaim, readFleetBoard, type FleetCoordinationResult } from '../src/core/fleet/coordination.js';
import { returnFleetClaim } from '../src/core/fleet/coordination-return.js';
import { projectCoordinationReturns } from '../src/core/fleet/coordination-returns-view.js';
import { readRuntimeSnapshot, type FleetRuntimeDeps } from '../src/core/fleet/runtime-snapshot.js';

function must<T>(result: FleetCoordinationResult<T>): T {
  if (!result.ok) throw new Error(`coordination failed: ${result.error}`);
  return result.value;
}

it('reconnects to the durable claim lifecycle without exposing ownership evidence', async () => {
  const home = mkdtempSync(join(tmpdir(), 'runtime-lifecycle-387s-'));
  try {
    const root = join(home, 'state'), path = join(home, 'ledger.jsonl');
    mkdirSync(root);
    writeFileSync(join(root, 'state.json'), '{}');
    writeFileSync(path, '', { mode: 0o600 });
    let now = Date.parse('2026-11-13T14:00:00.000Z');
    utimesSync(join(root, 'state.json'), now / 1000, now / 1000);
    const options = () => ({ path, now });
    const deps: FleetRuntimeDeps = {
      now: () => now, home: () => home, stateRoot: () => root, host: () => 'fake-host',
      platform: () => 'fakeos', arch: () => 'fakearch', pid: () => 123, uptime: () => 10,
      installedVersion: () => '1.2.3', sourceVersion: () => '1.2.3', tailnet: () => 'fake-tailnet',
      board: input => readFleetBoard({ ...input, path }),
    };
    const task = 'private lifecycle task';
    const leases: string[] = [];
    let previous = '';
    const snapshot = async (activeClaims: number, newestReturnAgeSeconds: number | string) => {
      const result = await readRuntimeSnapshot(deps);
      expect(result.coordination).toMatchObject({ state: 'known', activeClaims, newestReturnAgeSeconds });
      expect(result.asOf).toBe(new Date(now).toISOString());
      expect(result.asOf > previous).toBe(true);
      previous = result.asOf;
      const serialized = JSON.stringify(result);
      for (const privateText of [task, 'lease', 'VERIFIED', ...leases]) expect(serialized).not.toContain(privateText);
      expect(serialized).not.toMatch(/executionAuthorized|authority/i);
    };
    expect(readFleetBoard(options())).toMatchObject({ state: 'known', claims: [], messages: [] });
    await snapshot(0, 'UNKNOWN');
    const claim = must(claimFleetWork({ repo: 'example/repo', task, agent: 'agent-a' }, options()));
    leases.push(claim.lease);
    now += 1000;
    await snapshot(1, 'UNKNOWN');
    const handoff = must(handoffFleetClaim({ id: claim.claim.id, agent: 'agent-a', lease: claim.lease, to: 'agent-b' }, options()));
    leases.push(handoff.lease);
    now += 1000;
    await snapshot(1, 'UNKNOWN');
    expect(returnFleetClaim({ id: claim.claim.id, agent: 'agent-a', lease: claim.lease, tests: 'fake suite' }, options()))
      .toMatchObject({ ok: false, outcome: 'not-owner' });
    now += 1000;
    await snapshot(1, 'UNKNOWN');
    const input = { id: claim.claim.id, agent: 'agent-b', lease: handoff.lease, tests: 'fake suite' };
    expect(returnFleetClaim(input, options())).toMatchObject({ ok: true, outcome: 'returned' });
    const original = projectCoordinationReturns(readFleetBoard(options()), now).returns;
    expect(original).toHaveLength(1);
    expect(original[0]?.at).toBe(new Date(now).toISOString());
    now += 5000;
    await snapshot(0, 5);
    expect(returnFleetClaim(input, options())).toMatchObject({ ok: true, outcome: 'already-returned' });
    const retry = projectCoordinationReturns(readFleetBoard(options()), now).returns;
    expect(retry).toEqual(original);
    now += 2000;
    await snapshot(0, 7);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
