import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetBridgeCheck } from '../src/cli/fleet-bridge-check.js';
import { claimFleetWork } from '../src/core/fleet/coordination.js';

const NOW = Date.parse('2026-11-15T00:00:00.000Z');
const deps = {
  runtime: async () => ({ lastFleetStateRead: { ageSeconds: 30 } }),
  peers: () => ({ status: 'ok' }),
  now: () => Date.now(),
};

let directory: string;
let ledger: string;
let previousPath: string | undefined;
let log: ReturnType<typeof vi.spyOn>;
let error: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'bridge-disk-'));
  ledger = join(directory, 'coordination.jsonl');
  previousPath = process.env['PHANTOM_FLEET_LEDGER_PATH'];
  process.env['PHANTOM_FLEET_LEDGER_PATH'] = ledger;
  vi.spyOn(Date, 'now').mockReturnValue(NOW);
  log = vi.spyOn(console, 'log').mockImplementation(() => {});
  error = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  if (previousPath === undefined) delete process.env['PHANTOM_FLEET_LEDGER_PATH'];
  else process.env['PHANTOM_FLEET_LEDGER_PATH'] = previousPath;
  vi.restoreAllMocks();
  rmSync(directory, { recursive: true, force: true });
});

async function jsonCheck() {
  log.mockClear();
  error.mockClear();
  const exit = await cmdFleetBridgeCheck(['--json'], deps);
  expect(log).toHaveBeenCalledTimes(1);
  expect(error).not.toHaveBeenCalled();
  return { exit, result: JSON.parse(String(log.mock.calls[0]![0])) };
}

describe('fleet bridge-check against the coordination ledger', () => {
  it('reads a live claim, then observes its expiry at the reader clock', async () => {
    expect(claimFleetWork({ repo: 'example/repo', task: 'reconnect', agent: 'dot', ttlMs: 60_000 })).toMatchObject({ ok: true });
    vi.mocked(Date.now).mockReturnValue(NOW + 30_000);
    const active = await jsonCheck();
    expect(active.exit).toBe(0);
    expect(active.result).toMatchObject({
      verdict: 'READY', asOf: '2026-11-15T00:00:30.000Z', missing: [],
      claims: { state: 'known', status: 'ok', source: 'coordination-ledger', live: 1,
        newestAgeSec: 30, asOf: '2026-11-15T00:00:30.000Z' },
    });

    vi.mocked(Date.now).mockReturnValue(NOW + 60_000);
    const expired = await jsonCheck();
    expect(expired.exit).toBe(0);
    expect(expired.result.claims).toMatchObject({ state: 'known', live: 0, newestAgeSec: null });
  });

  it('reports a private empty ledger as known zero in JSON and human output', async () => {
    writeFileSync(ledger, '', { mode: 0o600 });
    const { exit, result } = await jsonCheck();
    expect(exit).toBe(0);
    expect(result).toMatchObject({ verdict: 'READY', missing: [], claims: { state: 'known', live: 0, newestAgeSec: null } });
    log.mockClear();
    expect(await cmdFleetBridgeCheck([], deps)).toBe(0);
    expect(String(log.mock.calls[0]![0])).toMatch(/claims:\s*0 live/);
    expect(error).not.toHaveBeenCalled();
  });

  it('fails closed on corruption without leaking it, then rereads a repaired ledger', async () => {
    const privateContent = 'private-ledger-content-409s';
    writeFileSync(ledger, `${privateContent}\n`, { mode: 0o600 });
    const blocked = await jsonCheck();
    expect(blocked.exit).toBe(3);
    expect(blocked.result).toMatchObject({ verdict: 'BLOCKED', missing: ['claims'], claims: { state: 'unknown', live: null } });
    expect(JSON.stringify(blocked.result)).not.toContain(privateContent);
    log.mockClear();
    expect(await cmdFleetBridgeCheck([], deps)).toBe(3);
    const human = String(log.mock.calls[0]![0]);
    expect(human).not.toContain(privateContent);
    expect(human).toMatch(/missing:.*claims/);
    expect(human).toMatch(/no claim, dispatch or merge authority/i);

    writeFileSync(ledger, '', { mode: 0o600 });
    expect(claimFleetWork({ repo: 'example/repo', task: 'repaired', agent: 'dot' })).toMatchObject({ ok: true });
    const recovered = await jsonCheck();
    expect(recovered.exit).toBe(0);
    expect(recovered.result).toMatchObject({ verdict: 'READY', missing: [], claims: { state: 'known', live: 1 } });
  });
});
