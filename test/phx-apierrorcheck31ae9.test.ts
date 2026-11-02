import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runApiSpendReport } from '../examples/agents/api-spend-report.js';
import { readResourceLedger } from '../src/core/fleet/runs-resource-ledger.js';

const roots: string[] = [];
const at = '2026-10-31T12:00:00Z';

async function setup(content?: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'fake-api-check-'));
  roots.push(dir);
  await mkdir(join(dir, 'metrics'));
  if (content !== undefined) await writeFile(join(dir, 'metrics/api-spend.jsonl'), content);
  return dir;
}

function rows(...entries: object[]): string {
  return entries.map(entry => JSON.stringify({ ts: at, ...entry })).join('\n');
}

async function report(dir: string, args: string[]) {
  let output = '';
  let error = '';
  const code = await runApiSpendReport(args, {
    readLedger: () => readResourceLedger({ runsDir: dir, personalCodexHome: join(dir, 'fake-personal'), now: () => Date.parse(at) }),
    stdout: text => { output += text; },
    stderr: text => { error += text; },
  });
  return { code, data: output ? JSON.parse(output) : null, error };
}

afterEach(async () => { await Promise.all(roots.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });

describe('API error check', () => {
  it('checks model groups before top-N display and supports exact model selection', async () => {
    const dir = await setup(rows(
      { model: 'fake-busy', input_tokens: 100 },
      { model: 'fake-failing', input_tokens: 1, is_error: true },
      { model: 'fake-failing', output_tokens: 1 },
    ));
    const all = await report(dir, ['--check-errors', '--limit', '1']);
    expect(all.code).toBe(3);
    expect(all.data.rows.map((row: { model: string }) => row.model)).toEqual(['fake-busy']);
    expect(all.data.check).toEqual({ model: null, requests: 3, errors: 1, errorFraction: 1 / 3, status: 'errors' });
    const selected = await report(dir, ['--model', 'fake-failing', '--limit', '1', '--check-errors']);
    expect(selected.code).toBe(3);
    expect(selected.data.check).toEqual({ model: 'fake-failing', requests: 2, errors: 1, errorFraction: 0.5, status: 'errors' });
    const other = await report(dir, ['--check-errors', '--model', 'fake-busy']);
    expect(other).toMatchObject({ code: 0, data: { check: { requests: 1, errors: 0, errorFraction: 0, status: 'ok' } } });
  });

  it('returns unknown for empty observations or an exact model that was not observed', async () => {
    const empty = await report(await setup(''), ['--check-errors']);
    expect(empty).toMatchObject({ code: 1, data: { sourceHealth: 'healthy', check: { requests: 0, errors: 0, errorFraction: null, status: 'unknown' } } });
    const dir = await setup(rows({ model: 'fake-known' }));
    const unknown = await report(dir, ['--check-errors', '--model', 'fake']);
    expect(unknown).toMatchObject({ code: 1, data: { check: { model: 'fake', requests: 0, errors: 0, errorFraction: null, status: 'unknown' } } });
  });

  it('marks missing and degraded sources unavailable, retaining partial observations', async () => {
    const missing = await report(await setup(), ['--check-errors']);
    expect(missing).toMatchObject({ code: 1, data: { sourceHealth: 'missing', check: { requests: null, errors: null, errorFraction: null, status: 'unavailable' } } });
    const dir = await setup(`${rows({ model: 'fake-partial' })}\nnot-json`);
    const degraded = await report(dir, ['--check-errors']);
    expect(degraded).toMatchObject({ code: 1, data: { sourceHealth: 'degraded', check: { requests: 1, errors: 0, errorFraction: 0, status: 'unavailable' } } });
    await writeFile(join(dir, 'metrics/api-spend.jsonl'), `${rows({ model: 'fake-partial', is_error: true })}\nnot-json`);
    const partialFailure = await report(dir, ['--check-errors']);
    expect(partialFailure).toMatchObject({ code: 3, data: { check: { requests: 1, errors: 1, errorFraction: 1, status: 'unavailable' } } });
  });

  it('keeps the old source-health exit and output when the check is absent', async () => {
    const dir = await setup(rows({ model: 'fake-error', is_error: true }));
    const result = await report(dir, []);
    expect(result.code).toBe(0);
    expect(result.data).not.toHaveProperty('check');
    expect((await report(await setup(), [])).code).toBe(1);
  });

  it('validates check options before reading the ledger', async () => {
    const readLedger = vi.fn<typeof readResourceLedger>();
    for (const args of [['--model', 'fake'], ['--check-errors', '--model'], ['--check-errors', '--model', '--limit', '1'], ['--check-errors', '--check-errors'], ['--check-errors', '--model', 'fake', '--model', 'fake']]) {
      let error = '';
      expect(await runApiSpendReport(args, { readLedger, stderr: text => { error += text; } })).toBe(2);
      expect(error).toContain('Usage:');
    }
    expect(readLedger).not.toHaveBeenCalled();
  });

  it('checks only model groups returned by the ledger, even when others were omitted', async () => {
    const entries = Array.from({ length: 101 }, (_, i) => ({ model: `fake-${String(i).padStart(3, '0')}`, is_error: i === 100 }));
    const result = await report(await setup(rows(...entries)), ['--check-errors', '--model', 'fake-100']);
    expect(result).toMatchObject({ code: 1, data: { omittedModels: 1, check: { requests: 0, errors: 0, errorFraction: null, status: 'unknown' } } });
  });
});
