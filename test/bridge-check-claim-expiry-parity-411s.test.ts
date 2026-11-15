import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { cmdFleetBridgeCheck } from '../src/cli/fleet-bridge-check.js';
import { formatBridgeCheckReply } from '../src/core/fleet/bridge-check-reply.js';
import { claimFleetWork, releaseFleetClaim } from '../src/core/fleet/coordination.js';
import type { FleetBridgeCheck } from '../src/mcp/fleet-bridge-check.js';

it('keeps CLI and Slack claim evidence aligned through expiry and release without writing on reads', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bridge-expiry-'));
  const ledger = join(dir, 'coordination.jsonl');
  const previous = process.env['PHANTOM_FLEET_LEDGER_PATH'];
  const start = Date.parse('2026-11-15T00:00:00.000Z');
  process.env['PHANTOM_FLEET_LEDGER_PATH'] = ledger;
  const clock = vi.spyOn(Date, 'now').mockReturnValue(start);
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  const deps = { runtime: async () => ({ lastFleetStateRead: { ageSeconds: 1 } }), peers: () => ({ status: 'ok' }) };
  const read = async () => {
    log.mockClear();
    expect(await cmdFleetBridgeCheck(['--json'], deps)).toBe(0);
    expect(log).toHaveBeenCalledTimes(1);
    expect(error).not.toHaveBeenCalled();
    return JSON.parse(String(log.mock.calls[0]![0])) as FleetBridgeCheck;
  };
  try {
    expect(claimFleetWork({ repo: 'example/repo', task: 'expiry', agent: 'dot', ttlMs: 10_000 }).ok).toBe(true);
    const beforeReads = readFileSync(ledger, 'utf8');
    clock.mockReturnValue(start + 5_000);
    const active = await read();
    const afterActive = readFileSync(ledger, 'utf8');
    clock.mockReturnValue(start + 10_000);
    const expired = await read();
    const afterExpiry = readFileSync(ledger, 'utf8');
    for (const [check, offset, live, age] of [[active, 5_000, 1, 5], [expired, 10_000, 0, null]] as const) {
      const asOf = new Date(start + offset).toISOString();
      expect(check).toMatchObject({ verdict: 'READY', asOf, missing: [], claims: { state: 'known', live, newestAgeSec: age } });
      const reply = formatBridgeCheckReply(check, new Date(start + 60_000));
      expect(reply).toContain(`Bridge: READY as of ${asOf}`);
      expect(reply).toContain(`Claims: ${live} live, newest ${age === null ? 'unknown' : `${age}s`}`);
      expect(reply).toContain('Reachability only; this is not an assignment or claim.');
    }
    const second = claimFleetWork({ repo: 'example/repo', task: 'release', agent: 'dot', ttlMs: 10_000 });
    expect(second.ok).toBe(true);
    if (!second.ok) throw new Error('second claim failed');
    expect((await read()).claims.live).toBe(1);
    expect(releaseFleetClaim({ id: second.value.claim.id, agent: 'dot', lease: second.value.lease })).toEqual({ ok: true, value: { released: second.value.claim.id } });
    const afterRelease = readFileSync(ledger, 'utf8');
    expect((await read()).claims).toMatchObject({ live: 0, newestAgeSec: null });
    expect(readFileSync(ledger, 'utf8')).toBe(afterRelease);
    expect(afterActive).toBe(beforeReads);
    expect(afterExpiry).toBe(afterActive);
  } finally {
    if (previous === undefined) delete process.env['PHANTOM_FLEET_LEDGER_PATH'];
    else process.env['PHANTOM_FLEET_LEDGER_PATH'] = previous;
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  }
});
