import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetCoordination } from '../src/cli/fleet-coordination.js';
import { postFleetMessage } from '../src/core/fleet/coordination.js';
import { parseCoordinationReturnsFilters, projectCoordinationReturns } from '../src/core/fleet/coordination-returns-view.js';

const T0 = 1_760_000_000_000;

let dir = '';
let ledgerPath = '';

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'returns-filters-'));
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

const returnsRead = (extra: string[] = []) => cli(['returns', ...extra, '--json']);

describe('fleet coordination returns filters', () => {
  it('narrows parsed receipts by claim, repo, verdict, sender, window and text', async () => {
    // Verified pr receipt from agent-a on example/demo at T0.
    at(0);
    expect(postFleetMessage({ id: 'return-c1', from: 'agent-a', to: 'all',
      body: 'RESULT VERIFIED example/demo claim c1 task "Work": pr #42 head abc1234' },
      { path: ledgerPath, now: Date.now() }).ok).toBe(true);
    // Verified tests receipt from agent-b on other/repo at T0+1000.
    at(1_000);
    expect(postFleetMessage({ id: 'return-c2', from: 'agent-b', to: 'all',
      body: 'RESULT VERIFIED other/repo claim c2 task "Work": tests lint clean' },
      { path: ledgerPath, now: Date.now() }).ok).toBe(true);
    // Blocked dependency receipt from agent-a on example/demo at T0+2000.
    at(2_000);
    expect(postFleetMessage({ id: 'return-c3', from: 'agent-a', to: 'all',
      body: 'RESULT BLOCKED example/demo claim c3 task "Work": dependency upstream red' },
      { path: ledgerPath, now: Date.now() }).ok).toBe(true);
    at(3_000);

    const all = await returnsRead();
    expect(all.code).toBe(0);
    expect(all.json.state).toBe('known');
    expect(all.json.returns.map((r: any) => r.claimId)).toEqual(['c3', 'c2', 'c1']);
    expect(all.json.coverage).toMatchObject({ parsedTotal: 3, matched: 3, omitted: 0, unparsed: 0 });

    const claim = await returnsRead(['--claim', 'c1']);
    expect(claim.json.returns.map((r: any) => r.claimId)).toEqual(['c1']);
    expect(claim.json.coverage.matched).toBe(1);

    // Repo compares case-insensitively against the stored owner/name.
    const repo = await returnsRead(['--repo', 'EXAMPLE/Demo']);
    expect(repo.json.returns.map((r: any) => r.claimId).sort()).toEqual(['c1', 'c3']);

    const blocked = await returnsRead(['--result', 'BLOCKED']);
    expect(blocked.json.returns.map((r: any) => r.claimId)).toEqual(['c3']);

    const from = await returnsRead(['--from', 'agent-b']);
    expect(from.json.returns.map((r: any) => r.claimId)).toEqual(['c2']);

    // [since, before) on the receipt's at stamp: c2 sits exactly on since,
    // c3 exactly on before and stays out.
    const window = await returnsRead(['--since', String(T0 + 1_000), '--before', String(T0 + 2_000)]);
    expect(window.json.returns.map((r: any) => r.claimId)).toEqual(['c2']);

    const contains = await returnsRead(['--contains', 'LINT']);
    expect(contains.json.returns.map((r: any) => r.claimId)).toEqual(['c2']);

    // Dimensions AND together.
    const both = await returnsRead(['--from', 'agent-a', '--result', 'BLOCKED']);
    expect(both.json.returns.map((r: any) => r.claimId)).toEqual(['c3']);
  });

  it('reaches a receipt beyond the unfiltered newest-50 page', async () => {
    for (let i = 0; i < 55; i++) {
      at(i * 1_000);
      expect(postFleetMessage({ id: `return-old-${i}`, from: 'agent-a', to: 'all',
        body: `RESULT VERIFIED example/demo claim old-${i} task "Work": tests batch ${i}` },
        { path: ledgerPath, now: Date.now() }).ok).toBe(true);
    }
    at(60_000);

    const unfiltered = await returnsRead();
    expect(unfiltered.json.returns).toHaveLength(50);
    expect(unfiltered.json.coverage).toMatchObject({ parsedTotal: 55, matched: 55, omitted: 5 });
    // The oldest five receipts are beyond the page; --claim still reaches them.
    const oldest = await returnsRead(['--claim', 'old-0']);
    expect(oldest.code).toBe(0);
    expect(oldest.json.returns).toHaveLength(1);
    expect(oldest.json.returns[0].claimId).toBe('old-0');
    expect(oldest.json.coverage).toMatchObject({ parsedTotal: 55, matched: 1, omitted: 0 });

    // A filtered-empty read is an honest known empty, never an error or a pad.
    const miss = await returnsRead(['--claim', 'never-returned']);
    expect(miss.code).toBe(0);
    expect(miss.json.state).toBe('known');
    expect(miss.json.returns).toEqual([]);
    expect(miss.json.coverage.matched).toBe(0);
  });

  it('keeps unparsed return rows out of every filter and counts them honestly', async () => {
    at(0);
    expect(postFleetMessage({ id: 'return-bad', from: 'agent-a', to: 'all', body: 'not a receipt' },
      { path: ledgerPath, now: Date.now() }).ok).toBe(true);
    at(1_000);
    expect(postFleetMessage({ id: 'return-c9', from: 'agent-b', to: 'all',
      body: 'RESULT VERIFIED example/demo claim c9 task "Work": tests fine' },
      { path: ledgerPath, now: Date.now() }).ok).toBe(true);
    at(2_000);

    const filtered = await returnsRead(['--claim', 'c9']);
    expect(filtered.json.returns).toHaveLength(1);
    expect(filtered.json.unparsed).toBe(1);
    expect(filtered.json.coverage.unparsed).toBe(1);
  });

  it('rejects malformed filter values before reading the ledger', async () => {
    for (const args of [
      ['--claim', 'has space'], ['--repo', 'no-slash'], ['--result', 'MAYBE'],
      ['--from', 'bad from'], ['--since', 'not-a-time'], ['--before', 'yesterday-ish'],
      ['--contains', '   '], ['--contains', 'x'.repeat(513)], ['--unknown-flag', 'x'],
    ]) {
      const result = await cli(['returns', ...args, '--json']);
      expect(result.code).toBe(2);
      expect(result.text).toBe('');
    }
  });

  it('reports an unreadable ledger as unknown under filters, never a fabricated empty', async () => {
    ledgerPath = join(dir, 'missing', 'coordination.jsonl');
    const result = await returnsRead(['--claim', 'c1']);
    expect(result.code).toBe(1);
    expect(result.json).toMatchObject({ state: 'unknown', returns: [], unparsed: 0 });
    expect(result.json.coverage).toMatchObject({ parsedTotal: null, matched: null, omitted: null, unparsed: null });
  });
});

