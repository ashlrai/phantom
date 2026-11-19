import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cmdFleet } from '../src/cli/fleet.js';
import { parseSpendDecision, SPEND_LEDGER_MAX_BYTES, SPEND_LEDGER_MAX_ROWS } from '../src/core/providers/coding-cli/ledger.js';

afterEach(() => vi.restoreAllMocks());

const loaders = { 'spend-ledger': () => import('../src/cli/fleet-spend-ledger.js') };
const base = {
  ts: '2026-11-01T00:00:00.000Z', poolId: 'pool-a', billing: 'credit', balanceKnown: true, expiryKnown: false,
  complexity: 'low', risk: 'medium', backend: 'fake-backend', accountId: 'acct-fake-123', model: 'fake-model',
  escalations: 0, verification: 'passed', ci: 'passed', merged: true, timeMs: 1000, quota: 5, cost: 2.5,
};
const line = (o: Record<string, unknown> = {}) => JSON.stringify({ ...base, ...o });

function setup(content: string | null) {
  const dir = mkdtempSync(join(tmpdir(), 'spend-ledger-629s-'));
  const file = join(dir, 'ledger.jsonl');
  if (content !== null) writeFileSync(file, content);
  return { dir, file };
}
async function run(args: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  vi.spyOn(console, 'log').mockImplementation((s?: unknown) => { out.push(String(s)); });
  vi.spyOn(console, 'error').mockImplementation((s?: unknown) => { err.push(String(s)); });
  const code = await cmdFleet(['spend-ledger', ...args], loaders);
  return { code, out: out.join('\n'), err: err.join('\n') };
}

describe('fleet spend-ledger (recovered from #5952)', () => {
  it('reads source-compatible rows with repo+PR identity and null quota/cost', async () => {
    const { file } = setup([
      line({ repo: 'example-org/example-repo', pr: 12 }),
      line({ quota: null, cost: null, merged: false, verification: 'unknown', ci: 'unknown', model: null, accountId: null }),
    ].join('\n') + '\n');
    const { code, out } = await run(['--file', file, '--json']);
    const rep = JSON.parse(out);
    expect(code).toBe(0);
    expect(rep.status).toBe('ok');
    expect(rep.counts).toEqual({ valid: 2, invalid: 0, listed: 2 });
    expect(rep.rows[0]).toMatchObject({ repo: 'example-org/example-repo', pr: 12, quota: 5, cost: 2.5 });
    expect(rep.rows[1].quota).toBeNull();
    expect(rep.rows[1].cost).toBeNull();
    expect(rep.rows[1]).not.toHaveProperty('repo');
    expect(rep.measured.cost).toEqual({ known: 1, unknown: 1, total: 2.5 });
    expect(out).not.toContain('acct-fake-123');
    expect(out).not.toMatch(/usd|percent|remaining/i);
  });

  it('rejects unpaired or malformed repo/PR identity and bad rows, counting without echoing', async () => {
    expect(parseSpendDecision(line({ repo: 'example-org/example-repo' }))).toBeNull();
    expect(parseSpendDecision(line({ pr: 3 }))).toBeNull();
    expect(parseSpendDecision(line({ repo: 'bad repo', pr: 3 }))).toBeNull();
    expect(parseSpendDecision(line({ repo: 'a/b', pr: 0 }))).toBeNull();
    expect(parseSpendDecision(line({ billing: 'free' }))).toBeNull();
    const { file } = setup([line(), 'not json SECRET-RAW-ROW', line({ cost: -1 }), '[]'].join('\n'));
    const { code, out } = await run(['--file', file, '--json']);
    expect(code).toBe(0);
    expect(JSON.parse(out).counts).toEqual({ valid: 1, invalid: 3, listed: 1 });
    expect(out).not.toContain('SECRET-RAW-ROW');
    const human = await run(['--file', file]);
    expect(human.out).toContain('1 valid, 3 invalid');
    expect(human.out).not.toContain('SECRET-RAW-ROW');
    expect(human.out).not.toContain('acct-fake-123');
  });

  it('distinguishes an empty readable file from a missing one', async () => {
    const empty = setup('');
    const ok = await run(['--file', empty.file, '--json']);
    expect(ok.code).toBe(0);
    expect(JSON.parse(ok.out)).toMatchObject({ status: 'empty', counts: { valid: 0, invalid: 0, listed: 0 } });
    const missing = setup(null);
    const bad = await run(['--file', missing.file, '--json']);
    expect(bad.code).toBe(2);
    expect(JSON.parse(bad.out).status).toBe('unavailable');
    const dir = await run(['--file', missing.dir]);
    expect(dir.code).toBe(2);
    expect(dir.err).toContain('unavailable');
  });

  it('bounds rows and bytes and reports truncation', async () => {
    const rows = Array.from({ length: SPEND_LEDGER_MAX_ROWS + 5 }, (_, i) => line({ escalations: i }));
    const rowCap = setup(rows.join('\n') + '\n');
    const r1 = JSON.parse((await run(['--file', rowCap.file, '--json'])).out);
    expect(r1.counts).toEqual({ valid: SPEND_LEDGER_MAX_ROWS + 5, invalid: 0, listed: SPEND_LEDGER_MAX_ROWS });
    expect(r1.truncated).toEqual({ bytes: false, rows: true });

    const one = line() + '\n';
    const copies = Math.ceil(SPEND_LEDGER_MAX_BYTES / one.length) + 3;
    const byteCap = setup(one.repeat(copies));
    const r2 = JSON.parse((await run(['--file', byteCap.file, '--json'])).out);
    expect(r2.truncated.bytes).toBe(true);
    expect(r2.source.bytesRead).toBeLessThanOrEqual(SPEND_LEDGER_MAX_BYTES);
    expect(r2.counts.invalid).toBe(0);
  });

  it('prints help, rejects unknown options and missing or relative files, and mutates nothing', async () => {
    const { dir, file } = setup(line() + '\n');
    const before = readFileSync(file, 'utf8');
    const mtime = statSync(file).mtimeMs;
    const help = await run(['--help']);
    expect(help.code).toBe(0);
    expect(help.out).toContain('--file <absolute-jsonl-path>');
    for (const args of [['--file', file, '--bogus'], ['--json'], ['--file', 'relative.jsonl'], ['--file']]) {
      const r = await run(args);
      expect(r.code).toBe(2);
      expect(r.err).toContain('Usage: phm fleet spend-ledger');
    }
    await run(['--file', file, '--json']);
    expect(readFileSync(file, 'utf8')).toBe(before);
    expect(statSync(file).mtimeMs).toBe(mtime);
    expect(readdirSync(dir)).toEqual(['ledger.jsonl']);
  });
});
