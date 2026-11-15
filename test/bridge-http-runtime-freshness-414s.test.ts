/** Desktop bridge HTTP freshness qualification: GET
 * /api/verse/fleet/runtime-identity/bridge-check served by the real route
 * chain createFleetRuntimeIdentityApi -> createFleetBridgeCheckApi ->
 * readFleetBridgeCheck -> readFleetRuntime over a private temporary stateRoot
 * holding the actual on-disk dispatchd layout. The runtime snapshot and the
 * freshness verdict are never stubbed; only OS/process/tailnet seams and the
 * unrelated peer-health section are synthetic. No sleeps: the clock and file
 * mtimes are controlled directly, so a current response timestamp can never
 * launder yesterday's fleet state into READY. */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiModule } from '../src/core/verse/api-modules.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';
import { createFleetBridgeCheckApi, VERSE_FLEET_BRIDGE_CHECK_PATH as PATH } from '../src/core/verse/fleet-bridge-check-api.js';
import { createFleetRuntimeIdentityApi } from '../src/core/verse/fleet-runtime-identity-api.js';
import { claimFleetWork, readFleetBoard } from '../src/core/fleet/coordination.js';
import { readClaimExecution } from '../src/core/fleet/claim-execution-evidence.js';
import { STALE_AFTER_SECONDS } from '../src/core/fleet/runtime-identity.js';
import type { FleetRuntimeDeps } from '../src/core/fleet/runtime-snapshot.js';
import { readFleetBridgeCheck } from '../src/mcp/fleet-bridge-check.js';
import { readFleetRuntime } from '../src/mcp/fleet-runtime.js';

const T0 = Date.parse('2026-11-13T13:13:00.000Z');
const T0_ISO = '2026-11-13T13:13:00.000Z';
const MTIME = T0 - 30_000;
const MTIME_ISO = new Date(MTIME).toISOString();
const DAY_MS = 24 * 60 * 60_000;

let home: string;
let runsDir: string;
let ledger: string;
let now: number;

/** Deterministic file freshness: set every regular file's mtime under root. */
function stampTree(root: string, ms: number): void {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) stampTree(path, ms);
    else if (entry.isFile()) utimesSync(path, new Date(ms), new Date(ms));
  }
}

/** Content snapshot of every file under the state root plus the ledger, so a
 * GET can be proven byte-for-byte read-only. */
function treeBytes(root: string, prefix = ''): Record<string, Buffer> {
  const out: Record<string, Buffer> = {};
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    const key = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) Object.assign(out, treeBytes(path, key));
    else if (entry.isFile()) out[key] = readFileSync(path);
  }
  return out;
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'bridge-http-freshness-414s-'));
  runsDir = join(home, '.ashlr-runs');
  // The real dispatchd projection layout readFleetRunsDirState consumes.
  mkdirSync(join(runsDir, 'queue'), { recursive: true });
  mkdirSync(join(runsDir, 'metrics'), { recursive: true });
  mkdirSync(join(runsDir, 'leader', 'drop', 'done'), { recursive: true });
  writeFileSync(join(runsDir, 'queue', 'status.json'), JSON.stringify({
    schema: 'dispatchd.status.v1', last_tick: T0_ISO, paused: null, mem_free_pct: 42.5,
    lanes: { devin: { running: 0, target: 1, floor: null, ceiling: null, queued: 0, held: false } },
  }));
  writeFileSync(join(runsDir, 'queue', 'claimed.tsv'), '');
  writeFileSync(join(runsDir, 'dispatch-events.log'), '');
  writeFileSync(join(runsDir, 'metrics', 'jobs.jsonl'), '');
  writeFileSync(join(runsDir, 'queue', 'claude-lane.state'), '');
  ledger = join(home, 'coordination.jsonl');
  writeFileSync(ledger, '', { mode: 0o600 });
  now = T0;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  vi.stubEnv('PHANTOM_FLEET_LEDGER_PATH', ledger);
  stampTree(runsDir, MTIME);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  rmSync(home, { recursive: true, force: true });
});

/** Bounded OS seams only: identity labels, the process table (empty healthy
 * snapshot stamped at the live clock) and the tailnet name. The board reader
 * stays the real readFleetBoard against the temp ledger via the env path. */
function runtimeDeps(): FleetRuntimeDeps {
  return {
    now: () => now,
    home: () => home,
    host: () => 'fake-host-414s',
    platform: () => 'linux',
    arch: () => 'x64',
    pid: () => 4142,
    uptime: () => 120,
    stateRoot: () => runsDir,
    installedVersion: () => '9.9.9',
    sourceVersion: () => '9.9.9',
    tailnet: () => 'fake-tail-414s',
    board: readFleetBoard,
    execution: () => readClaimExecution({
      now: () => now,
      workers: async () => ({
        v: 1, generatedAt: new Date(now).toISOString(), sourceState: 'healthy' as const,
        workers: [], leaders: [], orchestratorAgents: 0,
      }),
    }),
  };
}

