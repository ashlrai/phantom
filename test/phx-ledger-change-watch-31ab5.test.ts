import { afterEach, describe, expect, it, vi } from 'vitest';
import { cmdResourceLedger } from '../src/cli/resource-ledger.js';
import type { ResourceLedgerV1 } from '../src/core/fleet/runs-resource-ledger.js';

const snapshot = (): ResourceLedgerV1 => ({
  v: 1, generatedAt: '2026-10-31T12:00:00Z', asOf: '2026-10-31T11:59:00Z',
  sources: { status: 'missing', apiSpend: 'missing', jobs: 'missing' },
  apiSpend: null, jobsMalformedRows: null,
  lanes: [{ lane: 'fake-personal', running: null, target: null, held: null, window: 'weekly',
    usedPct: 10, creditsRemaining: null, resetAt: null, burnPctPerHour: null,
    tokensPerHour6h: null, projectedExhaustion: null, source: null, deadSignal: null,
    observation: { source: 'codex-personal-sessions', asOf: '2026-10-31T11:58:00Z' } }],
});

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

async function watch(snapshots: ResourceLedgerV1[], extra: string[] = []) {
  vi.useFakeTimers();
  const out = vi.spyOn(console, 'log').mockImplementation(() => {});
  const read = vi.fn();
  for (const item of snapshots) read.mockResolvedValueOnce(item);
  const run = cmdResourceLedger([
    '--watch', '--json', '--changes-only', '--interval-ms', '1000',
    '--max-samples', String(snapshots.length), ...extra,
  ], read);
  await vi.runAllTimersAsync();
  expect(await run).toBe(0);
  expect(read).toHaveBeenCalledTimes(snapshots.length);
  expect(vi.getTimerCount()).toBe(0);
  return out.mock.calls.map(([line]) => JSON.parse(String(line)));
}

describe('resource ledger changes-only watch', () => {
  it('suppresses generatedAt-only changes and counts every observation toward the limit', async () => {
    const first = snapshot();
    const second = { ...first, generatedAt: '2026-10-31T12:01:00Z' };
    const third = { ...first, generatedAt: '2026-10-31T12:02:00Z' };
    expect(await watch([first, second, third])).toEqual([first]);
  });

  it('emits complete original snapshots for usage changes, including a return to an earlier value', async () => {
    const first = snapshot();
    const changed = { ...first, generatedAt: '2026-10-31T12:01:00Z',
      lanes: [{ ...first.lanes[0]!, usedPct: 11 }] };
    const restored = { ...first, generatedAt: '2026-10-31T12:02:00Z' };
    expect(await watch([first, changed, restored])).toEqual([first, changed, restored]);
  });

  it('reports a missing-to-healthy source transition even if usage is unchanged', async () => {
    const first = snapshot();
    const healthy: ResourceLedgerV1 = { ...first, sources: { ...first.sources, status: 'healthy' } };
    expect(await watch([first, healthy])).toEqual([first, healthy]);
  });

  it('reports provider and ledger observation time advancement independently', async () => {
    const first = snapshot();
    const provider: ResourceLedgerV1 = { ...first, lanes: [{ ...first.lanes[0]!,
      observation: { source: 'codex-personal-sessions', asOf: '2026-10-31T11:59:00Z' } }] };
    const ledger = { ...provider, asOf: '2026-10-31T12:00:00Z' };
    expect(await watch([first, provider, ledger])).toEqual([first, provider, ledger]);
  });

  it('reports changes in API spend and malformed job counts', async () => {
    const first = snapshot();
    const spend: ResourceLedgerV1 = { ...first, apiSpend: { rowsToday: 1, errorsToday: 0,
      tokensInToday: 3, tokensOutToday: 2, usdToday: 0.1, usdWeek: 0.1,
      lastAt: '2026-10-31T12:00:00Z', models: ['fake-model'], modelUsageToday: [], modelUsageTodayOmitted: 0 } };
    const jobs = { ...spend, jobsMalformedRows: 1 };
    expect(await watch([first, spend, jobs])).toEqual([first, spend, jobs]);
  });

  it('compares the filtered view while retaining global changes', async () => {
    const first = snapshot();
    const other = { ...first, lanes: [...first.lanes, { ...first.lanes[0]!, lane: 'other', usedPct: 99 }] };
    const global: ResourceLedgerV1 = { ...other, sources: { ...other.sources, jobs: 'healthy' } };
    const lines = await watch([first, other, global], ['--lane', 'fake-personal']);
    expect(lines).toEqual([first, global].map(item => ({ ...item, lanes: [item.lanes[0]],
      laneFilter: { lane: 'fake-personal', global: ['generatedAt', 'asOf', 'sources', 'apiSpend', 'jobsMalformedRows'] } })));
  });

  it('keeps read errors visible and does not count them as observations', async () => {
    vi.useFakeTimers();
    const out = vi.spyOn(console, 'log').mockImplementation(() => {});
    const first = snapshot();
    const read = vi.fn().mockResolvedValueOnce(first).mockRejectedValueOnce(new Error('private'))
      .mockResolvedValueOnce({ ...first, generatedAt: '2026-10-31T12:01:00Z' });
    const run = cmdResourceLedger(['--watch', '--json', '--changes-only', '--max-samples', '2'], read);
    await vi.runAllTimersAsync();
    expect(await run).toBe(0);
    expect(read).toHaveBeenCalledTimes(3);
    expect(out.mock.calls.map(([line]) => JSON.parse(String(line)))).toEqual([first, { v: 1, error: 'resource_ledger_read_failed' }]);
  });

  it.each([
    ['--changes-only'], ['--json', '--changes-only'], ['--watch', '--changes-only'],
    ['--watch', '--json', '--changes-only', '--changes-only'], ['--help', '--changes-only'],
  ])('rejects invalid arguments %j without reading', async (...args) => {
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const read = vi.fn();
    expect(await cmdResourceLedger(args, read)).toBe(2);
    expect(read).not.toHaveBeenCalled();
    expect(err).toHaveBeenCalledWith('Invalid ledger arguments; use phm resources ledger --help.\n');
  });

  it('documents the option and suppressed samples', async () => {
    const out = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await cmdResourceLedger(['--help'], vi.fn())).toBe(0);
    expect(out.mock.calls.flat().join('\n')).toContain('--changes-only requires --watch --json');
    expect(out.mock.calls.flat().join('\n')).toContain('including suppressed snapshots');
  });
});