describe('parseCoordinationReturnsFilters', () => {
  it('resolves the shared time grammar once and normalizes repo and needle', () => {
    const parsed = parseCoordinationReturnsFilters({
      repo: 'Owner/Name', result: 'BLOCKED', since: '1h', contains: '  Two   Words ',
    }, T0);
    expect(parsed).toEqual({ ok: true, filters: {
      repo: 'owner/name', result: 'BLOCKED', since: T0 - 3_600_000, contains: 'two words',
    } });
    expect(parseCoordinationReturnsFilters({ since: 'bogus' }, T0).ok).toBe(false);
    expect(parseCoordinationReturnsFilters({ result: 'PENDING' }, T0).ok).toBe(false);
  });
});

describe('projectCoordinationReturns filters', () => {
  it('filters the parsed set before the 50-row page and keeps coverage honest', () => {
    const board = {
      schema: 'fleet.coordination.v1' as const, state: 'known' as const,
      claims: [], proposals: [], expiredClaims: 0,
      messages: Array.from({ length: 60 }, (_, i) => ({
        id: `return-k${i}`, from: 'agent-a', to: 'all', at: 1000 + i,
        expiresAt: 1000 + i + 60_000,
        body: `RESULT VERIFIED example/demo claim k${i} task "Work": tests item ${i}`,
      })),
    };
    // 'item 5' substring-matches item 5 and item 50..59 — the needle is a
    // substring over the displayed text, so all eleven receipts stay.
    const wide = projectCoordinationReturns(board, 2000, { contains: 'item 5' });
    expect(wide.state).toBe('known');
    if (wide.state !== 'known') return;
    expect(wide.returns).toHaveLength(11);
    expect(wide.returns[0]!.claimId).toBe('k59');
    expect(wide.coverage).toMatchObject({ parsedTotal: 60, matched: 11, omitted: 0 });

    const single = projectCoordinationReturns(board, 2000, { contains: 'item 42' });
    if (single.state === 'known') {
      expect(single.returns.map(r => r.claimId)).toEqual(['k42']);
      expect(single.coverage.matched).toBe(1);
    }
    // [1010, 1012) keeps k10 (at=1010, since inclusive) and k11 (at=1011)
    // while k12 (at=1012, before exclusive) stays out.
    const windowed = projectCoordinationReturns(board, 2000, { since: 1010, before: 1012 });
    if (windowed.state === 'known') {
      expect(windowed.returns.map(r => r.claimId)).toEqual(['k11', 'k10']);
      expect(windowed.coverage.matched).toBe(2);
    }
    // The board itself is never mutated by a filtered projection.
    expect(board.messages).toHaveLength(60);
  });
});
