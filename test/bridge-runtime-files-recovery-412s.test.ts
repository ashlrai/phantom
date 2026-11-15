/** Dot's reconnect check qualified against a real runtime snapshot whose
 * on-disk fleet state goes stale and then recovers on the same running
 * readers: cmdFleetBridgeCheck --json -> readFleetBridgeCheck ->
 * readFleetRuntime -> readRuntimeSnapshot/readFleetRunsDirState over a
 * temporary stateRoot, with the real coordination ledger reader/writer on a
 * private temp ledger. Only bounded OS seams (host identity, process table,
 * tailnet, peer ledger, verdict peers fixture) are substituted; the runtime
 * snapshot itself is never stubbed. No sleeps: the clock and file mtimes are
 * controlled directly. */
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetBridgeCheck } from '../src/cli/fleet-bridge-check.js';
import { claimFleetWork, readFleetBoard } from '../src/core/fleet/coordination.js';
import { readClaimExecution } from '../src/core/fleet/claim-execution-evidence.js';
import { STALE_AFTER_SECONDS } from '../src/core/fleet/runtime-identity.js';
import type { FleetRuntimeDeps } from '../src/core/fleet/runtime-snapshot.js';
import { readFleetRuntime } from '../src/mcp/fleet-runtime.js';

const T0 = Date.parse('2026-11-15T00:00:00.000Z');
const T0_ISO = '2026-11-15T00:00:00.000Z';
const MTIME = T0 - 30_000;
const MTIME_ISO = new Date(MTIME).toISOString();

let home: string;
let runsDir: string;
let statusPath: string;
let ledger: string;
let now: number;
let log: ReturnType<typeof vi.spyOn>;
let error: ReturnType<typeof vi.spyOn>;

