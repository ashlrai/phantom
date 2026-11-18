import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { claimFleetWork, readFleetBoard } from '../src/core/fleet/coordination.js';
import {
  handleFleetCoordinationClaimsApi,
  VERSE_FLEET_COORDINATION_CLAIMS_PATH as PATH,
} from '../src/core/verse/fleet-coordination-claims-api.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';

const dir = mkdtempSync(join(tmpdir(), 'redtestfix-c554-'));
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

it('keeps expired claims observable until an explicit board reap, through the exported route', async () => {
  const ledger = join(dir, 'coordination.jsonl');
  vi.stubEnv('PHANTOM_FLEET_LEDGER_PATH', ledger);
  const expired = claimFleetWork({ repo: 'fake/repo', task: 'expired work', agent: 'fake-agent', ttlMs: 1 },
    { now: Date.now() - 60_000 });
  expect(expired.ok).toBe(true);
  const bytes = readFileSync(ledger);
  const entries = readdirSync(dir).sort();
  async function call(method: string) {
    let status = 0, text = '';
    const res = {
      writeHead(code: number) { status = code; return this; },
      end(body: string) { text = body; },
    } as unknown as ServerResponse;
    const handled = await handleFleetCoordinationClaimsApi({} as VerseApiContext,
      {} as IncomingMessage, res, PATH, method);
    expect(handled).toBe(true);
    return { status, body: JSON.parse(text) };
  }
  expect(await call('POST')).toEqual({ status: 405, body: { error: 'method not allowed' } });
  for (let i = 0; i < 2; i++) {
    const response = await call('GET');
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ state: 'known', claims: [], expiredClaims: 1 });
    expect(readFileSync(ledger)).toEqual(bytes);
    expect(readdirSync(dir).sort()).toEqual(entries);
  }
  // The explicit board reader retains its existing expiry-recording behavior.
  expect(readFleetBoard()).toMatchObject({ state: 'known', claims: [], expiredClaims: 1 });
  expect(readFileSync(ledger, 'utf8').slice(bytes.length)).toContain('"kind":"reap"');
  expect((await call('GET')).body).toMatchObject({ state: 'known', claims: [], expiredClaims: 0 });
});
