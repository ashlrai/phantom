import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cmdResourceLedger } from '../src/cli/resource-ledger.js';
import { readResourceLedger } from '../src/core/fleet/runs-resource-ledger.js';

const at = '2026-10-31T12:00:00Z';
const roots: string[] = [];
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'fake-ledger-select-'));
  roots.push(root);
  await mkdir(join(root, 'metrics'));
  await mkdir(join(root, 'queue'));
  await writeFile(join(root, 'queue/status.json'), JSON.stringify({ last_tick: at, lanes: { 'fake-api': { running: 1 }, 'fake-other': { running: 2 } } }));
  const rows = [
    { ts: at, model: 'fake-a', input_tokens: 10, output_tokens: 3, is_error: true },
    { ts: at, model: 'fake-b', input_tokens: 20, output_tokens: 7, cost_usd: 2 },
  ];
  await writeFile(join(root, 'metrics/api-spend.jsonl'), rows.map(row => JSON.stringify(row)).join('\n'));
  const read = () => readResourceLedger({ runsDir: root, personalCodexHome: join(root, 'personal'), now: () => Date.parse(at) });
  return { root, read };
}
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe('resource ledger model selection', () => {
  it('selects a model while preserving and labeling global totals, including unknown model cost', async () => {
    const { read } = await fixture();
    const original = await read();
    const out = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await cmdResourceLedger(['--json', '--model', 'fake-a'], read)).toBe(0);
    const view = JSON.parse(String(out.mock.calls[0]![0]));
    expect(view.apiSpend).toEqual({ ...original.apiSpend, modelUsageToday: [expect.objectContaining({ model: 'fake-a', rows: 1, errors: 1, inputTokens: 10, outputTokens: 3, usd: null })] });
    expect(view.modelFilter).toMatchObject({ model: 'fake-a', displayed: 1, selectionOmitted: 1 });
    expect(view.modelFilter.global).toEqual(expect.arrayContaining(['apiSpend.rowsToday', 'apiSpend.errorsToday', 'apiSpend.tokensInToday', 'apiSpend.usdToday', 'apiSpend.modelUsageTodayOmitted']));
    expect(view.apiSpend).toMatchObject({ rowsToday: 2, errorsToday: 1, tokensInToday: 30, tokensOutToday: 10, usdToday: 2 });
    out.mockClear();
    expect(await cmdResourceLedger(['--model', 'fake-a'], read)).toBe(0);
    const text = out.mock.calls.flat().join('\n');
    expect(text).toContain('API spend: global totals: today 2 USD');
    expect(text).toContain('fake-a: rows 1; errors 1; tokens in/out 10/3; unknown USD');
    expect(text).toContain('1 displayed; 1 omitted by selection');
  });

  it('distinguishes a missing match from reader omissions, including a model beyond its cap', async () => {
    const { root, read } = await fixture();
    const rows = Array.from({ length: 102 }, (_, i) => ({ ts: at, model: `fake-${String(i).padStart(3, '0')}`, input_tokens: 1 }));
    await writeFile(join(root, 'metrics/api-spend.jsonl'), rows.map(row => JSON.stringify(row)).join('\n'));
    const out = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await cmdResourceLedger(['--json', '--model', 'fake-101'], read)).toBe(0);
    const view = JSON.parse(String(out.mock.calls[0]![0]));
    expect(view.apiSpend).toMatchObject({ modelUsageToday: [], modelUsageTodayOmitted: 2, rowsToday: 102, usdToday: null });
    expect(view.modelFilter).toMatchObject({ model: 'fake-101', displayed: 0, selectionOmitted: 100 });
    out.mockClear();
    expect(await cmdResourceLedger(['--model', 'fake-101'], read)).toBe(0);
    const text = out.mock.calls.flat().join('\n');
    expect(text).toContain('no matching model in reader output');
    expect(text).toContain('Model usage omitted: 2');
    expect(text).toContain('today unknown USD');
  });

  it('leaves missing spend unknown and uses unknown selection counts', async () => {
    const { root, read } = await fixture();
    await rm(join(root, 'metrics/api-spend.jsonl'));
    const out = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await cmdResourceLedger(['--json', '--model', 'fake-a'], read)).toBe(0);
    const view = JSON.parse(String(out.mock.calls[0]![0]));
    expect(view.apiSpend).toBeNull();
    expect(view.modelFilter).toMatchObject({ model: 'fake-a', displayed: null, selectionOmitted: null });
    out.mockClear();
    expect(await cmdResourceLedger(['--model', 'fake-a'], read)).toBe(0);
    expect(out.mock.calls.flat().join('\n')).toContain('API spend: unknown');
  });

  it('composes lane and model filters without labeling selected model rows global', async () => {
    const { read } = await fixture();
    const out = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await cmdResourceLedger(['--json', '--lane', 'fake-api', '--model', 'fake-b'], read)).toBe(0);
    const view = JSON.parse(String(out.mock.calls[0]![0]));
    expect(view.lanes.map((row: { lane: string }) => row.lane)).toEqual(['fake-api']);
    expect(view.apiSpend.modelUsageToday.map((row: { model: string }) => row.model)).toEqual(['fake-b']);
    expect(view.apiSpend.rowsToday).toBe(2);
    expect(view.laneFilter.global).toContain('apiSpend.rowsToday');
    expect(view.laneFilter.global).not.toContain('apiSpend');
  });

  it('filters each watch emission and applies changes-only to the selected view', async () => {
    const { read } = await fixture();
    const first = await read();
    const second = structuredClone(first);
    second.apiSpend!.modelUsageToday[0]!.errors = 3;
    const reader = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    const out = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.useFakeTimers();
    const run = cmdResourceLedger(['--watch', '--json', '--changes-only', '--interval-ms', '1000', '--max-samples', '2', '--model', 'fake-a'], reader);
    await vi.advanceTimersByTimeAsync(1000);
    expect(await run).toBe(0);
    const views = out.mock.calls.map(([line]) => JSON.parse(String(line)));
    expect(views).toHaveLength(2);
    expect(views.map(view => view.apiSpend.modelUsageToday.map((row: { model: string }) => row.model))).toEqual([['fake-a'], ['fake-a']]);
    expect(views.map(view => view.apiSpend.modelUsageToday[0].errors)).toEqual([1, 3]);
    expect(views.map(view => view.modelFilter.selectionOmitted)).toEqual([1, 1]);
  });

  it.each([['--model'], ['--model', '--json'], ['--model', ''], ['--model', 'fake/a'], ['--model', 'fake model'], ['--model', 'x'.repeat(81)], ['--model', 'fake-a', '--model', 'fake-b']])('rejects invalid arguments %j before reading', async (...args) => {
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const read = vi.fn();
    expect(await cmdResourceLedger(args, read)).toBe(2);
    expect(read).not.toHaveBeenCalled();
    expect(err).toHaveBeenCalled();
  });

  it('documents selection without reading', async () => {
    const out = vi.spyOn(console, 'log').mockImplementation(() => {});
    const read = vi.fn();
    expect(await cmdResourceLedger(['--help'], read)).toBe(0);
    expect(read).not.toHaveBeenCalled();
    expect(out.mock.calls.flat().join('\n')).toContain('--model <exact-model-id>');
  });
});
