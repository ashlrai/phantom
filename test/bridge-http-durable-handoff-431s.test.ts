import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { claimFleetWork, handoffFleetClaim, readFleetBoard } from '../src/core/fleet/coordination.js';
import { projectCoordinationClaims } from '../src/core/fleet/coordination-claims-view.js';
import { returnFleetClaim } from '../src/core/fleet/coordination-return.js';
import { createFleetBridgeCheckApi, VERSE_FLEET_BRIDGE_CHECK_PATH } from '../src/core/verse/fleet-bridge-check-api.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';
import { readFleetBridgeCheck } from '../src/mcp/fleet-bridge-check.js';

it('reads durable ownership handoff and return through one read-only HTTP handler', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bridge-http-431s-'));
  const path = join(dir, 'ledger.jsonl');
  const task = 'private-task-http-431s';
  const corrupt = 'private-corrupt-http-431s';
  let now = Date.parse('2026-11-15T12:00:00.000Z');
  const options = () => ({ path, now });
  const leases: string[] = [];
  const api = createFleetBridgeCheckApi({ read: () => readFleetBridgeCheck({
    now: () => now,
    runtime: async () => ({ host: 'fake-host', lastFleetStateRead: { ageSeconds: 1 } }),
    peers: () => ({ status: 'ok' }),
    claims: () => projectCoordinationClaims(readFleetBoard(options()), now),
  }), now: () => new Date(now) });
  const snapshot = () => readdirSync(dir).sort().map(name => [name, readFileSync(join(dir, name)).toString('base64')]);
  const check = async (live: number | null) => {
    const before = snapshot();
    const response = { status: 0, body: '', ends: 0 };
    const res = {
      writeHead(status: number) { response.status = status; return this; },
      end(body: string) { response.body = body; response.ends++; },
    } as unknown as ServerResponse;
    expect(await api({} as VerseApiContext, {} as IncomingMessage, res, VERSE_FLEET_BRIDGE_CHECK_PATH, 'GET')).toBe(true);
    expect(response).toMatchObject({ status: 200, ends: 1 });
    const asOf = new Date(now).toISOString();
    expect(JSON.parse(response.body)).toMatchObject({ v: 1, authority: 'none', check: {
      verdict: live === null ? 'BLOCKED' : 'READY', asOf, missing: live === null ? ['claims'] : [],
      claims: { source: 'coordination-ledger', asOf, state: live === null ? 'unknown' : 'known',
        status: live === null ? 'unavailable' : 'ok', live },
      runtime: { source: 'fleet-runtime', asOf }, peers: { source: 'peer-ledger', asOf },
    } });
    for (const value of [task, corrupt, ...leases]) expect(response.body).not.toContain(value);
    expect(snapshot()).toEqual(before);
  };
  try {
    writeFileSync(path, '', { mode: 0o600 });
    await check(0);
    const claim = claimFleetWork({ repo: 'fake/repo', task, agent: 'fake-a', ttlMs: 60_000 }, options());
    if (!claim.ok) throw new Error(`claim: ${claim.error}`);
    leases.push(claim.value.lease);
    now += 1000;
    await check(1);
    const handoff = handoffFleetClaim({ id: claim.value.claim.id, agent: 'fake-a', lease: claim.value.lease, to: 'fake-b' }, options());
    if (!handoff.ok) throw new Error(`handoff: ${handoff.error}`);
    leases.push(handoff.value.lease);
    expect(readFleetBoard(options()).claims).toEqual([expect.objectContaining({ id: claim.value.claim.id, agent: 'fake-b' })]);
    now += 1000;
    await check(1);
    const result = { id: claim.value.claim.id, agent: 'fake-b', lease: handoff.value.lease, artifact: 'fake-artifact' };
    expect(returnFleetClaim({ ...result, agent: 'fake-a', lease: claim.value.lease }, options())).toMatchObject({ ok: false, outcome: 'not-owner' });
    now += 1000;
    await check(1);
    expect(returnFleetClaim(result, options())).toMatchObject({ ok: true, outcome: 'returned' });
    now += 1000;
    await check(0);
    const returned = snapshot();
    expect(readFleetBoard(options()).messages.filter(message => message.id === `return-${result.id}`)).toHaveLength(1);
    expect(returnFleetClaim(result, options())).toMatchObject({ ok: true, outcome: 'already-returned' });
    expect(snapshot()).toEqual(returned);
    now += 1000;
    await check(0);
    const healthy = readFileSync(path);
    writeFileSync(path, `${corrupt}\n`, { mode: 0o600 });
    now += 1000;
    await check(null);
    writeFileSync(path, healthy, { mode: 0o600 });
    now += 1000;
    await check(0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
