/** GET /api/verse/fleet/runtime-identity/bridge-check against a real on-disk
 * coordination ledger: the composed verdict recovers from an unreadable ledger
 * without restarting the handler. Only the runtime/peer readers and the clock
 * are injected; the claims section keeps its DEFAULT readFleetBoard +
 * projectCoordinationClaims reader against PHANTOM_FLEET_LEDGER_PATH. */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiModule } from '../src/core/verse/api-modules.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';
import {
  createFleetBridgeCheckApi,
  VERSE_FLEET_BRIDGE_CHECK_PATH as PATH,
} from '../src/core/verse/fleet-bridge-check-api.js';
import { createFleetRuntimeIdentityApi } from '../src/core/verse/fleet-runtime-identity-api.js';
import { readFleetBridgeCheck } from '../src/mcp/fleet-bridge-check.js';
import { claimFleetWork } from '../src/core/fleet/coordination.js';

const NOW = Date.parse('2026-11-15T00:00:00.000Z');
const PRIVATE_CORRUPT = 'private-corrupt-bytes-410s';

let directory: string;
let ledger: string;
let previousPath: string | undefined;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'bridge-http-disk-'));
  ledger = join(directory, 'coordination.jsonl');
  previousPath = process.env['PHANTOM_FLEET_LEDGER_PATH'];
  process.env['PHANTOM_FLEET_LEDGER_PATH'] = ledger;
  vi.spyOn(Date, 'now').mockReturnValue(NOW);
});

afterEach(() => {
  if (previousPath === undefined) delete process.env['PHANTOM_FLEET_LEDGER_PATH'];
  else process.env['PHANTOM_FLEET_LEDGER_PATH'] = previousPath;
  vi.restoreAllMocks();
  rmSync(directory, { recursive: true, force: true });
});

/** The real route delegation: runtime-identity -> bridge-check -> readFleetBridgeCheck,
 * with only deterministic runtime/peer readers and the clock injected. */
function bridgeApi(): ApiModule {
  const bridgeCheck = createFleetBridgeCheckApi({
    read: () => readFleetBridgeCheck({
      runtime: async () => ({ lastFleetStateRead: { ageSeconds: 30 } }),
      peers: () => ({ status: 'ok' }),
      now: () => Date.now(),
    }),
    now: () => new Date(Date.now()),
  });
  return createFleetRuntimeIdentityApi({ bridgeCheck });
}

async function get(api: ApiModule) {
  let status = 0;
  let text = '';
  const res = {
    writeHead(code: number) { status = code; return this; },
    end(body: string) { text = body; },
  } as unknown as ServerResponse;
  const req = { url: PATH } as IncomingMessage;
  const handled = await api({} as VerseApiContext, req, res, PATH, 'GET');
  return { handled, status, text, body: text ? JSON.parse(text) : null };
}

describe('bridge-check HTTP route over a real coordination ledger', () => {
  it('recovers READY -> live claim -> BLOCKED -> repaired READY -> expired known-zero on one handler', async () => {
    const api = bridgeApi();

    // Known empty: a private empty ledger is state 'known' with zero live claims.
    writeFileSync(ledger, '', { mode: 0o600 });
    const emptyBytes = readFileSync(ledger);
    const empty = await get(api);
    expect(empty).toMatchObject({ handled: true, status: 200 });
    expect(empty.body).toMatchObject({ v: 1, authority: 'none' });
    expect(empty.body.check).toMatchObject({
      verdict: 'READY', asOf: new Date(NOW).toISOString(), missing: [],
      claims: { state: 'known', status: 'ok', source: 'coordination-ledger',
        live: 0, newestAgeSec: null, asOf: new Date(NOW).toISOString() },
      runtime: { source: 'fleet-runtime' }, peers: { source: 'peer-ledger' },
    });
    // A GET never mutates a readable ledger.
    expect(readFileSync(ledger)).toEqual(emptyBytes);

    // A real claimFleetWork claim lands in the live count.
    expect(claimFleetWork({ repo: 'example/repo', task: 'reconnect', agent: 'dot', ttlMs: 60_000 }))
      .toMatchObject({ ok: true });
    vi.mocked(Date.now).mockReturnValue(NOW + 30_000);
    const live = await get(api);
    expect(live.body.check).toMatchObject({
      verdict: 'READY', missing: [],
      claims: { state: 'known', live: 1, newestAgeSec: 30,
        asOf: '2026-11-15T00:00:30.000Z' },
    });

    // Corrupt ledger: BLOCKED names claims; private bytes never serialize; GET is read-only.
    writeFileSync(ledger, `${PRIVATE_CORRUPT}\n`, { mode: 0o600 });
    const corruptBytes = readFileSync(ledger);
    const blocked = await get(api);
    expect(blocked.status).toBe(200);
    expect(blocked.body).toMatchObject({ v: 1, authority: 'none' });
    expect(blocked.body.check).toMatchObject({
      verdict: 'BLOCKED', missing: ['claims'],
      claims: { state: 'unknown', status: 'unavailable', live: null, newestAgeSec: null },
    });
    expect(blocked.text).not.toContain(PRIVATE_CORRUPT);
    expect(readFileSync(ledger)).toEqual(corruptBytes);

    // Repaired ledger on the same handler reads READY again.
    writeFileSync(ledger, '', { mode: 0o600 });
    expect(claimFleetWork({ repo: 'example/repo', task: 'repaired', agent: 'dot', ttlMs: 60_000 }))
      .toMatchObject({ ok: true });
    const repaired = await get(api);
    expect(repaired.body.check).toMatchObject({
      verdict: 'READY', missing: [], claims: { state: 'known', live: 1 },
    });

    // At expiry the real claim is reaped: known zero stays distinguishable
    // from the unreadable 'unknown' state above.
    vi.mocked(Date.now).mockReturnValue(NOW + 90_001);
    const expired = await get(api);
    expect(expired.body.check).toMatchObject({
      verdict: 'READY', missing: [],
      claims: { state: 'known', live: 0, newestAgeSec: null },
    });
  });
});
