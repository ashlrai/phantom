import { afterEach, describe, expect, it, vi } from 'vitest';
import { cmdResourceLedger } from '../src/cli/resource-ledger.js';
import type { ResourceLaneRow, ResourceLedgerV1 } from '../src/core/fleet/runs-resource-ledger.js';

const at = '2026-10-31T12:00:00Z';
const row = (lane: string, fields: Partial<ResourceLaneRow> = {}): ResourceLaneRow => ({
  lane, running: null, target: null, held: null, window: 'none', usedPct: null,
  creditsRemaining: null, resetAt: null, burnPctPerHour: null, tokensPerHour6h: null,
  projectedExhaustion: null, source: null, deadSignal: null, ...fields,
});
const ledger: ResourceLedgerV1 = {
  v: 1, generatedAt: at, asOf: '2026-10-31T11:59:00Z',
  sources: { status: 'healthy', apiSpend: 'healthy', jobs: 'missing' },
  jobsMalformedRows: null,
  lanes: [
    row('codex-personal', { running: 0, target: 2, held: true, window: 'weekly', usedPct: 73, resetAt: '2026-11-07T00:00:00Z', source: 'codex-personal-sessions' }),
    row('claude', { running: 1, target: 2, held: false, window: 'weekly', usedPct: 42, source: 'status' }),
    row('api', { running: 0, target: 1, held: false, window: 'credits', creditsRemaining: 25 }),
  ],
  apiSpend: {
    rowsToday: 3, errorsToday: 1, tokensInToday: 27, tokensOutToday: 8,
    usdToday: 0.5, usdWeek: 2, lastAt: at, models: ['fake-model'],
    modelUsageToday: [{ model: 'fake-model', rows: 3, errors: 1, inputTokens: 27, outputTokens: 8, usd: 0.5, lastAt: at }],
    modelUsageTodayOmitted: 0,
  },
};

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('phm resources ledger --lane', () => {
  it('isolates one lane in JSON and labels spend and source fields as global', async () => {
    const out = vi.spyOn(console, 'log').mockImplementation(() => {});
    const read = vi.fn().mockResolvedValue(ledger);
    expect(await cmdResourceLedger(['--json', '--lane', 'codex-personal'], read)).toBe(0);
    expect(read).toHaveBeenCalledOnce();
    const view = JSON.parse(String(out.mock.calls[0]![0]));
    expect(view.lanes).toEqual([ledger.lanes[0]]);
    expect(view.laneFilter).toEqual({ lane: 'codex-personal', global: ['generatedAt', 'asOf', 'sources', 'apiSpend', 'jobsMalformedRows'] });
    expect(view.sources).toEqual(ledger.sources);
    expect(view.apiSpend).toEqual(ledger.apiSpend);
    expect(view.jobsMalformedRows).toBe(ledger.jobsMalformedRows);
    expect(view.generatedAt).toBe(ledger.generatedAt);
    expect(view.asOf).toBe(ledger.asOf);
  });

  it('prints the lane filter note, the isolated lane and global values in text', async () => {
    const out = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await cmdResourceLedger(['--lane', 'codex-personal'], async () => ledger)).toBe(0);
    const text = out.mock.calls.flat().join('\n');
    expect(text).toContain('Lane filter: codex-personal; sources and API spend are global');
    expect(text).toContain('Sources: status healthy; API spend healthy');
    expect(text).toContain('codex-personal: running/target 0/2; held true; window weekly');
    expect(text).toContain('Weekly usage: 73%');
    expect(text).not.toContain('claude:');
    expect(text).not.toContain('api:');
    expect(text).toContain('API spend: today 0.5 USD; week 2 USD');
    expect(text).toContain('fake-model: rows 3; errors 1; tokens in/out 27/8; 0.5 USD');
  });

  it('returns empty lanes for an unknown well-formed lane without hiding global values', async () => {
    const out = vi.spyOn(console, 'log').mockImplementation(() => {});
    const read = vi.fn().mockResolvedValue(ledger);
    expect(await cmdResourceLedger(['--json', '--lane', 'devin'], read)).toBe(0);
    const view = JSON.parse(String(out.mock.calls[0]![0]));
    expect(view.lanes).toEqual([]);
    expect(view.laneFilter.lane).toBe('devin');
    expect(view.apiSpend).toEqual(ledger.apiSpend);
    expect(view.sources).toEqual(ledger.sources);
    out.mockClear();
    expect(await cmdResourceLedger(['--lane', 'devin'], async () => ledger)).toBe(0);
    const text = out.mock.calls.flat().join('\n');
    expect(text).toContain('Lane filter: devin');
    expect(text).toContain('Lanes: none matching lane filter');
    expect(text).toContain('API spend: today 0.5 USD');
  });

  it('emits filtered samples sequentially on watch and stops on abort', async () => {
    vi.useFakeTimers();
    const out = vi.spyOn(console, 'log').mockImplementation(() => {});
    const controller = new AbortController();
    const read = vi.fn()
      .mockResolvedValueOnce(ledger)
      .mockResolvedValueOnce({ ...ledger, lanes: [row('codex-personal', { window: 'weekly', usedPct: 74 }), ledger.lanes[1]!, ledger.lanes[2]!] })
      .mockResolvedValue(ledger);
    const run = cmdResourceLedger(['--watch', '--json', '--interval-ms', '1000', '--lane', 'codex-personal'], read, controller.signal);
    await vi.advanceTimersByTimeAsync(0);
    expect(read).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(999);
    expect(read).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(read).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1000);
    expect(read).toHaveBeenCalledTimes(3);
    controller.abort();
    expect(await run).toBe(0);
    const lines = out.mock.calls.map(([line]) => JSON.parse(String(line)));
    expect(lines).toHaveLength(3);
    for (const line of lines) {
      expect(line.lanes.map((lane: ResourceLaneRow) => lane.lane)).toEqual(['codex-personal']);
      expect(line.laneFilter.lane).toBe('codex-personal');
      expect(line.sources).toEqual(ledger.sources);
      expect(line.apiSpend).toEqual(ledger.apiSpend);
    }
    expect(lines[1].lanes[0].usedPct).toBe(74);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not read when the watch signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const read = vi.fn();
    expect(await cmdResourceLedger(['--watch', '--lane', 'codex-personal'], read, controller.signal)).toBe(0);
    expect(read).not.toHaveBeenCalled();
  });

  it.each([
    ['--lane'], ['--lane', '--json'], ['--lane', ''], ['--lane', '../etc'],
    ['--lane', 'bad lane'], ['--lane', 'bad/lane'], ['--lane', '.dot'], ['--lane', 'x'.repeat(65)],
    ['--lane', 'a', '--lane', 'b'], ['--lane', 'a', '--lane', 'a'],
    ['--watch', '--lane', 'codex-personal', '--lane', 'claude'], ['--lane', 'ok', 'extra'],
  ])('rejects invalid lane arguments %j before reading', async (...args) => {
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const read = vi.fn();
    expect(await cmdResourceLedger(args, read)).toBe(2);
    expect(read).not.toHaveBeenCalled();
    expect(err).toHaveBeenCalledWith('Invalid ledger arguments; use phm resources ledger --help.\n');
  });

  it('treats a boundary-length well-formed lane as a filter, not an error', async () => {
    const out = vi.spyOn(console, 'log').mockImplementation(() => {});
    const long = `lane-${'x'.repeat(59)}`;
    expect(long).toHaveLength(64);
    const read = vi.fn().mockResolvedValue(ledger);
    expect(await cmdResourceLedger(['--json', '--lane', long], read)).toBe(0);
    expect(read).toHaveBeenCalledOnce();
    const view = JSON.parse(String(out.mock.calls[0]![0]));
    expect(view.lanes).toEqual([]);
    expect(view.laneFilter.lane).toBe(long);
  });

  it('leaves the unfiltered JSON and text projections untouched', async () => {
    const out = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await cmdResourceLedger(['--json'], async () => ledger)).toBe(0);
    expect(JSON.parse(String(out.mock.calls[0]![0]))).toEqual(ledger);
    expect(String(out.mock.calls[0]![0])).not.toContain('laneFilter');
    out.mockClear();
    expect(await cmdResourceLedger([], async () => ledger)).toBe(0);
    const text = out.mock.calls.flat().join('\n');
    expect(text).not.toContain('Lane filter');
    expect(text).toContain('claude: running/target 1/2; held false; window weekly');
    expect(text).toContain('api: running/target 0/1; held false; window credits');
  });

  it('documents the lane filter and its global scope without reading', async () => {
    const out = vi.spyOn(console, 'log').mockImplementation(() => {});
    const read = vi.fn();
    expect(await cmdResourceLedger(['--help'], read)).toBe(0);
    expect(read).not.toHaveBeenCalled();
    const text = out.mock.calls.flat().join('\n');
    expect(text).toContain('--lane <lane>');
    expect(text).toContain('global');
  });
});
