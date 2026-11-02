import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cmdResourceLedger } from '../src/cli/resource-ledger.js';
import type { ResourceLaneRow, ResourceLedgerV1 } from '../src/core/fleet/runs-resource-ledger.js';

const at = Date.parse('2026-10-31T16:02:00Z');
const row: ResourceLaneRow = {
  lane: 'fake-lane', running: 0, target: 1, held: false, window: 'weekly', usedPct: 20,
  creditsRemaining: null, resetAt: null, burnPctPerHour: null, tokensPerHour6h: null,
  projectedExhaustion: null, source: 'fake-status', deadSignal: null,
};
const ledger = (changes: Partial<ResourceLaneRow> = {}, overrides: Partial<ResourceLedgerV1> = {}): ResourceLedgerV1 => ({
  v: 1, generatedAt: new Date(at).toISOString(), asOf: new Date(at).toISOString(),
  sources: { status: 'healthy', jobs: 'missing', apiSpend: 'missing' },
  lanes: [{ ...row, ...changes }], apiSpend: null, jobsMalformedRows: null, ...overrides,
});
const args = ['--lane', 'fake-lane', '--wait-headroom-seconds', '3', '--interval-ms', '1000', '--json'];
let output: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.useFakeTimers();
  output = vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

function report() {
  expect(output).toHaveBeenCalledOnce();
  return JSON.parse(String(output.mock.calls[0]![0])) as { result: string; state: string; lane: string };
}
async function finishWait(read: () => Promise<ResourceLedgerV1>, now: () => number = () => at) {
  const run = cmdResourceLedger(args, read, undefined, now);
  await vi.advanceTimersByTimeAsync(3000);
  return run;
}

