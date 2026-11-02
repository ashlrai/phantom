import { describe, expect, it, vi } from 'vitest';
import { runUsageDeltaProbe } from '../examples/agents/usage-delta-probe.js';
import type { ResourceLedgerV1, ResourceLaneRow } from '../src/core/fleet/runs-resource-ledger.js';

const at = (second: number) => `2026-01-01T00:00:${String(second).padStart(2, '0')}Z`;
function ledger(usedPct: number | null, second: number, changes: Partial<ResourceLaneRow> = {}): ResourceLedgerV1 {
  return {
    v: 1, generatedAt: at(second), asOf: at(second),
    sources: { status: 'healthy', apiSpend: 'missing', jobs: 'degraded' }, apiSpend: null, jobsMalformedRows: 1,
    lanes: [{ lane: 'claude', running: 1, target: 2, held: true, window: 'weekly', usedPct,
      creditsRemaining: null, resetAt: null, burnPctPerHour: null, tokensPerHour6h: 100,
      projectedExhaustion: null, source: 'status', deadSignal: null, ...changes }],
  };
}
async function probe(first: ResourceLedgerV1, second: ResourceLedgerV1) {
  const readLedger = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second);
  const wait = vi.fn().mockResolvedValue(undefined);
  const output = vi.fn();
  const now = vi.fn().mockReturnValueOnce(Date.parse(at(10))).mockReturnValueOnce(Date.parse(at(11)));
  const code = await runUsageDeltaProbe(['--lane', 'claude', '--interval-ms', '1000'], { readLedger, wait, output, now });
  return { code, result: JSON.parse(output.mock.calls[0]![0] as string), readLedger, wait, output };
}

