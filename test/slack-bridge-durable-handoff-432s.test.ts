import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { ownerStatusReply } from '../src/core/agents/owner-status-reply.js';
import { formatBridgeCheckReply } from '../src/core/fleet/bridge-check-reply.js';
import {
  claimFleetWork, handoffFleetClaim, readFleetBoard, type FleetCoordinationResult,
} from '../src/core/fleet/coordination.js';
import { projectCoordinationClaims } from '../src/core/fleet/coordination-claims-view.js';
import { returnFleetClaim } from '../src/core/fleet/coordination-return.js';
import { readFleetBridgeCheck } from '../src/mcp/fleet-bridge-check.js';

const FOOTER = 'Reachability only; this is not an assignment or claim.';
const PRIVATE = ['private-task-432s', 'private-expiry-432s', 'private-corrupt-432s', 'private-artifact-432s'];

function must<T>(result: FleetCoordinationResult<T>): T {
  if (!result.ok) throw new Error(`fixture mutation failed: ${result.error}`);
  return result.value;
}

it('carries durable handoff, return, expiry and repair through the Slack bridge answer', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'slack-bridge-432s-'));
  const ledger = join(dir, 'coordination.jsonl');
  const [task, expiryTask, corrupt, artifact] = PRIVATE;
  const previousPath = process.env['PHANTOM_FLEET_LEDGER_PATH'];
  process.env['PHANTOM_FLEET_LEDGER_PATH'] = ledger;
  let now = Date.parse('2026-11-15T12:00:00.000Z');
  let runtimeOk = true;
  const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
  const leases: string[] = [];
  // One composer instance, wired exactly like the Slack wiring: the real
  // readFleetBridgeCheck + formatBridgeCheckReply. Only host/peer observations
  // and the clock are injected; claims come from the check's own ledger read.
  const adapter = ownerStatusReply({
    bridge: async at => formatBridgeCheckReply(await readFleetBridgeCheck({
      now: () => at.getTime(),
      runtime: async () => runtimeOk
        ? { host: 'fake-host-432s', lastFleetStateRead: { ageSeconds: 1 } }
        : { status: 'unavailable', lastFleetStateRead: { ageSeconds: 1 } },
      peers: () => ({ status: 'ok' }),
    }), at),
  });
  const options = () => ({ path: ledger, now });
  const entries = () => readdirSync(dir).sort().map(name => [name, readFileSync(join(dir, name))] as const);
  const ask = async (verdict: 'READY' | 'BLOCKED', claims: string, missing: string[] = []) => {
    const before = entries();
    const reply = await adapter.compose('/fake-runs', new Date(now), 'bridge?');
    const heading = `Bridge: ${verdict} as of ${new Date(now).toISOString()}${missing.length ? ` · missing ${missing.join(', ')}` : ''}`;
    expect(reply.split('\n')[0]).toBe(heading);
    expect(reply).toContain(claims);
    expect(reply.split('\n').length).toBeLessThanOrEqual(6);
    expect(reply.length).toBeLessThanOrEqual(600);
    expect(reply.endsWith(FOOTER)).toBe(true);
    // Reachability evidence only: no lease, task text, corruption bytes or
    // execution vocabulary ever leaves the ledger through the answer.
    for (const value of [...PRIVATE, ...leases]) expect(reply).not.toContain(value);
    for (const word of ['ASSIGNED', 'RUNNING', 'VERIFIED']) expect(reply).not.toContain(word);
    expect(entries()).toEqual(before);
    return reply;
  };
  try {
    expect(adapter.ask('bridge?')).toBe(true);
    writeFileSync(ledger, '', { mode: 0o600 });
    expect(await ask('READY', 'Claims: 0 live, newest unknown')).toContain('Runtime: ok');
    runtimeOk = false;
    expect(await ask('BLOCKED', 'Claims: 0 live, newest unknown', ['runtime'])).toContain('Runtime: unavailable');
    runtimeOk = true;
    const claimed = must(claimFleetWork({ repo: 'fake/repo', task, agent: 'fake-host-a', ttlMs: 60_000 }, options()));
    leases.push(claimed.lease);
    now += 10_000;
    await ask('READY', 'Claims: 1 live, newest 10s');
    now += 5_000;
    const handed = must(handoffFleetClaim(
      { id: claimed.claim.id, agent: 'fake-host-a', lease: claimed.lease, to: 'fake-host-b', ttlMs: 60_000 }, options()));
    leases.push(handed.lease);
    const moved = projectCoordinationClaims(readFleetBoard(options()), now);
    expect(moved.state).toBe('known');
    expect(moved.claims).toEqual([expect.objectContaining({ id: claimed.claim.id, agent: 'fake-host-b' })]);
    now += 10_000;
    // The host transfer moved one claim id: the answer still counts one live claim.
    await ask('READY', 'Claims: 1 live, newest 10s');
    now += 5_000;
    expect(returnFleetClaim({ id: claimed.claim.id, agent: 'fake-host-a', lease: claimed.lease, artifact }, options()))
      .toMatchObject({ ok: false, outcome: 'not-owner' });
    await ask('READY', 'Claims: 1 live, newest 15s');
    expect(returnFleetClaim({ id: claimed.claim.id, agent: 'fake-host-b', lease: handed.lease, artifact }, options()))
      .toMatchObject({ ok: true, outcome: 'returned' });
    expect(returnFleetClaim({ id: claimed.claim.id, agent: 'fake-host-b', lease: handed.lease, artifact }, options()))
      .toMatchObject({ ok: true, outcome: 'already-returned' });
    now += 5_000;
    await ask('READY', 'Claims: 0 live, newest unknown');
    const expiring = must(claimFleetWork({ repo: 'fake/repo', task: expiryTask, agent: 'fake-host-a', ttlMs: 20_000 }, options()));
    leases.push(expiring.lease);
    now += 5_000;
    await ask('READY', 'Claims: 1 live, newest 5s');
    now += 20_000;
    // Expiry is the ledger's own durable reap on read; once it lands the
    // answer counts no live claim and the composer read stays byte-stable.
    const reaped = readFleetBoard(options());
    expect(reaped.claims).toEqual([]);
    expect(reaped.expiredClaims).toBe(1);
    await ask('READY', 'Claims: 0 live, newest unknown');
    const healthy = readFileSync(ledger);
    writeFileSync(ledger, `${corrupt}\n`, { mode: 0o600 });
    now += 5_000;
    await ask('BLOCKED', 'Claims: unknown', ['claims']);
    writeFileSync(ledger, healthy, { mode: 0o600 });
    now += 5_000;
    await ask('READY', 'Claims: 0 live, newest unknown');
  } finally {
    clock.mockRestore();
    if (previousPath === undefined) delete process.env['PHANTOM_FLEET_LEDGER_PATH'];
    else process.env['PHANTOM_FLEET_LEDGER_PATH'] = previousPath;
    rmSync(dir, { recursive: true, force: true });
  }
});
