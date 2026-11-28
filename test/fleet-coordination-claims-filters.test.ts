import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetCoordination } from '../src/cli/fleet-coordination.js';
import { claimFleetWork } from '../src/core/fleet/coordination.js';

const T0 = 1_760_000_000_000;

let dir = '';
let ledgerPath = '';

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'claims-filters-'));
  ledgerPath = join(dir, 'coordination.jsonl');
  vi.stubEnv('PHANTOM_FLEET_LEDGER_PATH', ledgerPath);
  vi.useFakeTimers({ toFake: ['Date'], now: T0 });
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

const lastText = () => String(vi.mocked(console.log).mock.calls.at(-1)![0]);
const at = (offsetMs: number) => vi.setSystemTime(T0 + offsetMs);

async function cli(args: string[]) {
  const calls = vi.mocked(console.log).mock.calls.length;
  const code = await cmdFleetCoordination(args);
  const callsAfter = vi.mocked(console.log).mock.calls.length;
  const text = callsAfter === calls ? '' : lastText();
  return { code, json: (text ? JSON.parse(text) : null) as any, text };
}

const claimsRead = (extra: string[] = []) => cli(['claims', ...extra, '--json']);

function hold(repo: string, task: string, agent: string): string {
  const result = claimFleetWork({ repo, task, agent }, { path: ledgerPath, now: Date.now() });
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error('fixture claim failed');
  return result.value.claim.id;
}

describe('fleet coordination claims read', () => {
  it('narrows live claims by id, agent, repo, window and text', async () => {
    at(0);
    const a = hold('example/demo', 'alpha work', 'agent-a');
    at(1_000);
    const b = hold('other/repo', 'beta work', 'agent-b');
    at(2_000);
    const c = hold('EXAMPLE/DEMO', 'gamma work', 'agent-a');
    at(3_000);

    const all = await claimsRead();
    expect(all.code).toBe(0);
    expect(all.json.state).toBe('known');
    expect(all.json.claims.map((r: any) => r.id)).toEqual([c, b, a]);
    expect(all.json).toMatchObject({ matched: 3, omitted: 0 });

    const byId = await claimsRead(['--id', a]);
    expect(byId.json.claims.map((r: any) => r.id)).toEqual([a]);
    expect(byId.json.matched).toBe(1);

    const byAgent = await claimsRead(['--agent', 'agent-a']);
    expect(byAgent.json.claims.map((r: any) => r.id).sort()).toEqual([a, c].sort());
    expect(byAgent.json.matched).toBe(2);

    // Repo compares case-insensitively against the stored owner/name.
    const byRepo = await claimsRead(['--repo', 'example/demo']);
    expect(byRepo.json.claims.map((r: any) => r.id).sort()).toEqual([a, c].sort());
    expect(byRepo.json.matched).toBe(2);

    // [since, before) on claimedAt: b sits exactly on since, c exactly on before and stays out.
    const window = await claimsRead(['--since', String(T0 + 1_000), '--before', String(T0 + 2_000)]);
    expect(window.json.claims.map((r: any) => r.id)).toEqual([b]);
    expect(window.json.matched).toBe(1);

    const contains = await claimsRead(['--contains', 'BETA']);
    expect(contains.json.claims.map((r: any) => r.id)).toEqual([b]);

    // Dimensions AND together.
    const both = await claimsRead(['--agent', 'agent-a', '--repo', 'other/repo']);
    expect(both.json.claims).toEqual([]);
    expect(both.json.matched).toBe(0);
  });

  it('reaches a claim beyond the unfiltered newest-50 page', async () => {
    const oldest = hold('example/demo', 'oldest work', 'agent-a');
    for (let i = 0; i < 55; i++) {
      at(1_000 + i);
      hold('example/demo', `batch work ${i}`, 'agent-b');
    }
    at(60_000);

    const unfiltered = await claimsRead();
    expect(unfiltered.json.claims).toHaveLength(50);
    expect(unfiltered.json).toMatchObject({ matched: 56, omitted: 6 });
    // The oldest claim is beyond the page; --id still reaches it.
    const filtered = await claimsRead(['--id', oldest]);
    expect(filtered.code).toBe(0);
    expect(filtered.json.claims).toHaveLength(1);
    expect(filtered.json.claims[0].id).toBe(oldest);
    expect(filtered.json).toMatchObject({ matched: 1, omitted: 0 });

    // A filtered-empty read is an honest known empty, never an error or a pad.
    const miss = await claimsRead(['--id', 'never-claimed']);
    expect(miss.code).toBe(0);
    expect(miss.json.state).toBe('known');
    expect(miss.json.claims).toEqual([]);
    expect(miss.json.matched).toBe(0);
  });

  it('keeps expiredClaims on the board total under filters', async () => {
    at(0);
    hold('example/demo', 'alpha work', 'agent-a');
    at(1_000);
    // A claim whose ttl already lapsed counts as expired on the board.
    const stale = claimFleetWork({ repo: 'example/demo', task: 'stale work', agent: 'agent-b', ttlMs: 1 },
      { path: ledgerPath, now: Date.now() });
    expect(stale.ok).toBe(true);
    at(60_000);

    const filtered = await claimsRead(['--agent', 'agent-a']);
    expect(filtered.json.claims).toHaveLength(1);
    expect(filtered.json.expiredClaims).toBe(1);
  });

  it('rejects malformed filter values before reading the ledger', async () => {
    for (const args of [
      ['--id', 'has space'], ['--agent', 'bad from'], ['--repo', 'no-slash'],
      ['--since', 'not-a-time'], ['--before', 'yesterday-ish'],
      ['--contains', '   '], ['--contains', 'x'.repeat(513)], ['--unknown-flag', 'x'],
    ]) {
      const result = await cli(['claims', ...args, '--json']);
      expect(result.code).toBe(2);
      expect(result.text).toBe('');
    }
  });

  it('reports an unreadable ledger as unknown under filters, never a fabricated empty', async () => {
    ledgerPath = join(dir, 'missing', 'coordination.jsonl');
    const result = await claimsRead(['--agent', 'agent-a']);
    expect(result.code).toBe(1);
    expect(result.json).toMatchObject({ state: 'unknown', claims: [], expiredClaims: null,
      matched: null, omitted: null });
  });
});
