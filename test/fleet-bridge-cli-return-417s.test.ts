import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cmdFleetBridgeCheck } from '../src/cli/fleet-bridge-check.js';
import { claimFleetWork, readFleetBoard } from '../src/core/fleet/coordination.js';
import { returnFleetClaim } from '../src/core/fleet/coordination-return.js';
import { projectCoordinationReturns } from '../src/core/fleet/coordination-returns-view.js';

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
  directory = mkdtempSync(join(tmpdir(), 'bridge-return-'));
  ledger = join(directory, 'coordination.jsonl');
  writeFileSync(ledger, '', { mode: 0o600 });
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

async function check(live: number, age: number | null) {
  const before = readFileSync(ledger);
  log.mockClear();
  error.mockClear();
  expect(await cmdFleetBridgeCheck(['--json'], deps)).toBe(0);
  expect(log).toHaveBeenCalledTimes(1);
  const result = JSON.parse(String(log.mock.calls[0]![0]));
  expect(result).toMatchObject({ verdict: 'READY', missing: [],
    claims: { state: 'known', source: 'coordination-ledger', live, newestAgeSec: age } });
  log.mockClear();
  expect(await cmdFleetBridgeCheck([], deps)).toBe(0);
  expect(log).toHaveBeenCalledTimes(1);
  expect(String(log.mock.calls[0]![0])).toContain(`claims: ${live} live, newest ${age ?? 'unknown'}s`);
  expect(error).not.toHaveBeenCalled();
  expect(readFileSync(ledger)).toEqual(before);
}

it('observes an owner return and a distinct subsequent claim through the CLI disk reader', async () => {
  await check(0, null);
  const first = claimFleetWork({ repo: 'example/fixture', task: 'first task', agent: 'fixture-agent', ttlMs: 60_000 });
  expect(first.ok).toBe(true);
  if (!first.ok) throw new Error('fixture claim failed');
  vi.mocked(Date.now).mockReturnValue(NOW + 10_000);
  await check(1, 10);

  const returned = returnFleetClaim({ id: first.value.claim.id, agent: 'fixture-agent',
    lease: first.value.lease, pr: 417, head: 'abcdef1234567' });
  expect(returned).toMatchObject({ ok: true, outcome: 'returned' });
  expect(Date.now()).toBeLessThan(first.value.claim.expiresAt);
  await check(0, null);
  const receipt = projectCoordinationReturns(readFleetBoard(), Date.now());
  expect(receipt).toMatchObject({ state: 'known', unparsed: 0, returns: [{
    claimId: first.value.claim.id, repo: 'example/fixture', from: 'fixture-agent',
    result: 'VERIFIED', evidenceKind: 'pr', pr: 417, head: 'abcdef1234567', temporal: 'current',
  }] });
  expect(receipt.returns).toHaveLength(1);
  expect(JSON.parse(JSON.stringify(receipt)).returns[0].temporal).toBe('current');

  vi.mocked(Date.now).mockReturnValue(NOW + 20_000);
  const next = claimFleetWork({ repo: 'example/fixture', task: 'second task', agent: 'fixture-agent', ttlMs: 60_000 });
  expect(next.ok).toBe(true);
  if (!next.ok) throw new Error('second fixture claim failed');
  expect(next.value.claim.id).not.toBe(first.value.claim.id);
  await check(1, 0);
});
