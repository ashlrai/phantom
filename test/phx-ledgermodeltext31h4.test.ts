import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cmdResourceLedger } from '../src/cli/resource-ledger.js';
import { readResourceLedger, type ResourceLedgerV1 } from '../src/core/fleet/runs-resource-ledger.js';

const at = '2026-10-31T12:00:00Z';
const ledger: ResourceLedgerV1 = {
  v: 1, generatedAt: at, asOf: null,
  sources: { status: 'missing', apiSpend: 'healthy', jobs: 'missing' },
  lanes: [], jobsMalformedRows: null,
  apiSpend: {
    rowsToday: 3, errorsToday: 1, tokensInToday: 27, tokensOutToday: 8,
    usdToday: 0, usdWeek: 0, lastAt: at, models: ['fake-a', 'fake-b'],
    modelUsageToday: [
      { model: 'fake-a', rows: 2, errors: 1, inputTokens: 20, outputTokens: 5, usd: 0, lastAt: at },
      { model: 'fake-b', rows: 1, errors: 0, inputTokens: 7, outputTokens: 3, usd: null, lastAt: '2026-10-31T11:00:00Z' },
    ],
    modelUsageTodayOmitted: 4,
  },
};
const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe('human resource ledger model consumption', () => {
  it('shows every projected model, including zero and unknown cost, and omissions', async () => {
    const out = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await cmdResourceLedger([], async () => ledger)).toBe(0);
    const text = out.mock.calls.flat().join('\n');
    expect(text).toContain('Tokens in/out today: 27/8; last observed: 2026-10-31T12:00:00Z; models: fake-a, fake-b');
    expect(text).toContain('fake-a: rows 2; errors 1; tokens in/out 20/5; 0 USD; last observed: 2026-10-31T12:00:00Z');
    expect(text).toContain('fake-b: rows 1; errors 0; tokens in/out 7/3; unknown USD; last observed: 2026-10-31T11:00:00Z');
    expect(text).toContain('Model usage omitted: 4');
  });

  it('leaves JSON unchanged and reports missing spend without inventing rows', async () => {
    const out = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await cmdResourceLedger(['--json'], async () => ledger)).toBe(0);
    expect(JSON.parse(String(out.mock.calls[0]![0]))).toEqual(ledger);
    out.mockClear();
    expect(await cmdResourceLedger([], async () => ({ ...ledger, apiSpend: null }))).toBe(0);
    const text = out.mock.calls.flat().join('\n');
    expect(text).toContain('API spend: unknown');
    expect(text).not.toContain('Model usage omitted');
    expect(text).not.toContain('fake-a');
  });

  it('prints only validated usage from a degraded local source', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ledger-model-text-'));
    roots.push(root);
    await mkdir(join(root, 'metrics'));
    await writeFile(join(root, 'metrics/api-spend.jsonl'), [
      JSON.stringify({ ts: at, model: 'fake-safe', input_tokens: 9, output_tokens: 2, is_error: true }),
      JSON.stringify({ ts: at, model: 'bad/model', input_tokens: 3 }),
      'malformed private details',
    ].join('\n'));
    const out = vi.spyOn(console, 'log').mockImplementation(() => {});
    const read = () => readResourceLedger({ runsDir: root, personalCodexHome: join(root, 'personal'), now: () => Date.parse(at) });
    expect(await cmdResourceLedger([], read)).toBe(0);
    const text = out.mock.calls.flat().join('\n');
    expect(text).toContain('API spend degraded');
    expect(text).toContain('fake-safe: rows 1; errors 1; tokens in/out 9/2; unknown USD; last observed: 2026-10-31T12:00:00Z');
    expect(text).not.toContain('bad/model');
    expect(text).not.toContain('private details');
    expect(text).not.toContain('Model usage omitted');
  });

  it('reports a read failure without exposing details', async () => {
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const out = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await cmdResourceLedger([], async () => { throw new Error('private details'); })).toBe(1);
    expect(err).toHaveBeenCalledExactlyOnceWith('Unable to read resource ledger.\n');
    expect(out).not.toHaveBeenCalled();
  });
});
