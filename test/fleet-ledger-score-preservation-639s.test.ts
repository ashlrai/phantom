import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { generateFleetRegistry } from '../scripts/gen-fleet-registry.mjs';
import { cmdFleet } from '../src/cli/fleet.js';
import { parseSpendDecision, SPEND_LEDGER_MAX_BYTES, SPEND_LEDGER_MAX_ROWS } from '../src/core/providers/coding-cli/ledger.js';
import { scoreHistoricalPools, type PoolLedgerScore } from '../src/core/providers/coding-cli/ledger-score.js';

// Recovered from PR #5952 (3d6c8fb7c7f7d52655fb3e0f13ef239686f7b886) reweight(). Fixtures are plainly fake.
afterEach(() => vi.restoreAllMocks());

const loaders = { 'ledger-score': () => import('../src/cli/fleet-ledger-score.js') };
const base = {
  ts: '2026-11-01T00:00:00.000Z', poolId: 'pool-a', billing: 'credit', balanceKnown: true, expiryKnown: false,
  complexity: 'low', risk: 'medium', backend: 'fake-backend', accountId: 'acct-fake-123', model: 'fake-model',
  escalations: 0, verification: 'passed', ci: 'passed', merged: true, timeMs: 1000, quota: 5, cost: 2.5,
};
const line = (o: Record<string, unknown> = {}) => JSON.stringify({ ...base, ...o });

/** Mixed merge/CI outcomes and partial cost for pool-mixed; no-merge, all-unknown-CI, prototype-shaped keys. */
const MIXED = [
  line({ poolId: 'pool-mixed', merged: true, ci: 'passed', cost: 2 }),
  line({ poolId: 'pool-mixed', merged: true, ci: 'failed', cost: 4 }),
  line({ poolId: 'pool-mixed', merged: true, ci: 'unknown', cost: null }),
  line({ poolId: 'pool-mixed', merged: false, ci: 'passed', cost: 1 }),
  line({ poolId: 'pool-mixed', merged: false, ci: 'unknown', cost: null }),
  line({ poolId: 'pool-nomerge', merged: false, ci: 'passed', cost: 0 }),
  line({ poolId: 'pool-nomerge', merged: false, ci: 'failed', cost: null }),
  line({ poolId: 'pool-unknown-ci', merged: true, ci: 'unknown', cost: 3 }),
  line({ poolId: 'pool-unknown-ci', merged: true, ci: 'unknown', cost: null }),
  line({ poolId: '__proto__', merged: true, ci: 'passed', cost: 0 }),
  line({ poolId: 'constructor', merged: true, ci: 'failed', cost: 0 }),
  'not json',
].join('\n') + '\n';

function setup(content: string | null) {
  const dir = mkdtempSync(join(tmpdir(), 'ledger-score-639s-'));
  const file = join(dir, 'ledger.jsonl');
  if (content !== null) writeFileSync(file, content);
  return { dir, file };
}

async function run(args: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  vi.spyOn(console, 'log').mockImplementation((s?: unknown) => { out.push(String(s)); });
  vi.spyOn(console, 'error').mockImplementation((s?: unknown) => { err.push(String(s)); });
  const code = await cmdFleet(['ledger-score', ...args], loaders);
  return { code, out: out.join('\n'), err: err.join('\n') };
}

const pool = (pools: PoolLedgerScore[], id: string) => {
  const found = pools.find((p) => p.poolId === id);
  if (!found) throw new Error(`missing pool ${id}`);
  return found;
};