describe('agent usage delta probe', () => {
  it('compares rising weekly usage, token rate, running and timestamps while preserving held state and health', async () => {
    const { code, result, readLedger, wait, output } = await probe(ledger(10, 0), ledger(14, 1, { running: 2, tokensPerHour6h: 150, held: true }));
    expect(code).toBe(0);
    expect(readLedger).toHaveBeenCalledTimes(2);
    expect(wait).toHaveBeenCalledWith(1000, expect.any(AbortSignal));
    expect(output).toHaveBeenCalledTimes(1);
    expect(result.changes).toEqual({ usage: { state: 'advanced', deltaPct: 4 },
      tokensPerHour6h: { state: 'increased', delta: 50 }, running: { state: 'increased', delta: 1 },
      observedAt: 'advanced', statusAsOf: 'advanced' });
    expect(result.before.lane.held).toBe(true);
    expect(result.after.lane.held).toBe(true);
    expect(result.after.sources).toEqual({ status: 'healthy', apiSpend: 'missing', jobs: 'degraded' });
    expect(result.before.sampledAt).toBe('2026-01-01T00:00:10.000Z');
  });

  it('labels a lower weekly percentage as a possible reset without negative spend', async () => {
    const { result } = await probe(ledger(90, 0), ledger(4, 1));
    expect(result.changes.usage).toEqual({ state: 'reset', deltaPct: null });
  });

  it('reports stale observation timestamps even when values differ', async () => {
    const observation = { source: 'codex-personal-sessions' as const, asOf: at(0) };
    const { result } = await probe(ledger(10, 1, { observation }), ledger(11, 2, { observation }));
    expect(result.changes.observedAt).toBe('stale');
    expect(result.changes.statusAsOf).toBe('advanced');
  });

  it('keeps null usage unknown and does not infer a quota', async () => {
    const { result } = await probe(ledger(null, 0), ledger(null, 1));
    expect(result.changes.usage).toEqual({ state: 'unknown', deltaPct: null });
    expect(result.after.lane.usedPct).toBeNull();
    expect(JSON.stringify(result)).not.toMatch(/"(?:quota|remaining|spend)"\s*:/i);
  });

  it('distinguishes unchanged data, absent lanes and incompatible sources', async () => {
    const same = await probe(ledger(10, 0), ledger(10, 1));
    expect(same.result.changes.usage).toEqual({ state: 'unchanged', deltaPct: 0 });
    const missing = ledger(10, 1); missing.lanes = [];
    expect((await probe(ledger(10, 0), missing)).result.changes.usage.state).toBe('missing');
    const changed = await probe(ledger(10, 0), ledger(20, 1, { source: 'other' }));
    expect(changed.result.changes.usage.state).toBe('unknown');
    expect(changed.result.changes.tokensPerHour6h.state).toBe('unknown');
    expect((await probe(ledger(10, 0), ledger(20, 1, { window: 'credits' }))).result.changes.usage.state).toBe('unknown');
  });

  it('handles missing and backward timestamps and null numeric fields', async () => {
    const first = ledger(10, 1, { running: null, tokensPerHour6h: null });
    const second = ledger(10, 0); second.asOf = null;
    const { result } = await probe(first, second);
    expect(result.changes.running).toEqual({ state: 'unknown', delta: null });
    expect(result.changes.tokensPerHour6h).toEqual({ state: 'unknown', delta: null });
    expect(result.changes.observedAt).toBe('missing');
    expect((await probe(ledger(10, 1), ledger(10, 0))).result.changes.observedAt).toBe('reset');
  });

  it.each([
    [], ['--lane', 'claude'], ['--lane', '../bad', '--interval-ms', '1000'],
    ['--lane', 'claude', '--interval-ms', '999'], ['--lane', 'claude', '--interval-ms', '60001'],
    ['--lane', 'claude', '--interval-ms', '1e3'], ['--lane', 'claude', '--interval-ms', '1000', '--lane', 'x'],
  ])('rejects invalid arguments without reading: %j', async (...args) => {
    const readLedger = vi.fn(); const output = vi.fn();
    expect(await runUsageDeltaProbe(args, { readLedger, output })).toBe(2);
    expect(JSON.parse(output.mock.calls[0]![0] as string)).toEqual({ v: 1, error: 'invalid_arguments' });
    expect(readLedger).not.toHaveBeenCalled();
  });

  it('hides reader failures', async () => {
    const output = vi.fn();
    const code = await runUsageDeltaProbe(['--lane', 'claude', '--interval-ms', '1000'], {
      readLedger: async () => { throw new Error('private details'); }, output,
    });
    expect(code).toBe(1);
    expect(JSON.parse(output.mock.calls[0]![0] as string)).toEqual({ v: 1, error: 'probe_failed' });
  });

  it('does not read when already aborted', async () => {
    const controller = new AbortController(); controller.abort();
    const readLedger = vi.fn(); const output = vi.fn();
    expect(await runUsageDeltaProbe(['--lane', 'claude', '--interval-ms', '1000'], { readLedger, output, signal: controller.signal })).toBe(130);
    expect(readLedger).not.toHaveBeenCalled();
    expect(JSON.parse(output.mock.calls[0]![0] as string)).toEqual({ v: 1, error: 'interrupted' });
  });

  it.each(['SIGINT', 'SIGTERM'] as const)('cleans up the timer and signal listeners on %s', async event => {
    vi.useFakeTimers();
    try {
      const before = ['SIGINT', 'SIGTERM'].map(name => process.listenerCount(name));
      const readLedger = vi.fn().mockResolvedValue(ledger(10, 0));
      const output = vi.fn();
      const pending = runUsageDeltaProbe(['--lane', 'claude', '--interval-ms', '1000'], { readLedger, output });
      await vi.advanceTimersByTimeAsync(0);
      expect(vi.getTimerCount()).toBe(1);
      process.emit(event);
      expect(await pending).toBe(event === 'SIGINT' ? 130 : 143);
      expect(vi.getTimerCount()).toBe(0);
      expect(['SIGINT', 'SIGTERM'].map(name => process.listenerCount(name))).toEqual(before);
      expect(readLedger).toHaveBeenCalledTimes(1);
      expect(JSON.parse(output.mock.calls[0]![0] as string)).toEqual({ v: 1, error: 'interrupted' });
    } finally { vi.useRealTimers(); }
  });
});