describe('resource ledger wait for headroom', () => {
  it('waits through exhaustion, measured recovery while held, and a full slot', async () => {
    const read = vi.fn()
      .mockResolvedValueOnce(ledger({ usedPct: 100, held: true }))
      .mockResolvedValueOnce(ledger({ usedPct: 15, held: true }))
      .mockResolvedValueOnce(ledger({ usedPct: 15, running: 1 }))
      .mockResolvedValueOnce(ledger({ usedPct: 15 }));
    const run = cmdResourceLedger([...args.slice(0, 3), '4', ...args.slice(4)], read, undefined, () => at);
    await vi.advanceTimersByTimeAsync(3000);
    expect(await run).toBe(0);
    expect(read).toHaveBeenCalledTimes(4);
    expect(report()).toMatchObject({ result: 'ready', state: 'ready', lane: 'fake-lane' });
  });

  it.each([
    ['exhausted', ledger({ usedPct: 100, resetAt: '2026-10-30T00:00:00Z' }), 'exhausted'],
    ['held', ledger({ held: true }), 'held'],
    ['full', ledger({ running: 1 }), 'full'],
    ['unknown usage', ledger({ usedPct: null }), 'unknown'],
    ['invalid usage', ledger({ usedPct: NaN }), 'unknown'],
    ['invalid counts', ledger({ running: 0.5 }), 'unknown'],
    ['unknown hold', ledger({ held: null }), 'unknown'],
    ['missing lane', ledger({}, { lanes: [] }), 'unknown'],
    ['degraded status', ledger({}, { sources: { status: 'degraded', jobs: 'healthy', apiSpend: 'healthy' } }), 'unknown'],
    ['stale after reset', ledger({ resetAt: '2026-10-30T00:00:00Z' }, { asOf: '2026-10-31T15:00:00Z' }), 'stale'],
    ['malformed timestamp', ledger({}, { asOf: 'yesterday' }), 'unknown'],
    ['invalid calendar date', ledger({}, { asOf: '2026-02-30T00:00:00Z' }), 'unknown'],
    ['future timestamp', ledger({}, { asOf: '2026-10-31T16:02:01Z' }), 'unknown'],
    ['future quota observation', ledger({ observation: { source: 'codex-personal-sessions', asOf: '2026-10-31T16:02:01Z' } }), 'unknown'],
    ['stale quota observation', ledger({ observation: { source: 'codex-personal-sessions', asOf: '2026-10-31T15:00:00Z' } }), 'stale'],
    ['missing personal observation', ledger({ source: 'codex-personal-sessions' }), 'unknown'],
    ['zero credits', ledger({ window: 'credits', creditsRemaining: 0 }), 'exhausted'],
    ['missing credits', ledger({ window: 'credits', creditsRemaining: null }), 'unknown'],
  ])('times out with %s as %s', async (_description, sample, state) => {
    expect(await finishWait(async () => sample)).toBe(1);
    expect(report()).toMatchObject({ result: 'timeout', state });
  });

  it.each([
    ledger({ window: 'credits', creditsRemaining: 0.01 }),
    ledger({ window: 'none', usedPct: null }),
    ledger({ observation: { source: 'codex-personal-sessions', asOf: '2026-10-31T16:00:00Z' } }),
  ])('accepts fresh measured credits, unmetered status, or separate fresh observation', async sample => {
    expect(await cmdResourceLedger(args, async () => sample, undefined, () => at)).toBe(0);
    expect(report()).toMatchObject({ result: 'ready', state: 'ready' });
  });

  it('recomputes freshness on each read and uses monotonic time for the deadline', async () => {
    let wall = at;
    const read = vi.fn(async () => { wall -= 600_000; return ledger(); });
    expect(await finishWait(read, () => wall)).toBe(1);
    expect(read).toHaveBeenCalledTimes(3);
    expect(report()).toMatchObject({ result: 'timeout', state: 'unknown' });
  });

  it('reports a safe read failure once', async () => {
    expect(await cmdResourceLedger(args, async () => { throw new Error('private fake'); }, undefined, () => at)).toBe(1);
    expect(report()).toMatchObject({ result: 'read_failed', state: 'unknown' });
  });

  it('aborts an in-flight reader and removes timers and listeners', async () => {
    const controller = new AbortController();
    const beforeInt = process.listenerCount('SIGINT');
    const beforeTerm = process.listenerCount('SIGTERM');
    const remove = vi.spyOn(controller.signal, 'removeEventListener');
    const run = cmdResourceLedger(args, () => new Promise(() => {}), controller.signal, () => at);
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    expect(await run).toBe(1);
    expect(report()).toMatchObject({ result: 'aborted' });
    expect(vi.getTimerCount()).toBe(0);
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
    expect(process.listenerCount('SIGINT')).toBe(beforeInt);
    expect(process.listenerCount('SIGTERM')).toBe(beforeTerm);
  });

  it('bounds a stalled reader at the deadline', async () => {
    expect(await finishWait(() => new Promise(() => {}))).toBe(1);
    expect(report()).toMatchObject({ result: 'timeout', state: 'unknown' });
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    ['--wait-headroom-seconds', '1'],
    ['--lane', 'fake-lane', '--wait-headroom-seconds', '0'],
    ['--lane', 'fake-lane', '--wait-headroom-seconds', '3601'],
    ['--lane', 'fake-lane', '--wait-headroom-seconds', '1.5'],
    ['--lane', 'fake-lane', '--wait-headroom-seconds', '1', '--watch'],
    ['--lane', 'fake-lane', '--wait-headroom-seconds', '1', '--changes-only'],
    ['--lane', 'fake-lane', '--wait-headroom-seconds', '1', '--max-samples', '2'],
    ['--lane', 'fake-lane', '--wait-headroom-seconds', '1', '--model', 'fake'],
    ['--lane', 'fake-lane', '--wait-headroom-seconds', '1', '--check-fresh-seconds', '1'],
    ['--lane', 'fake-lane', '--wait-headroom-seconds', '1', '--interval-ms', '999'],
  ])('rejects invalid arguments %j', async (...invalid) => {
    const read = vi.fn();
    expect(await cmdResourceLedger(invalid, read)).toBe(2);
    expect(read).not.toHaveBeenCalled();
  });
});
