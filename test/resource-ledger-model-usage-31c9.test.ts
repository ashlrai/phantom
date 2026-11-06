import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readResourceLedger, summarizeApiSpend } from '../src/core/fleet/runs-resource-ledger.js';

const now = Date.parse('2026-10-31T12:00:00Z');
const roots: string[] = [];
const jsonl = (rows: unknown[]): string => rows.map(row => JSON.stringify(row)).join('\n');
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

describe('API model usage today', () => {
  it('groups validated models using the same dates and numeric rules as totals', () => {
    const rows = [
      { ts: '2026-10-31T09:00:00Z', model: 'fake-b', input_tokens: 4, output_tokens: 3 },
      { ts: '2026-10-31T11:00:00Z', model: 'fake-a', input_tokens: 10, output_tokens: 2, cost_usd: 0.5, is_error: true },
      { ts: '2026-10-31T08:00:00Z', model: 'fake-a', input_tokens: 7, output_tokens: 1, usd: 0.25 },
      { ts: '2026-10-31T10:00:00Z', model: 'bad/model', input_tokens: 5, output_tokens: 6, cost: 2 },
      { ts: '2026-10-30T23:59:59Z', model: 'old-model', input_tokens: 100, cost: 3 },
      { ts: '2026-10-31T12:00:01Z', model: 'future-model', input_tokens: 100, cost: 4 },
      { model: 'missing-date', input_tokens: 100 },
      null,
    ];
    const result = summarizeApiSpend(`${jsonl(rows)}\n{bad`, now, 0);
    expect(result.modelUsageToday).toEqual([
      { model: 'fake-a', rows: 2, errors: 1, inputTokens: 17, outputTokens: 3, usd: 0.75, lastAt: '2026-10-31T11:00:00Z' },
      { model: 'fake-b', rows: 1, errors: 0, inputTokens: 4, outputTokens: 3, usd: null, lastAt: '2026-10-31T09:00:00Z' },
    ]);
    expect(result).toMatchObject({ rowsToday: 4, errorsToday: 1, tokensInToday: 26, tokensOutToday: 12, usdToday: 2.75, usdWeek: 5.75, modelUsageTodayOmitted: 0, models: ['fake-a', 'fake-b', 'old-model'] });
    expect(JSON.stringify(result)).not.toContain('bad/model');
    expect(summarizeApiSpend(jsonl(rows), now, 300).modelUsageToday).toEqual(result.modelUsageToday);
    expect(summarizeApiSpend(jsonl([{ ts: '2026-10-31T03:00:00Z', model: 'fake-a' }]), now, 300).modelUsageToday).toEqual([]);
  });

  it('agrees with totals when every row has a safe model and handles malformed numbers', () => {
    const result = summarizeApiSpend(jsonl([
      { at: '2026-10-31T09:00:00Z', model: 'fake-a', input_tokens: 10, output_tokens: 3, cost: 0 },
      { timestamp: '2026-10-31T10:00:00Z', model: 'fake-b', input_tokens: -1, output_tokens: '9', cost_usd: -1, usd: 1.25, is_error: true },
      { ts: '2026-10-31T11:00:00Z', model: 'fake-a', input_tokens: 2, output_tokens: 5 },
    ]), now, 0);
    const usage = result.modelUsageToday;
    expect(usage.reduce((sum, row) => sum + row.rows, 0)).toBe(result.rowsToday);
    expect(usage.reduce((sum, row) => sum + row.errors, 0)).toBe(result.errorsToday);
    expect(usage.reduce((sum, row) => sum + row.inputTokens, 0)).toBe(result.tokensInToday);
    expect(usage.reduce((sum, row) => sum + row.outputTokens, 0)).toBe(result.tokensOutToday);
    expect(usage.reduce((sum, row) => sum + (row.usd ?? 0), 0)).toBe(result.usdToday);
    expect(usage[0]).toMatchObject({ usd: 0, lastAt: '2026-10-31T11:00:00Z' });
  });

  it('caps sorted model groups and counts omitted distinct models', () => {
    const rows = Array.from({ length: 105 }, (_, i) => ({ ts: '2026-10-31T10:00:00Z', model: `fake-${String(104 - i).padStart(3, '0')}`, input_tokens: 1 }));
    rows.push({ ...rows[0]!, input_tokens: 2 });
    const result = summarizeApiSpend(jsonl(rows), now, 0);
    expect(result.modelUsageToday).toHaveLength(100);
    expect(result.modelUsageToday.map(row => row.model)).toEqual(Array.from({ length: 100 }, (_, i) => `fake-${String(i).padStart(3, '0')}`));
    expect(result.modelUsageTodayOmitted).toBe(5);
    expect(result).toMatchObject({ rowsToday: 106, tokensInToday: 107 });
  });

  it('exposes the fields through the public ledger from the same bounded tail', async () => {
    const root = await mkdtemp(join(tmpdir(), 'model-usage-'));
    roots.push(root);
    await mkdir(join(root, 'metrics'));
    const at = new Date(now).toISOString();
    const kept = { ts: at, model: 'fake-kept', input_tokens: 9, cost: 0.5 };
    await writeFile(join(root, 'metrics/api-spend.jsonl'), `${jsonl([{ ts: at, model: 'fake-old', input_tokens: 100 }])}\n${'x'.repeat(512 * 1024)}\n${jsonl([kept])}\ninvalid\n`);
    const ledger = await readResourceLedger({ runsDir: root, now: () => now });
    expect(ledger.v).toBe(1);
    expect(ledger.sources.apiSpend).toBe('degraded');
    expect(ledger.apiSpend).toMatchObject({ rowsToday: 1, tokensInToday: 9, usdToday: 0.5, modelUsageTodayOmitted: 0, modelUsageToday: [{ model: 'fake-kept', rows: 1, errors: 0, inputTokens: 9, outputTokens: 0, usd: 0.5, lastAt: at }] });
  });
});