/** Deterministic file freshness: set every regular file's mtime under root. */
function stampTree(root: string, ms: number): void {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) stampTree(path, ms);
    else if (entry.isFile()) utimesSync(path, new Date(ms), new Date(ms));
  }
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'bridge-runtime-files-412s-'));
  runsDir = join(home, '.ashlr-runs');
  // The real dispatchd projection layout readFleetRunsDirState consumes.
  mkdirSync(join(runsDir, 'queue'), { recursive: true });
  mkdirSync(join(runsDir, 'metrics'), { recursive: true });
  mkdirSync(join(runsDir, 'leader', 'drop', 'done'), { recursive: true });
  statusPath = join(runsDir, 'queue', 'status.json');
  writeFileSync(statusPath, JSON.stringify({
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
  log = vi.spyOn(console, 'log').mockImplementation(() => {});
  error = vi.spyOn(console, 'error').mockImplementation(() => {});
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
    host: () => 'fake-host-412s',
    platform: () => 'fakeos',
    arch: () => 'fakearch',
    pid: () => 4122,
    uptime: () => 120,
    stateRoot: () => runsDir,
    installedVersion: () => '9.9.9',
    sourceVersion: () => '9.9.9',
    tailnet: () => 'fake-tail-412s',
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

function bridgeDeps(runtime: () => Promise<unknown>) {
  return {
    runtime,
    peers: () => ({ v: 1, authority: 'none' as const, status: 'ok', asOf: new Date(now).toISOString() }),
    now: () => now,
  };
}

async function jsonCheck(deps: ReturnType<typeof bridgeDeps>) {
  log.mockClear();
  error.mockClear();
  const exit = await cmdFleetBridgeCheck(['--json'], deps);
  expect(log).toHaveBeenCalledTimes(1);
  expect(error).not.toHaveBeenCalled();
  return { exit, result: JSON.parse(String(log.mock.calls[0]![0])) };
}

describe('fleet bridge-check over a real runtime snapshot with recovering state files (412s)', () => {
  it('reads READY, goes BLOCKED on stale fleet state, then recovers on the same readers', async () => {
    // A real claimFleetWork record on the temp ledger: live count and age are
    // measured evidence, and the check itself never writes the ledger.
    expect(claimFleetWork({ repo: 'ashlrai/phantom',
      task: 'RQ-PHX-BRIDGERUNTIMEFRESH412S reconnect check', agent: 'dot' })).toMatchObject({ ok: true });
    const ledgerBytes = readFileSync(ledger);
    const statusBytes = readFileSync(statusPath);
    const deps = runtimeDeps();
    const runtimeReader = vi.fn(() => readFleetRuntime(deps));
    const bridge = bridgeDeps(runtimeReader);

    // Fresh on-disk state at the controlled clock: READY, exit 0.
    const fresh = await jsonCheck(bridge);
    expect(fresh.exit).toBe(0);
    expect(fresh.result).toMatchObject({
      verdict: 'READY', asOf: T0_ISO, missing: [],
      claims: { status: 'ok', state: 'known', source: 'coordination-ledger', live: 1,
        newestAgeSec: 0, asOf: T0_ISO },
      peers: { status: 'ok', source: 'peer-ledger', asOf: T0_ISO },
    });
    expect(fresh.result.runtime).toMatchObject({
      status: 'ok', source: 'fleet-runtime', asOf: T0_ISO, host: 'fake-host-412s',
      stateRoot: '~/.ashlr-runs',
      lastFleetStateRead: { mtime: MTIME_ISO, ageSeconds: 30 },
      coordination: { state: 'known', activeClaims: 1 },
      execution: { state: 'known' },
    });
    // The snapshot reports freshness only; fixture contents and host paths stay out.
    const freshText = JSON.stringify(fresh.result);
    expect(freshText).not.toContain(home);
    expect(freshText).not.toContain('mem_free_pct');
    // Human output keeps the explicit no-authority line even with a live claim.
    log.mockClear();
    expect(await cmdFleetBridgeCheck([], bridge)).toBe(0);
    expect(String(log.mock.calls[0]![0])).toMatch(/no claim, dispatch or merge authority/);

    // Advance past STALE_AFTER_SECONDS with unchanged mtimes: the same readers
    // report BLOCKED, exit 3, naming the stale fleet-state freshness.
    now = T0 + STALE_AFTER_SECONDS * 1000;
    const stale = await jsonCheck(bridge);
    expect(stale.exit).toBe(3);
    expect(stale.result).toMatchObject({
      verdict: 'BLOCKED', asOf: new Date(now).toISOString(),
      missing: ['runtime.fleet-state-stale'],
      claims: { state: 'known', live: 1, newestAgeSec: 900 },
    });
    expect(stale.result.runtime).toMatchObject({
      reason: 'fleet-state-stale',
      lastFleetStateRead: { mtime: MTIME_ISO, ageSeconds: 930 },
      coordination: { state: 'known' }, execution: { state: 'known' },
    });

    // Touching the fixture state at the new clock restores READY on the same
    // running reader — no restart, no re-injection.
    const callsBefore = runtimeReader.mock.calls.length;
    stampTree(runsDir, now);
    const recovered = await jsonCheck(bridge);
    expect(runtimeReader.mock.calls.length).toBe(callsBefore + 1);
    expect(recovered.exit).toBe(0);
    expect(recovered.result).toMatchObject({ verdict: 'READY', missing: [],
      asOf: new Date(now).toISOString() });
    expect(recovered.result.runtime.lastFleetStateRead).toEqual({
      mtime: new Date(now).toISOString(), ageSeconds: 0,
    });

    // An unavailable state directory is unknown evidence, never zero-age.
    const away = join(home, 'runs-away');
    renameSync(runsDir, away);
    const gone = await jsonCheck(bridge);
    expect(gone.exit).toBe(3);
    expect(gone.result).toMatchObject({ verdict: 'BLOCKED', missing: ['runtime.fleet-state'],
      claims: { state: 'known', live: 1 } });
    expect(gone.result.runtime).toMatchObject({
      reason: 'fleet-state-unreadable',
      lastFleetStateRead: { mtime: 'UNKNOWN', ageSeconds: 'UNKNOWN' },
    });

    // Restoring the directory and refreshing mtimes recovers READY again.
    renameSync(away, runsDir);
    stampTree(runsDir, now);
    const restored = await jsonCheck(bridge);
    expect(restored.exit).toBe(0);
    expect(restored.result).toMatchObject({ verdict: 'READY', missing: [] });

    // Reads never mutated the ledger or the fixture state contents.
    expect(readFileSync(ledger)).toEqual(ledgerBytes);
    expect(readFileSync(statusPath)).toEqual(statusBytes);
  });
});