/** The real HTTP chain under test: the identity module delegates the bridge
 * path to the bridge-check module, whose read is the real readFleetBridgeCheck
 * composition. Only the peer-ledger section (unrelated peer health) and the
 * clocks are synthetic; runtime, claims and the freshness verdict are real. */
function bridgeApi(): ApiModule {
  const bridgeCheck = createFleetBridgeCheckApi({
    read: () => readFleetBridgeCheck({
      runtime: () => readFleetRuntime(runtimeDeps()),
      peers: () => ({ v: 1, authority: 'none' as const, status: 'ok', asOf: new Date(now).toISOString() }),
      now: () => now,
    }),
    now: () => new Date(now),
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

describe('bridge-check HTTP runtime freshness over real fleet state (414s)', () => {
  it('serves READY on fresh files, BLOCKED on stale state, then READY on repair — on one handler', async () => {
    // A real claimFleetWork record on the temp ledger: live count and age are
    // measured evidence, and the check itself never writes the ledger.
    expect(claimFleetWork({ repo: 'ashlrai/phantom',
      task: 'RQ-PHX-BRIDGEHTTPFRESH414S desktop reconnect', agent: 'mason',
      ttlMs: 3_600_000 })).toMatchObject({ ok: true });
    const api = bridgeApi();
    const before = { ...treeBytes(runsDir), ledger: readFileSync(ledger) };
    const unchanged = () => expect({ ...treeBytes(runsDir), ledger: readFileSync(ledger) }).toEqual(before);

    // Fresh on-disk state at the controlled clock: READY inside the v:1 envelope.
    const fresh = await get(api);
    expect(fresh).toMatchObject({ handled: true, status: 200 });
    expect(fresh.body).toMatchObject({ v: 1, authority: 'none' });
    expect(fresh.body.check).toMatchObject({
      verdict: 'READY', asOf: T0_ISO, missing: [],
      claims: { status: 'ok', state: 'known', source: 'coordination-ledger', live: 1,
        newestAgeSec: 0, asOf: T0_ISO },
      peers: { status: 'ok', source: 'peer-ledger', asOf: T0_ISO },
      runtime: { status: 'ok', source: 'fleet-runtime', asOf: T0_ISO,
        host: 'fake-host-414s', tailnetName: 'fake-tail-414s',
        stateRoot: '~/.ashlr-runs',
        lastFleetStateRead: { mtime: MTIME_ISO, ageSeconds: 30 },
        coordination: { state: 'known', activeClaims: 1 },
        execution: { state: 'known' } },
    });
    // Sanitized snapshot identity: no host paths or fixture contents leak.
    expect(fresh.text).not.toContain(home);
    expect(fresh.text).not.toContain('mem_free_pct');
    unchanged();

    // Advance past STALE_AFTER_SECONDS with unchanged mtimes: the same handler
    // answers BLOCKED naming runtime.fleet-state-stale. The response asOf is the
    // current clock, yet the evidence age keeps growing — a fresh timestamp
    // never refreshes old fleet state into READY.
    now = T0 + STALE_AFTER_SECONDS * 1000;
    const stale = await get(api);
    expect(stale.status).toBe(200);
    expect(stale.body).toMatchObject({ v: 1, authority: 'none' });
    expect(stale.body.check).toMatchObject({
      verdict: 'BLOCKED', asOf: new Date(now).toISOString(),
      missing: ['runtime.fleet-state-stale'],
      claims: { state: 'known', live: 1, newestAgeSec: 900 },
      runtime: { reason: 'fleet-state-stale', asOf: new Date(now).toISOString(),
        lastFleetStateRead: { mtime: MTIME_ISO, ageSeconds: 930 },
        coordination: { state: 'known' }, execution: { state: 'known' } },
    });
    unchanged();

    // Repair on the same running handler: refreshed mtimes at the live clock
    // restore READY with zero-age evidence.
    stampTree(runsDir, now);
    const repaired = await get(api);
    expect(repaired.body.check).toMatchObject({
      verdict: 'READY', missing: [], asOf: new Date(now).toISOString(),
      runtime: { lastFleetStateRead: { mtime: new Date(now).toISOString(), ageSeconds: 0 } },
    });
    unchanged();

    // Yesterday's host snapshot must never read READY: stamp the whole state
    // tree a day old while the response clock stays current.
    stampTree(runsDir, now - DAY_MS);
    const yesterday = await get(api);
    expect(yesterday.body.check).toMatchObject({
      verdict: 'BLOCKED', asOf: new Date(now).toISOString(),
      missing: ['runtime.fleet-state-stale'],
      runtime: { reason: 'fleet-state-stale',
        lastFleetStateRead: { mtime: new Date(now - DAY_MS).toISOString(), ageSeconds: DAY_MS / 1000 } },
    });
    unchanged();

    // Fresh files again recover READY on the same handler — no restart.
    stampTree(runsDir, now);
    const recovered = await get(api);
    expect(recovered.body.check).toMatchObject({ verdict: 'READY', missing: [] });
    unchanged();
  });
});
