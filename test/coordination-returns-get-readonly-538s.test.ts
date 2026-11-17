import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { claimFleetWork, readFleetBoard } from '../src/core/fleet/coordination.js';
import { returnFleetClaim } from '../src/core/fleet/coordination-return.js';
import { createFleetCoordinationReturnsApi, VERSE_FLEET_COORDINATION_RETURNS_PATH } from '../src/core/verse/fleet-coordination-returns-api.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';

it('observes current receipt evidence without reaping an expired claim', async () => {
  const home = mkdtempSync(join(tmpdir(), 'returns-readonly-538s-'));
  try {
    vi.stubEnv('HOME', home);
    vi.stubEnv('ASHLR_HOME', home);
    const path = join(home, 'ledger.jsonl');
    vi.stubEnv('PHANTOM_FLEET_LEDGER_PATH', path);
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-14T18:00:00Z'));
    const receipt = claimFleetWork({ repo: 'fake/repo', task: 'finished task', agent: 'fake-agent' });
    if (!receipt.ok) throw new Error('receipt claim failed');
    expect(returnFleetClaim({ id: receipt.value.claim.id, agent: 'fake-agent', lease: receipt.value.lease,
      tests: 'fake tests passed', ttlMs: 60_000 }).ok).toBe(true);
    const expired = claimFleetWork({ repo: 'fake/repo', task: 'expired task', agent: 'fake-expired', ttlMs: 1_000 });
    const live = claimFleetWork({ repo: 'fake/repo', task: 'live task', agent: 'fake-live', ttlMs: 60_000 });
    if (!expired.ok || !live.ok) throw new Error('fixture claims failed');
    vi.advanceTimersByTime(2_000);
    const bytes = readFileSync(path);
    const entries = readdirSync(home).sort();
    const api = createFleetCoordinationReturnsApi();
    for (let i = 0; i < 2; i++) {
      let status = 0, text = '';
      const res = { writeHead(code: number) { status = code; return this; }, end(body: string) { text = body; } } as unknown as ServerResponse;
      expect(await api({} as VerseApiContext, {} as IncomingMessage, res, VERSE_FLEET_COORDINATION_RETURNS_PATH, 'GET')).toBe(true);
      expect(status).toBe(200);
      expect(JSON.parse(text)).toMatchObject({ state: 'known', authority: 'none', unparsed: 0, returns: [
        { claimId: receipt.value.claim.id, repo: 'fake/repo', from: 'fake-agent', evidenceKind: 'tests', evidence: 'tests fake tests passed', temporal: 'current' },
      ] });
      expect(readFileSync(path)).toEqual(bytes);
      expect(readdirSync(home).sort()).toEqual(entries);
      const board = readFleetBoard({ reap: false });
      expect(board.claims.map(claim => claim.id)).toEqual([live.value.claim.id]);
      expect(board.claims.map(claim => claim.id)).not.toContain(expired.value.claim.id);
      expect(board.proposals).toEqual([]);
    }
  } finally {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.resetModules();
    rmSync(home, { recursive: true, force: true });
  }
});
afterEach(() => { vi.restoreAllMocks(); });
