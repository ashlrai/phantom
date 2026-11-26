import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetCoordination } from '../src/cli/fleet-coordination.js';
import { claimFleetWork } from '../src/core/fleet/coordination.js';
import { parseCoordinationClaimsFilters, projectCoordinationClaims } from '../src/core/fleet/coordination-claims-view.js';

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

/** Seed one live claim at the current fake clock; returns its id. */
function seed(repo: string, task: string, agent: string): string {
  const result = claimFleetWork({ repo, task, agent, ttlMs: 3_600_000 }, { path: ledgerPath, now: Date.now() });
  if (!result.ok) throw new Error(`fixture claim failed: ${result.error}`);
  return result.value.claim.id;
}

describe('fleet coordination claims filters', () => {
  it('narrows live claims by agent, excludeAgent, repo, id, window and text', async () => {
    at(0);
    const c1 = seed('example/demo', 'alpha work', 'agent-a');
    at(1_000);
    const c2 = seed('other/repo', 'beta work', 'agent-b');
    at(2_000);
    const c3 = seed('example/demo', 'gamma work', 'agent-a');
    at(3_000);

    const all = await claimsRead();
    expect(all.code).toBe(0);
    expect(all.json.state).toBe('known');
    expect(all.json.claims.map((c: any) => c.id)).toEqual([c3, c2, c1]);
    expect(all.json.matched).toBe(3);
    expect(all.json.omitted).toBe(0);

    const agent = await claimsRead(['--agent', 'agent-a']);
    expect(agent.json.claims.map((c: any) => c.id)).toEqual([c3, c1]);
    expect(agent.json.matched).toBe(2);

    const exclude = await claimsRead(['--exclude-agent', 'agent-a']);
    expect(exclude.json.claims.map((c: any) => c.id)).toEqual([c2]);
    expect(exclude.json.matched).toBe(1);

    // Repo compares case-insensitively against the stored owner/name.
    const repo = await claimsRead(['--repo', 'EXAMPLE/Demo']);
    expect(repo.json.claims.map((c: any) => c.id).sort()).toEqual([c1, c3].sort());

    const id = await claimsRead(['--id', c2]);
    expect(id.json.claims.map((c: any) => c.id)).toEqual([c2]);

    // [since, before) on claimedAt: c2 sits exactly on since, c3 exactly on
    // before and stays out.
    const window = await claimsRead(['--since', String(T0 + 1_000), '--before', String(T0 + 2_000)]);
    expect(window.json.claims.map((c: any) => c.id)).toEqual([c2]);

    const contains = await claimsRead(['--contains', 'GAMMA']);
    expect(contains.json.claims.map((c: any) => c.id)).toEqual([c3]);

    // Dimensions AND together.
    const both = await claimsRead(['--agent', 'agent-a', '--repo', 'example/demo', '--contains', 'alpha']);
    expect(both.json.claims.map((c: any) => c.id)).toEqual([c1]);
  });

  it('reaches a claim beyond the unfiltered newest-50 page', async () => {
    // One oldest claim on a distinct owner, then 54 newer bulk claims.
    at(0);
    const oldest = seed('example/demo', 'oldest held work', 'agent-z');
    for (let i = 0; i < 54; i++) {
      at(1_000 + i * 1_000);
      seed('example/demo', `bulk work ${i}`, 'agent-a');
    }
    at(60_000);

    const unfiltered = await claimsRead();
    expect(unfiltered.json.claims).toHaveLength(50);
    expect(unfiltered.json.matched).toBe(55);
    expect(unfiltered.json.omitted).toBe(5);
    expect(unfiltered.json.claims.some((c: any) => c.id === oldest)).toBe(false);

    // --agent narrows before the page, so the oldest claim is reachable.
    const held = await claimsRead(['--agent', 'agent-z']);
    expect(held.code).toBe(0);
    expect(held.json.claims).toHaveLength(1);
    expect(held.json.claims[0].id).toBe(oldest);
    expect(held.json.matched).toBe(1);
    expect(held.json.omitted).toBe(0);

    // A filtered-empty read is an honest known empty, never an error or a pad.
    const miss = await claimsRead(['--id', 'never-claimed']);
    expect(miss.code).toBe(0);
    expect(miss.json.state).toBe('known');
    expect(miss.json.claims).toEqual([]);
    expect(miss.json.matched).toBe(0);
    expect(miss.json.omitted).toBe(0);
  });

  it('rejects malformed filter values before reading the ledger', async () => {
    for (const args of [
      ['--agent', 'has space'], ['--exclude-agent', 'bad agent'], ['--repo', 'no-slash'],
      ['--id', 'has space'], ['--since', 'not-a-time'], ['--before', 'yesterday-ish'],
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
    expect(result.json).toMatchObject({ state: 'unknown', claims: [], expiredClaims: null });
    expect(result.json.matched).toBeNull();
    expect(result.json.omitted).toBeNull();
  });
});

describe('parseCoordinationClaimsFilters', () => {
  it('resolves the shared time grammar once and normalizes repo and needle', () => {
    const parsed = parseCoordinationClaimsFilters({
      agent: 'agent-a', excludeAgent: 'agent-b', repo: 'Owner/Name', id: 'claim-1',
      since: '1h', contains: '  Two   Words ',
    }, T0);
    expect(parsed).toEqual({ ok: true, filters: {
      agent: 'agent-a', excludeAgent: 'agent-b', repo: 'owner/name', id: 'claim-1',
      since: T0 - 3_600_000, contains: 'two words',
    } });
    expect(parseCoordinationClaimsFilters({ since: 'bogus' }, T0).ok).toBe(false);
    expect(parseCoordinationClaimsFilters({ repo: 'no-slash' }, T0).ok).toBe(false);
    expect(parseCoordinationClaimsFilters({ agent: 'bad agent' }, T0).ok).toBe(false);
  });
});

describe('projectCoordinationClaims filters', () => {
  it('filters the live set before the 50-claim page and keeps counts honest', () => {
    const board = {
      schema: 'fleet.coordination.v1' as const, state: 'known' as const,
      expiredClaims: 0, messages: [], proposals: [],
      claims: Array.from({ length: 60 }, (_, i) => ({
        id: `claim-k${i}`, repo: 'example/demo', task: `work item ${i}`, agent: i % 2 ? 'agent-b' : 'agent-a',
        claimedAt: 1000 + i, expiresAt: 1000 + i + 60_000,
      })),
    };
    const wide = projectCoordinationClaims(board, 2000, { contains: 'item 5' });
    expect(wide.state).toBe('known');
    if (wide.state !== 'known') return;
    // 'item 5' substring-matches item 5 and item 50..59 — the needle is a
    // substring over the displayed text, so all eleven claims stay.
    expect(wide.claims).toHaveLength(11);
    expect(wide.claims[0]!.id).toBe('claim-k59');
    expect(wide.matched).toBe(11);
    expect(wide.omitted).toBe(0);

    const single = projectCoordinationClaims(board, 2000, { id: 'claim-k42' });
    if (single.state === 'known') {
      expect(single.claims.map(c => c.id)).toEqual(['claim-k42']);
      expect(single.matched).toBe(1);
    }
    // [1010, 1012) keeps k10 (at=1010, since inclusive) and k11 (at=1011)
    // while k12 (at=1012, before exclusive) stays out.
    const windowed = projectCoordinationClaims(board, 2000, { since: 1010, before: 1012 });
    if (windowed.state === 'known') {
      expect(windowed.claims.map(c => c.id)).toEqual(['claim-k11', 'claim-k10']);
      expect(windowed.matched).toBe(2);
    }
    // An unfiltered read over 60 claims still reports the honest page split.
    const all = projectCoordinationClaims(board, 2000);
    if (all.state === 'known') {
      expect(all.claims).toHaveLength(50);
      expect(all.matched).toBe(60);
      expect(all.omitted).toBe(10);
    }
    // An unknown board reports unknown counts, never an invented zero.
    const unknown = projectCoordinationClaims({ ...board, state: 'unknown' as const, expiredClaims: null }, 2000, { agent: 'agent-a' });
    expect(unknown).toMatchObject({ state: 'unknown', claims: [], matched: null, omitted: null });
    // The board itself is never mutated by a filtered projection.
    expect(board.claims).toHaveLength(60);
  });
});
