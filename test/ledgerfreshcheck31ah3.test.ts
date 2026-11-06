import { afterEach, describe, expect, it, vi } from 'vitest';
import { cmdResourceLedger } from '../src/cli/resource-ledger.js';
import { cmdResources } from '../src/cli/resources.js';
import * as reader from '../src/core/fleet/runs-resource-ledger.js';
import type { ResourceLaneRow, ResourceLedgerV1 } from '../src/core/fleet/runs-resource-ledger.js';

const now = Date.parse('2026-10-31T12:00:00Z');
const row = (lane: string): ResourceLaneRow => ({
  lane, running: 1, target: 2, held: false, window: 'none', usedPct: null,
  creditsRemaining: null, resetAt: null, burnPctPerHour: null, tokensPerHour6h: null,
  projectedExhaustion: null, source: 'status', deadSignal: null,
});
const ledger: ResourceLedgerV1 = {
  v: 1, generatedAt: '2026-10-31T11:59:00Z', asOf: '2026-10-31T11:59:00Z',
  sources: { status: 'healthy', apiSpend: 'healthy', jobs: 'missing' },
  lanes: [row('alpha'), row('beta')], jobsMalformedRows: null,
  apiSpend: { rowsToday: 1, errorsToday: 0, tokensInToday: 5, tokensOutToday: 2,
    usdToday: 1, usdWeek: 2, lastAt: '2026-10-31T11:59:00Z', models: ['model-a'],
    modelUsageToday: [{ model: 'model-a', rows: 1, errors: 0, inputTokens: 5, outputTokens: 2, usd: 1, lastAt: '2026-10-31T11:59:00Z' }],
    modelUsageTodayOmitted: 0 },
};

afterEach(() => vi.restoreAllMocks());

describe('ledger freshness check', () => {
  it.each([
    ['current', '2026-10-31T12:00:00Z', '0', 0, 'pass', 0],
    ['inclusive boundary', '2026-10-31T11:59:00Z', '60', 60, 'pass', 0],
    ['fractionally stale', '2026-10-31T11:58:59.999Z', '60', 60.001, 'stale', 1],
    ['unavailable', null, '60', null, 'unknown', 1],
    ['invalid', 'not a timestamp', '60', null, 'unknown', 1],
    ['future', '2026-10-31T12:00:00.001Z', '60', -0.001, 'unknown', 1],
  ])('reports %s observations against the injected clock', async (_name, asOf, threshold, age, result, code) => {
    const out = vi.spyOn(console, 'log').mockImplementation(() => {});
    const read = vi.fn().mockResolvedValue({ ...ledger, asOf });
    expect(await cmdResourceLedger(['--json', '--check-fresh-seconds', threshold], read, undefined, () => now)).toBe(code);
    expect(read).toHaveBeenCalledOnce();
    expect(out).toHaveBeenCalledOnce();
    expect(JSON.parse(String(out.mock.calls[0]![0]))).toEqual({ ...ledger, asOf,
      freshnessCheck: { v: 1, maxAgeSeconds: Number(threshold), observedAgeSeconds: age, result } });
  });

  it('uses the global observation with lane and model filters, preserving accounting', async () => {
    const out = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await cmdResourceLedger(['--json', '--lane', 'alpha', '--model', 'model-a', '--check-fresh-seconds', '59'], async () => ledger, undefined, () => now)).toBe(1);
    const view = JSON.parse(String(out.mock.calls[0]![0]));
    expect(view.lanes).toEqual([ledger.lanes[0]]);
    expect(view.laneFilter.lane).toBe('alpha');
    expect(view.modelFilter.model).toBe('model-a');
    expect(view.apiSpend).toEqual(ledger.apiSpend);
    expect(view.freshnessCheck).toEqual({ v: 1, maxAgeSeconds: 59, observedAgeSeconds: 60, result: 'stale' });
  });

  it('prints the normal text plus a check and leaves both output formats unchanged without the option', async () => {
    const out = vi.spyOn(console, 'log').mockImplementation(() => {});
    const read = async () => ledger;
    expect(await cmdResourceLedger([], read, undefined, () => now)).toBe(0);
    const normal = out.mock.calls.map(([line]) => line);
    out.mockClear();
    expect(await cmdResourceLedger(['--check-fresh-seconds', '60'], read, undefined, () => now)).toBe(0);
    expect(out.mock.calls.slice(0, normal.length).map(([line]) => line)).toEqual(normal);
    expect(out.mock.calls.at(-1)![0]).toContain('Freshness check v1: pass; observed age 60 seconds; maximum 60 seconds');
    out.mockClear();
    expect(await cmdResourceLedger(['--json'], read, undefined, () => now)).toBe(0);
    expect(out).toHaveBeenCalledExactlyOnceWith(JSON.stringify(ledger, null, 2));
  });

  it.each([
    ['--check-fresh-seconds'], ['--check-fresh-seconds', ''], ['--check-fresh-seconds', '-1'],
    ['--check-fresh-seconds', '1.5'], ['--check-fresh-seconds', '1e3'],
    ['--check-fresh-seconds', '9007199254740992'], ['--check-fresh-seconds', '1', '--check-fresh-seconds', '2'],
    ['--watch', '--check-fresh-seconds', '1'], ['--check-fresh-seconds', '0', '--watch', '--json'],
  ])('rejects invalid arguments %j before reading', async (...args) => {
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const read = vi.fn();
    expect(await cmdResourceLedger(args, read)).toBe(2);
    expect(read).not.toHaveBeenCalled();
  });

  it('routes the check through the public resources dispatcher', async () => {
    const out = vi.spyOn(console, 'log').mockImplementation(() => {});
    const read = vi.spyOn(reader, 'readResourceLedger').mockResolvedValue(ledger);
    vi.spyOn(Date, 'now').mockReturnValue(now);
    expect(await cmdResources(['ledger', '--json', '--check-fresh-seconds', '60'])).toBe(0);
    expect(read).toHaveBeenCalledOnce();
    expect(JSON.parse(String(out.mock.calls[0]![0])).freshnessCheck.result).toBe('pass');
  });

  it('documents the output, global scope, failure and one-shot contract through the dispatcher', async () => {
    const out = vi.spyOn(console, 'log').mockImplementation(() => {});
    const read = vi.spyOn(reader, 'readResourceLedger');
    expect(await cmdResources(['ledger', '--help'])).toBe(0);
    expect(read).not.toHaveBeenCalled();
    const help = out.mock.calls.flat().join('\n');
    expect(help).toContain('--check-fresh-seconds N');
    expect(help).toContain('global status asOf');
    expect(help).toContain('pass, stale or unknown');
    expect(help).toContain('Exit 1');
    expect(help).toContain('One-shot only');
  });
});
