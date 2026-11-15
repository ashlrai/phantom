import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { claimFleetWork, readFleetBoard } from '../src/core/fleet/coordination.js';
import { returnFleetClaim } from '../src/core/fleet/coordination-return.js';
import { projectCoordinationReturns } from '../src/core/fleet/coordination-returns-view.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';
import { createFleetBridgeCheckApi, VERSE_FLEET_BRIDGE_CHECK_PATH } from '../src/core/verse/fleet-bridge-check-api.js';
import { readFleetBridgeCheck } from '../src/mcp/fleet-bridge-check.js';

it('refreshes the HTTP verdict after an owner return and a distinct claim', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'bridge-http-return-'));
  const ledger = join(directory, 'coordination.jsonl');
  const previous = process.env['PHANTOM_FLEET_LEDGER_PATH'];
  const start = Date.parse('2026-11-15T00:00:00.000Z');
  writeFileSync(ledger, '', { mode: 0o600 });
  process.env['PHANTOM_FLEET_LEDGER_PATH'] = ledger;
  const clock = vi.spyOn(Date, 'now').mockReturnValue(start);
  const api = createFleetBridgeCheckApi({ read: () => readFleetBridgeCheck({
    runtime: async () => ({ lastFleetStateRead: { ageSeconds: 1 } }),
    peers: () => ({ status: 'ok' }),
  }) });

  async function check(live: number, age: number | null, leases: string[]) {
    const before = readFileSync(ledger);
    let status = 0;
    let text = '';
    const res = {
      writeHead(code: number) { status = code; return this; },
      end(body: string) { text = body; },
    } as unknown as ServerResponse;
    const req = { url: VERSE_FLEET_BRIDGE_CHECK_PATH } as IncomingMessage;
    expect(await api({} as VerseApiContext, req, res, VERSE_FLEET_BRIDGE_CHECK_PATH, 'GET')).toBe(true);
    expect(status).toBe(200);
    const body = JSON.parse(text);
    expect(body).toMatchObject({ v: 1, authority: 'none', check: {
      verdict: 'READY', asOf: new Date(Date.now()).toISOString(), missing: [],
      claims: { state: 'known', source: 'coordination-ledger', asOf: new Date(Date.now()).toISOString(), live, newestAgeSec: age },
      runtime: { source: 'fleet-runtime', asOf: new Date(Date.now()).toISOString() },
      peers: { source: 'peer-ledger', asOf: new Date(Date.now()).toISOString() },
    } });
    expect(text).not.toMatch(/lease/i);
    for (const lease of leases) expect(text).not.toContain(lease);
    expect(readFileSync(ledger)).toEqual(before);
  }

  try {
    await check(0, null, []);
    const first = claimFleetWork({ repo: 'example/fixture', task: 'first task', agent: 'fixture-owner', ttlMs: 60_000 });
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error('first fixture claim failed');
    clock.mockReturnValue(start + 10_000);
    await check(1, 10, [first.value.lease]);
    expect(returnFleetClaim({ id: first.value.claim.id, agent: 'fixture-owner', lease: first.value.lease,
      pr: 418, head: 'abcdef1234567' })).toMatchObject({ ok: true, outcome: 'returned' });
    expect(Date.now()).toBeLessThan(first.value.claim.expiresAt);
    await check(0, null, [first.value.lease]);
    const receipt = projectCoordinationReturns(readFleetBoard(), Date.now());
    expect(receipt).toMatchObject({ state: 'known', unparsed: 0, returns: [{
      claimId: first.value.claim.id, repo: 'example/fixture', from: 'fixture-owner',
      result: 'VERIFIED', evidenceKind: 'pr', pr: 418, head: 'abcdef1234567', temporal: 'current',
    }] });
    expect(receipt.returns).toHaveLength(1);
    clock.mockReturnValue(start + 20_000);
    const next = claimFleetWork({ repo: 'example/fixture', task: 'second task', agent: 'fixture-owner', ttlMs: 60_000 });
    expect(next.ok).toBe(true);
    if (!next.ok) throw new Error('second fixture claim failed');
    expect(next.value.claim.id).not.toBe(first.value.claim.id);
    await check(1, 0, [first.value.lease, next.value.lease]);
  } finally {
    if (previous === undefined) delete process.env['PHANTOM_FLEET_LEDGER_PATH'];
    else process.env['PHANTOM_FLEET_LEDGER_PATH'] = previous;
    vi.restoreAllMocks();
    rmSync(directory, { recursive: true, force: true });
  }
});
