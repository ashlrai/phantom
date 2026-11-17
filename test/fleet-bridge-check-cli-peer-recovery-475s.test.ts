import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { cmdFleetBridgeCheck } from '../src/cli/fleet-bridge-check.js';
import { claimFleetWork } from '../src/core/fleet/coordination.js';

it('reprojects expired claims when peers time out, recover, and a new claim arrives', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bridge-peer-475s-'));
  const path = join(dir, 'ledger.jsonl');
  const previous = process.env['PHANTOM_FLEET_LEDGER_PATH'];
  const start = Date.parse('2026-11-15T00:00:00.000Z');
  let now = start;
  let recover = false;
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.useFakeTimers();
  vi.setSystemTime(start);
  process.env['PHANTOM_FLEET_LEDGER_PATH'] = path;
  const deps = {
    now: () => now,
    deadlineMs: 10,
    runtime: () => ({ host: 'synthetic-host', lastFleetStateRead: { ageSeconds: 1 } }),
    peers: () => recover ? Promise.resolve({ status: 'ok' }) : new Promise<never>(() => {}),
  };
  try {
    expect(claimFleetWork({ repo: 'example/repo', task: 'old', agent: 'synthetic-owner', ttlMs: 60_000 }, { path, now })).toMatchObject({ ok: true });
    const before = readFileSync(path);
    const pending = cmdFleetBridgeCheck(['--json'], deps);
    await vi.advanceTimersByTimeAsync(1);
    now = start + 60_000;
    await vi.advanceTimersByTimeAsync(10);
    expect(await pending).toBe(3);
    expect(JSON.parse(String(log.mock.calls[0]![0]))).toMatchObject({
      verdict: 'BLOCKED', asOf: new Date(now).toISOString(), missing: ['peers'],
      peers: { status: 'unavailable', reason: 'peers-reader-timeout' },
      claims: { status: 'ok', state: 'known', live: 0, newestAgeSec: null, asOf: new Date(now).toISOString() },
      runtime: { status: 'ok', source: 'fleet-runtime', host: 'synthetic-host' },
    });
    expect(readFileSync(path)).toEqual(before);
    recover = true;
    log.mockClear();
    expect(await cmdFleetBridgeCheck(['--json'], deps)).toBe(0);
    expect(JSON.parse(String(log.mock.calls[0]![0]))).toMatchObject({ verdict: 'READY', missing: [], claims: { live: 0 }, runtime: { host: 'synthetic-host' } });
    log.mockClear();
    expect(await cmdFleetBridgeCheck([], deps)).toBe(0);
    expect(String(log.mock.calls[0]![0])).toContain('Reachability only; grants no claim, dispatch or merge authority.');
    expect(readFileSync(path)).toEqual(before);
    expect(claimFleetWork({ repo: 'example/repo', task: 'new', agent: 'synthetic-peer', ttlMs: 60_000 }, { path, now })).toMatchObject({ ok: true });
    const after = readFileSync(path);
    log.mockClear();
    expect(await cmdFleetBridgeCheck(['--json'], deps)).toBe(0);
    expect(JSON.parse(String(log.mock.calls[0]![0]))).toMatchObject({ verdict: 'READY', claims: { live: 1, newestAgeSec: 0 } });
    expect(readFileSync(path)).toEqual(after);
    expect(error).not.toHaveBeenCalled();
  } finally {
    if (previous === undefined) delete process.env['PHANTOM_FLEET_LEDGER_PATH'];
    else process.env['PHANTOM_FLEET_LEDGER_PATH'] = previous;
    vi.useRealTimers();
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  }
});
