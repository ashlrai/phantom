import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runApiSpendReport } from '../examples/agents/api-spend-report.js';
import { readResourceLedger } from '../src/core/fleet/runs-resource-ledger.js';

const roots: string[] = [];
const at = '2026-10-31T12:00:00Z';
async function root(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'api-spend-report-'));
  roots.push(dir);
  await mkdir(join(dir, 'metrics'));
  return dir;
}
async function report(dir: string, args: string[] = []) {
  let out = '';
  let err = '';
  const code = await runApiSpendReport(args, {
    readLedger: () => readResourceLedger({ runsDir: dir, now: () => Date.parse(at) }),
    stdout: text => { out += text; },
    stderr: text => { err += text; },
  });
  return { code, data: out ? JSON.parse(out) : null, err };
}
async function writeRows(dir: string, rows: unknown[]) {
  await writeFile(join(dir, 'metrics/api-spend.jsonl'), rows.map(row => JSON.stringify(row)).join('\n'));
}
afterEach(async () => { await Promise.all(roots.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });

describe('API spend report', () => {
  it('sorts each metric deterministically and preserves unknown costs and observations', async () => {
    const dir = await root();
    await writeRows(dir, [
      { ts: at, model: 'fake-b', input_tokens: 8, output_tokens: 2, cost: 0, is_error: true },
      { ts: at, model: 'fake-a', input_tokens: 5, output_tokens: 5, cost: 0, is_error: true },
      { ts: at, model: 'fake-c', input_tokens: 15 },
      { ts: at, model: 'fake-d', cost: 1 },
      { ts: at, model: 'fake-e' },
    ]);
    const tokens = await report(dir);
    expect(tokens.code).toBe(0);
    expect(tokens.data).toMatchObject({ source: 'metrics/api-spend.jsonl', sourceHealth: 'healthy', observedAt: '2026-10-31T12:00:00.000Z', lastAt: at, sort: 'tokens', omittedModels: 0, unrepresentedRows: 0 });
    expect(tokens.data.rows.map((row: { model: string }) => row.model)).toEqual(['fake-c', 'fake-a', 'fake-b', 'fake-d', 'fake-e']);
    expect(tokens.data.rows[0]).toMatchObject({ model: 'fake-c', usd: null, lastAt: at });
    expect((await report(dir, ['--sort', 'errors'])).data.rows.map((row: { model: string }) => row.model)).toEqual(['fake-a', 'fake-b', 'fake-c', 'fake-d', 'fake-e']);
    const usd = await report(dir, ['--sort', 'usd']);
    expect(usd.data.rows.map((row: { model: string }) => [row.model, row.usd])).toEqual([['fake-d', 1], ['fake-a', 0], ['fake-b', 0], ['fake-c', null], ['fake-e', null]]);
  });

  it('accounts for both ledger and limit omissions and rows without safe models', async () => {
    const dir = await root();
    const rows = Array.from({ length: 105 }, (_, i) => ({ ts: at, model: `fake-${String(i).padStart(3, '0')}`, input_tokens: i }));
    await writeRows(dir, [...rows, { ts: at, model: 'invalid/model' }, { ts: at }]);
    const { code, data } = await report(dir, ['--limit', '2']);
    expect(code).toBe(0);
    expect(data.rows.map((row: { model: string }) => row.model)).toEqual(['fake-099', 'fake-098']);
    expect(data.omittedModels).toBe(103);
    expect(data.unrepresentedRows).toBe(105);
    const all = await report(dir);
    expect(all.data.rows).toHaveLength(100);
    expect(all.data.omittedModels).toBe(5);
    expect(all.data.unrepresentedRows).toBe(7);
  });

  it('rejects malformed, duplicate, and unsupported options before reading', async () => {
    const readLedger = vi.fn<typeof readResourceLedger>();
    for (const args of [['--sort'], ['--sort', 'cost'], ['--limit', '0'], ['--limit', '101'], ['--limit', '01'], ['--limit', '1.0'], ['--limit', '-1'], ['--sort', 'tokens', '--sort', 'usd'], ['--limit', '1', '--limit', '2'], ['--unknown']]) {
      let err = '';
      expect(await runApiSpendReport(args, { readLedger, stderr: text => { err += text; } })).toBe(2);
      expect(err).toContain('Usage:');
    }
    expect(readLedger).not.toHaveBeenCalled();
  });

  it('reports missing and degraded sources and never follows a source symlink', async () => {
    const dir = await root();
    const missing = await report(dir);
    expect(missing).toMatchObject({ code: 1, data: { sourceHealth: 'missing', rows: [], unrepresentedRows: null } });
    await writeFile(join(dir, 'metrics/api-spend.jsonl'), `${JSON.stringify({ ts: at, model: 'fake-a', input_tokens: 2 })}\ninvalid\n`);
    const degraded = await report(dir);
    expect(degraded).toMatchObject({ code: 1, data: { sourceHealth: 'degraded', rows: [{ model: 'fake-a' }], unrepresentedRows: 0 } });
    await rm(join(dir, 'metrics/api-spend.jsonl'));
    await symlink(join(dir, 'outside'), join(dir, 'metrics/api-spend.jsonl'));
    const linked = await report(dir);
    expect(linked).toMatchObject({ code: 1, data: { sourceHealth: 'degraded', rows: [], unrepresentedRows: null } });
  });

  it('handles an unexpected reader failure without leaking its details', async () => {
    let err = '';
    const code = await runApiSpendReport([], { readLedger: async () => { throw new Error('private details'); }, stderr: text => { err += text; } });
    expect(code).toBe(1);
    expect(err).toBe('Unable to read the resource ledger.\n');
  });

  it('runs directly using the local ledger under an isolated HOME', async () => {
    const home = await root();
    const metrics = join(home, '.ashlr-runs/metrics');
    await mkdir(metrics, { recursive: true });
    await writeFile(join(metrics, 'api-spend.jsonl'), JSON.stringify({ ts: new Date().toISOString(), model: 'fake-executable', output_tokens: 9 }));
    const { stdout, stderr } = await promisify(execFile)(join(process.cwd(), 'node_modules/.bin/tsx'), ['examples/agents/api-spend-report.ts', '--sort', 'tokens'], { env: { HOME: home, PATH: process.env.PATH, TZ: 'UTC' } });
    expect(stderr).toBe('');
    expect(JSON.parse(stdout)).toMatchObject({ sourceHealth: 'healthy', rows: [{ model: 'fake-executable', outputTokens: 9 }] });
  }, 30_000);
});
