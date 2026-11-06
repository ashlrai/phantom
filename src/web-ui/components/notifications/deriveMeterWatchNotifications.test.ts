import { describe, expect, it } from 'vitest';
import { deriveMeterWatchNotifications } from './deriveMeterWatchNotifications.js';
import type { MeterWatchLog } from './meter-watch-model.js';

const GENERATED = '2026-10-31T12:00:00.000Z';
const NOW = Date.parse('2026-10-31T13:00:00.000Z');
const MIN = 60_000;

function laneRow(overrides: Record<string, unknown> = {}) {
  return {
    lane: 'codex-personal', running: 12, target: 12, held: false,
    window: 'weekly', usedPct: 40, creditsRemaining: null,
    resetAt: null, burnPctPerHour: null, tokensPerHour6h: null,
    projectedExhaustion: null, source: 'codex-personal-sessions',
    ...overrides,
  };
}
const ledger = (lanes: unknown[]) => ({
  v: 1, generatedAt: GENERATED,
  sources: { status: 'healthy', apiSpend: 'healthy', jobs: 'healthy' },
  asOf: GENERATED, lanes, apiSpend: null,
});
const stillLog = (lane = 'codex-personal', minutes = 62): MeterWatchLog => ({
  [lane]: [
    { at: NOW - minutes * MIN, usedPct: 40, creditsRemaining: null },
    { at: NOW, usedPct: 40, creditsRemaining: null },
  ],
});

describe('deriveMeterWatchNotifications', () => {
  it('raises one warn-band fleet item per stuck lane, pointing at the Usage pane', () => {
    const out = deriveMeterWatchNotifications(stillLog(), ledger([laneRow()]), NOW);
    expect(out).toEqual([expect.objectContaining({
      id: 'meter-stuck-codex-personal', category: 'fleet', severity: 'high',
      title: 'codex-personal meter has not moved in 62 min while 12 run',
      detail: "Treat as an incident: check the lane's sessions and the ledger source",
      ts: GENERATED, actionLabel: 'Open usage',
    })]);
    expect(out[0]!.actionHref).toContain('fleet-usage');
  });

  it('stays silent while the meter moves, the lane is idle, or history is too short', () => {
    const moved: MeterWatchLog = { 'codex-personal': [
      { at: NOW - 61 * MIN, usedPct: 39, creditsRemaining: null },
      { at: NOW, usedPct: 40, creditsRemaining: null },
    ] };
    expect(deriveMeterWatchNotifications(moved, ledger([laneRow()]), NOW)).toEqual([]);
    expect(deriveMeterWatchNotifications(stillLog(), ledger([laneRow({ running: 0 })]), NOW)).toEqual([]);
    expect(deriveMeterWatchNotifications(stillLog('codex-personal', 30), ledger([laneRow()]), NOW)).toEqual([]);
    expect(deriveMeterWatchNotifications({}, ledger([laneRow()]), NOW)).toEqual([]);
  });

  it('returns nothing for null or malformed input', () => {
    for (const bad of [null, undefined, {}, { v: 1 }, 'stuck', ledger([{ lane: 1 }])]) {
      expect(deriveMeterWatchNotifications(stillLog(), bad, NOW)).toEqual([]);
    }
  });

  it('emits one item per stuck lane and retires it once the meter moves', () => {
    const rows = [laneRow(), laneRow({ lane: 'claude' })];
    const log = { ...stillLog(), ...stillLog('claude') };
    expect(deriveMeterWatchNotifications(log, ledger(rows), NOW).map((n) => n.id))
      .toEqual(['meter-stuck-codex-personal', 'meter-stuck-claude']);
    const moved = { claude: [{ at: NOW - 61 * MIN, usedPct: 39, creditsRemaining: null }, { at: NOW, usedPct: 40, creditsRemaining: null }] };
    expect(deriveMeterWatchNotifications(moved, ledger(rows), NOW)).toEqual([]);
  });

  it('scrubs long tokens out of the lane name in the title', () => {
    const long = `lane ${'a'.repeat(40)}`;
    const out = deriveMeterWatchNotifications(stillLog(long), ledger([laneRow({ lane: long })]), NOW);
    expect(out[0]!.title).toBe('lane … meter has not moved in 62 min while 12 run');
  });
});
