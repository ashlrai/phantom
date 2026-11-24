import { describe, expect, it, vi } from 'vitest';
import { buildAskBatch } from '../src/core/fleet/asks-batch.js';
import type { HomeSummary } from '../src/core/fleet/home.js';
import type { PoolRow, PoolsViewV1 } from '../src/core/fleet/pools-view.js';
import { buildToday, todayText } from '../src/core/fleet/today.js';
import { cmdToday } from '../src/cli/today.js';

const NOW = Date.parse('2026-11-21T14:00:00Z');
const ok = <T,>(value: T) => ({ state: 'ok' as const, value });
const home = (over: Partial<HomeSummary> = {}): HomeSummary => ({
  schema: 'home.v1', asOf: '2026-11-21T14:00:00.000Z', health: 'healthy', headline: 'Healthy',
  mergedLastHour: ok(14), merged24h: ok(120), medianMergeSeconds: ok(300), main: ok([]),
  running: ok([{ lane: 'claude', running: 4, target: 8 }, { lane: 'codex', running: 5, target: 7 }]),
  atRisk: ok(null), worklog: ok([]), unreadLeaderReplies: ok(0), needsYou: ok([]), ...over,
});
const pool = (id: string, usedPct: number | null, resetAt: string | null, over: Partial<PoolRow> = {}): PoolRow => ({
  id, kind: 'subscription', usedPct, state: usedPct === null ? 'unknown' : 'measured', resetAt, hoursLeft: null, elapsedPct: null, burnPctPerHour: null,
  burnBasis: null, burn: { samples: 0, window_h: 0, method: 'none' }, projectedUnusedPct: null, projectedEmptyAt: null, verdict: 'unknown', wasteRisk: 'unknown',
  creditsRemaining: null, held: null, running: null, target: null, source: null, scopes: [], asOf: null, reason: null, summary: '', ...over,
});
const view = (pools: PoolRow[]): PoolsViewV1 => ({ schema: 'pools.v1', generatedAt: '2026-11-21T14:00:00.000Z', staleAfterMinutes: 60, pools, gaps: [] });
const none = buildAskBatch([]);

describe('buildToday', () => {
  it('with no asks and pools all full of room: one sentence, lanes, no empty pools, no asks', () => {
    const t = buildToday({ home: home(), pools: view([pool('claude', 40, '2026-11-25T00:00:00Z'), pool('codex-personal', 10, null)]), asks: none }, NOW, 'UTC');
    expect(t.sentence).toBe('14 PRs merged in the last hour; 9 jobs running; every pool has room.');
    expect(t.running).toEqual({ total: 9, lanes: [{ lane: 'claude', running: 4, target: 8 }, { lane: 'codex', running: 5, target: 7 }] });
    expect(t.emptyPools).toEqual([]);
    expect(t.asks).toEqual([]);
    expect(t.unknown).toEqual([]);
    expect(todayText(t).join('\n')).toContain('Needs you\n  nothing');
  });

  it('with one ask: it is listed with its one-tap answers and the sentence says a question waits', () => {
    const asks = buildAskBatch([{ id: 'nm-credit', question: 'Use the gifted API credit before it ends? yes / no', kind: 'yes-no', askedAt: '2026-11-20T00:00:00.000Z', expires: '2026-11-24T00:00:00.000Z', hardLimit: 'money' }]);
    const t = buildToday({ home: home(), pools: view([]), asks }, NOW, 'UTC');
    expect(t.asks).toEqual([expect.objectContaining({ id: 'nm-credit', number: 1, choices: ['yes', 'no'], expires: '2026-11-24T00:00:00.000Z' })]);
    expect(t.sentence).toContain('1 question needs you');
  });

  it('names an empty pool and the time it is back, soonest first; same day shows the clock only', () => {
    const t = buildToday({ home: home(), pools: view([
      pool('claude', 100, '2026-11-23T09:00:00Z'), pool('codex-personal', 100, '2026-11-21T15:30:00Z'), pool('grok', 99, null),
    ]), asks: none }, NOW, 'UTC');
    expect(t.emptyPools?.map((p) => [p.label, p.returns])).toEqual([['Codex personal', 'back 3:30 PM'], ['Claude', 'back Mon 9:00 AM']]);
    expect(t.sentence).toContain('2 pools are empty, Codex personal is back 3:30 PM');
  });

  it('a source that could not be read is unknown with a reason, never zero', () => {
    const t = buildToday({ home: null, pools: null, asks: null }, NOW, 'UTC');
    expect(t.merged.lastHour).toBeNull();
    expect(t.running.total).toBeNull();
    expect(t.emptyPools).toBeNull();
    expect(t.asks).toBeNull();
    expect(t.sentence).toBe('PRs merged: unknown; jobs running: unknown.');
    expect(t.unknown).toHaveLength(3);
  });
});

describe('phm today', () => {
  it('--json prints today.v1 and rejects unknown options', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(await cmdToday(['--json'], async () => ({ home: home(), pools: view([]), asks: none }))).toBe(0);
    expect(JSON.parse(String(log.mock.calls[0]![0])).schema).toBe('today.v1');
    expect(await cmdToday(['--nope'])).toBe(2);
    log.mockRestore(); err.mockRestore();
  });
});
