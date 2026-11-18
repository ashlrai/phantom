import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { claimFleetWork, fleetCoordinationPath, postFleetMessage, readFleetBoard } from '../src/core/fleet/coordination.js';
import { returnFleetClaim } from '../src/core/fleet/coordination-return.js';
import { createFleetCoordinationReturnsApi, VERSE_FLEET_COORDINATION_RETURNS_PATH } from '../src/core/verse/fleet-coordination-returns-api.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';

afterEach(() => { vi.unstubAllEnvs(); });

it('lists retained receipt history at one observation clock without changing the ledger', async () => {
  const home = mkdtempSync(join(tmpdir(), 'returns-list-595s-'));
  try {
    vi.stubEnv('HOME', home); vi.stubEnv('ASHLR_HOME', home);
    vi.stubEnv('PHANTOM_FLEET_LEDGER_PATH', ''); delete process.env['PHANTOM_FLEET_LEDGER_PATH'];
    const at = 1_000_000, expiry = at + 10_000;
    const claim = claimFleetWork({ repo: 'fake/repo', task: 'fake task', agent: 'fake-agent', ttlMs: 10_000 }, { now: at });
    if (!claim.ok) throw new Error('fixture claim failed');
    expect(returnFleetClaim({ id: claim.value.claim.id, agent: 'fake-agent', lease: claim.value.lease,
      tests: 'fake tests', ttlMs: 10_000 }, { now: at }).ok).toBe(true);
    expect(claimFleetWork({ repo: 'fake/repo', task: 'other task', agent: 'fake-owner', ttlMs: 10_000 }, { now: at }).ok).toBe(true);
    expect(postFleetMessage({ id: 'return-impostor', from: 'fake-agent', to: 'all', body: 'fake ordinary post', ttlMs: 10_000 }, { now: at }).ok).toBe(true);
    const path = fleetCoordinationPath(), bytes = readFileSync(path);
    const get = async (time: number) => {
      let status = 0, text = '';
      const res = { writeHead(code: number) { status = code; return this; }, end(body: string) { text = body; } } as unknown as ServerResponse;
      const api = createFleetCoordinationReturnsApi({ now: () => new Date(time) });
      expect(await api({} as VerseApiContext, {} as IncomingMessage, res, VERSE_FLEET_COORDINATION_RETURNS_PATH, 'GET')).toBe(true);
      expect(status).toBe(200);
      expect(readFileSync(path)).toEqual(bytes);
      return JSON.parse(text);
    };
    expect(await get(at + 1)).toMatchObject({ returns: [{ claimId: claim.value.claim.id, temporal: 'current' }] });
    const observed = new Date(expiry).toISOString();
    expect(await get(expiry)).toMatchObject({ state: 'known', authority: 'none', generatedAt: observed, asOf: observed,
      unparsed: 0, returns: [{ claimId: claim.value.claim.id, result: 'VERIFIED', temporal: 'expired' }] });
    const board = readFleetBoard({ now: expiry, reap: false, includeExpiredReturns: true });
    expect(board.claims).toEqual([]);
    expect(board.messages.map(message => message.id)).toEqual([`return-${claim.value.claim.id}`]);
    writeFileSync(path, 'invalid ledger\n');
    const invalid = readFileSync(path);
    let text = '';
    const res = { writeHead() { return this; }, end(body: string) { text = body; } } as unknown as ServerResponse;
    await createFleetCoordinationReturnsApi({ now: () => new Date(expiry) })({} as VerseApiContext, {} as IncomingMessage, res, VERSE_FLEET_COORDINATION_RETURNS_PATH, 'GET');
    expect(JSON.parse(text)).toMatchObject({ state: 'unknown', authority: 'none', returns: [] });
    expect(text).not.toContain(path); expect(text).not.toContain('invalid ledger');
    expect(readFileSync(path)).toEqual(invalid);
  } finally { rmSync(home, { recursive: true, force: true }); }
});
