import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { cmdFleetBridgeCheck } from '../src/cli/fleet-bridge-check.js';
import { claimFleetWork, handoffFleetClaim, readFleetBoard, type FleetCoordinationResult } from '../src/core/fleet/coordination.js';
import { projectCoordinationClaims } from '../src/core/fleet/coordination-claims-view.js';
import { returnFleetClaim } from '../src/core/fleet/coordination-return.js';
import type { FleetBridgeCheckDeps } from '../src/mcp/fleet-bridge-check.js';

function must<T>(result: FleetCoordinationResult<T>): T {
  if (!result.ok) throw new Error(`fixture mutation failed: ${result.error}`);
  return result.value;
}

it('reads durable handoff, return, corruption and recovery without treating a claim as execution', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bridge-cli-430s-'));
  const path = join(dir, 'ledger.jsonl');
  const options = { path, now: Date.parse('2026-11-15T12:00:00.000Z') };
  const privateTask = 'private-fixture-task-430s';
  const privateCorruption = 'private-corrupt-payload-430s';
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  let runtimeAvailable = true;
  const deps: FleetBridgeCheckDeps = {
    now: () => options.now,
    runtime: async () => runtimeAvailable
      ? { host: 'fake-host', lastFleetStateRead: { ageSeconds: 1 } }
      : { status: 'unavailable', lastFleetStateRead: { ageSeconds: 1 } },
    peers: () => ({ status: 'ok' }),
    claims: () => projectCoordinationClaims(readFleetBoard(options), options.now),
  };
  const leases: string[] = [];
  async function check(live: number | null, blocked: boolean, missing: string[]) {
    const before = readFileSync(path);
    const files = readdirSync(dir).sort();
    const asOf = new Date(options.now).toISOString();
    log.mockClear(); error.mockClear();
    expect(await cmdFleetBridgeCheck(['--json'], deps)).toBe(blocked ? 3 : 0);
    expect(log).toHaveBeenCalledTimes(1);
    const jsonText = String(log.mock.calls[0]![0]);
    const result = JSON.parse(jsonText);
    expect(result).toMatchObject({ verdict: blocked ? 'BLOCKED' : 'READY', asOf, missing,
      claims: { source: 'coordination-ledger', asOf, state: live === null ? 'unknown' : 'known', live },
      runtime: { source: 'fleet-runtime', asOf }, peers: { source: 'peer-ledger', asOf } });
    log.mockClear();
    expect(await cmdFleetBridgeCheck([], deps)).toBe(blocked ? 3 : 0);
    expect(log).toHaveBeenCalledTimes(1);
    const terminal = String(log.mock.calls[0]![0]);
    expect(terminal).toContain(`Bridge: ${blocked ? 'BLOCKED' : 'READY'}`);
    expect(terminal).toContain(`as of ${asOf}`);
    expect(terminal).toContain(`claims: ${live ?? 'unknown'} live`);
    expect(terminal).toContain('Reachability only; grants no claim, dispatch or merge authority.');
    expect(error).not.toHaveBeenCalled();
    for (const value of [privateTask, privateCorruption, ...leases]) {
      expect(jsonText).not.toContain(value);
      expect(terminal).not.toContain(value);
    }
    expect(readFileSync(path)).toEqual(before);
    expect(readdirSync(dir).sort()).toEqual(files);
  }
  try {
    writeFileSync(path, '', { mode: 0o600 });
    await check(0, false, []);
    const claimed = must(claimFleetWork({ repo: 'example/fake', task: privateTask, agent: 'fake-host-a', ttlMs: 60_000 }, options));
    leases.push(claimed.lease);
    options.now += 1000;
    await check(1, false, []);
    runtimeAvailable = false;
    await check(1, true, ['runtime']);
    runtimeAvailable = true;
    const handed = must(handoffFleetClaim({ id: claimed.claim.id, agent: 'fake-host-a', lease: claimed.lease, to: 'fake-host-b' }, options));
    leases.push(handed.lease);
    expect(readFleetBoard(options).claims).toEqual([expect.objectContaining({ id: claimed.claim.id, agent: 'fake-host-b' })]);
    options.now += 1000;
    await check(1, false, []);
    expect(returnFleetClaim({ id: claimed.claim.id, agent: 'fake-host-a', lease: claimed.lease, artifact: 'fake-artifact' }, options))
      .toMatchObject({ ok: false, outcome: 'not-owner' });
    expect(returnFleetClaim({ id: claimed.claim.id, agent: 'fake-host-b', lease: handed.lease, artifact: 'fake-artifact' }, options))
      .toMatchObject({ ok: true, outcome: 'returned' });
    options.now += 1000;
    await check(0, false, []);
    const healthy = readFileSync(path);
    writeFileSync(path, `${privateCorruption}\n`, { mode: 0o600 });
    await check(null, true, ['claims']);
    writeFileSync(path, healthy, { mode: 0o600 });
    options.now += 1000;
    await check(0, false, []);
  } finally {
    log.mockRestore();
    error.mockRestore();
    rmSync(dir, { recursive: true, force: true });
  }
});
