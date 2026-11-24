import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ApiModule } from '../src/core/verse/api-modules.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';

const dir = mkdtempSync(join(tmpdir(), 'claims-readonly-538s-'));
const originalPath = process.env['PHANTOM_FLEET_LEDGER_PATH'];

afterEach(() => {
  if (originalPath === undefined) delete process.env['PHANTOM_FLEET_LEDGER_PATH'];
  else process.env['PHANTOM_FLEET_LEDGER_PATH'] = originalPath;
  vi.useRealTimers();
  vi.resetModules();
  rmSync(dir, { recursive: true, force: true });
});

async function get(api: ApiModule, path: string) {
  let status = 0, text = '';
  const res = { writeHead(code: number) { status = code; return this; }, end(body: string) { text = body; } } as unknown as ServerResponse;
  const handled = await api({} as VerseApiContext, { url: path } as IncomingMessage, res, path, 'GET');
  expect({ handled, status }).toEqual({ handled: true, status: 200 });
  return JSON.parse(text);
}

describe('coordination claims GET reads the real ledger without reaping', () => {
  it('preserves expired and live claims across repeated reads', async () => {
    const ledger = join(dir, 'coordination.jsonl');
    process.env['PHANTOM_FLEET_LEDGER_PATH'] = ledger;
    const { claimFleetWork } = await import('../src/core/fleet/coordination.js');
    const { createFleetCoordinationClaimsApi, VERSE_FLEET_COORDINATION_CLAIMS_PATH } = await import('../src/core/verse/fleet-coordination-claims-api.js');
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-13T18:00:00Z'));
    const expired = claimFleetWork({ repo: 'fake/repo', task: 'expired task', agent: 'expired-agent', ttlMs: 1_000 });
    const live = claimFleetWork({ repo: 'fake/repo', task: 'live task', agent: 'live-agent', ttlMs: 60_000 });
    if (!expired.ok || !live.ok) throw new Error('claim failed');
    vi.setSystemTime(new Date('2026-11-13T18:00:02Z'));
    const bytes = readFileSync(ledger);
    const entries = readdirSync(dir).sort();
    const api = createFleetCoordinationClaimsApi();
    for (let i = 0; i < 2; i++) {
      const claims = await get(api, VERSE_FLEET_COORDINATION_CLAIMS_PATH);
      expect(claims).toMatchObject({ state: 'known', expiredClaims: 1, claims: [{ id: live.value.claim.id, agent: 'live-agent', task: 'live task' }] });
      expect(JSON.stringify(claims)).not.toContain(expired.value.claim.id);
      expect(readFileSync(ledger)).toEqual(bytes);
      expect(readdirSync(dir).sort()).toEqual(entries);
    }
  }, 30_000);
});