describe('fleet ledger-score (preserved from #5952 reweight)', () => {
  it('scores the synthetic ledger with the exact source formula and visible unknown counts', async () => {
    const protoBefore = Object.getOwnPropertyNames(Object.prototype);
    const { file } = setup(MIXED);
    const r = await run(['--file', file, '--json']);
    expect(r.code).toBe(0);
    const report = JSON.parse(r.out) as {
      schema: string; status: string; comparableAcrossPools: boolean; coverage: string;
      counts: { valid: number; invalid: number; listed: number };
      truncated: { bytes: boolean; rows: boolean }; pools: PoolLedgerScore[]; note: string;
    };
    expect(report.schema).toBe('fleet.ledger-score.v1');
    expect(report.status).toBe('ok');
    expect(report.comparableAcrossPools).toBe(false);
    expect(report.coverage).toBe('listed-sample');
    expect(report.note).toContain('Not an eligibility, spending or dispatch decision');
    expect(report.counts).toEqual({ valid: 11, invalid: 1, listed: 11 });
    expect(report.truncated).toEqual({ bytes: false, rows: false });

    // pool-mixed: mergeRate 3/5, ciRate 2/3 (known 3, unknown 2), costPerMerged (2+4)/3 = 2
    // score = 0.6 * (2/3) / (1 + 2) = 0.133333 (six decimals)
    const mixed = pool(report.pools, 'pool-mixed');
    expect(mixed).toMatchObject({
      rows: 5, merged: 3, mergeRate: 0.6, ciPassRate: 2 / 3, costPerMerged: 2, score: 0.133333,
      ci: { passed: 2, failed: 1, known: 3, unknown: 2 },
      cost: { knownMerged: 2, unknownMerged: 1 },
    });

    // no merges: score 0, no CI or cost denominator involved
    expect(pool(report.pools, 'pool-nomerge')).toMatchObject({ merged: 0, score: 0, costPerMerged: 0, ci: { passed: 1, failed: 1, known: 2, unknown: 0 } });
    // all-unknown CI: CI rate is 0 even with merges, so score 0; unknown CI counted
    expect(pool(report.pools, 'pool-unknown-ci')).toMatchObject({
      merged: 2, mergeRate: 1, ciPassRate: 0, score: 0, ci: { known: 0, unknown: 2 },
      cost: { knownMerged: 1, unknownMerged: 1 }, costPerMerged: 1.5,
    });
    // prototype-shaped keys are ordinary pools; nothing is written onto Object.prototype
    expect(pool(report.pools, '__proto__')).toMatchObject({ merged: 1, mergeRate: 1, ciPassRate: 1, score: 1 });
    expect(pool(report.pools, 'constructor')).toMatchObject({ merged: 1, ciPassRate: 0, score: 0 });
    expect(Object.getOwnPropertyNames(Object.prototype)).toEqual(protoBefore);

    // account identifiers, raw lines and arbitrary fields never leave the command
    expect(r.out).not.toContain('acct-fake-123');
    expect(r.out).not.toContain('not json');
    expect(r.out).not.toContain('fake-model');
    expect(r.out).not.toContain('"accountId"');
  });

  it('prints the human report with the sample note and the same pool scores', async () => {
    const { file } = setup(MIXED);
    const r = await run(['--file', file]);
    expect(r.code).toBe(0);
    expect(r.out).toContain('11 valid, 1 invalid lines, 11 listed');
    expect(r.out).toContain('pool-mixed score=0.133333');
    expect(r.out).toContain('(2 known, 1 unknown merged cost; pool unit)');
    expect(r.out).not.toContain('acct-fake-123');
  });

  it('reports an empty readable file as status empty with exit 0', async () => {
    const { file } = setup('');
    const r = await run(['--file', file, '--json']);
    expect(r.code).toBe(0);
    const report = JSON.parse(r.out) as { status: string; pools: unknown[]; counts: { valid: number } };
    expect(report.status).toBe('empty');
    expect(report.pools).toEqual([]);
    expect(report.counts.valid).toBe(0);
  });

  it('keeps a missing file distinct from empty: unavailable with exit 2', async () => {
    const { dir } = setup(null);
    const missing = join(dir, 'absent.jsonl');
    const json = await run(['--file', missing, '--json']);
    expect(json.code).toBe(2);
    expect(JSON.parse(json.out)).toMatchObject({ status: 'unavailable', readOnly: true });
    const text = await run(['--file', missing]);
    expect(text.code).toBe(2);
    expect(text.err).toContain('unavailable');
    // a directory is not a readable ledger either
    expect((await run(['--file', dir])).code).toBe(2);
  });

  it('rejects malformed usage with exit 2', async () => {
    const { file } = setup(MIXED);
    const cases: string[][] = [
      [],
      ['--json'],
      ['--file'],
      ['--file', '--json'],
      ['--file', 'relative/ledger.jsonl'],
      ['--file=relative.jsonl'],
      ['--file', file, '--file', file],
      ['--file', file, '--json', '--json'],
      ['--file', file, '--bogus'],
      ['--file', file, 'extra'],
    ];
    for (const args of cases) {
      const r = await run(args);
      expect(r.code, JSON.stringify(args)).toBe(2);
      expect(r.out, JSON.stringify(args)).toBe('');
    }
  });

  it('answers --help offline with exit 0 and does not read any file', async () => {
    const r = await run(['--help']);
    expect(r.code).toBe(0);
    expect(r.out).toContain('Usage: phm fleet ledger-score --file <absolute-jsonl-path> [--json]');
    expect((await run(['-h'])).code).toBe(0);
  });

  it('marks truncation when the row ceiling is exceeded and scores only the listed sample', async () => {
    const rows = Array.from({ length: SPEND_LEDGER_MAX_ROWS + 1 }, (_, i) => line({ poolId: 'pool-long', merged: i === 0, ci: 'passed', cost: 0 }));
    const { file } = setup(rows.join('\n') + '\n');
    const r = await run(['--file', file, '--json']);
    expect(r.code).toBe(0);
    const report = JSON.parse(r.out) as { truncated: { rows: boolean }; counts: { valid: number; listed: number }; pools: PoolLedgerScore[] };
    expect(report.truncated.rows).toBe(true);
    expect(report.counts).toEqual({ valid: SPEND_LEDGER_MAX_ROWS + 1, invalid: 0, listed: SPEND_LEDGER_MAX_ROWS });
    expect(pool(report.pools, 'pool-long')).toMatchObject({ rows: SPEND_LEDGER_MAX_ROWS, merged: 1, mergeRate: 1 / SPEND_LEDGER_MAX_ROWS });
  });

  it('marks byte truncation and drops the cut partial line instead of counting it invalid', async () => {
    const valid = line({ poolId: 'pool-bytes', merged: true, ci: 'passed', cost: 0 });
    const { file } = setup(`${valid}\n{"pad":"${'x'.repeat(SPEND_LEDGER_MAX_BYTES)}"}\n`);
    const r = await run(['--file', file, '--json']);
    expect(r.code).toBe(0);
    const report = JSON.parse(r.out) as { truncated: { bytes: boolean }; counts: { valid: number; invalid: number } };
    expect(report.truncated.bytes).toBe(true);
    expect(report.counts).toEqual({ valid: 1, invalid: 0, listed: 1 });
  });

  it('scores pools in the library without mutating shared state', () => {
    const rows = [
      line({ poolId: 'a', merged: true, ci: 'passed', cost: 1 }),
      line({ poolId: 'a', merged: true, ci: 'passed', cost: null }),
    ].map((l) => parseSpendDecision(l)!);
    const first = scoreHistoricalPools(rows);
    const again = scoreHistoricalPools(rows);
    expect(again).toEqual(first);
    // costPerMerged = 1 / 2 merges; score = 1 * 1 / 1.5 = 0.666667
    expect(first[0]).toMatchObject({ costPerMerged: 0.5, score: 0.666667, cost: { knownMerged: 1, unknownMerged: 1 } });
  });

  it('is discoverable through the fleet convention registry without editing it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ledger-score-reg-639s-'));
    mkdirSync(dir, { recursive: true });
    copyFileSync(new URL('../src/cli/fleet-ledger-score.ts', import.meta.url), join(dir, 'fleet-ledger-score.ts'));
    writeFileSync(join(dir, 'fleet-subcommand-registry.ts'), '');
    expect(generateFleetRegistry([dir])).toBe(0);
    expect(readFileSync(join(dir, 'fleet-subcommand-registry.ts'), 'utf8'))
      .toContain("'ledger-score': () => import('./fleet-ledger-score.js'),");
  });
});
