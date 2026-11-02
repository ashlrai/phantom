import { describe, expect, it } from 'vitest';
import { deriveFleetLedgerNotifications } from './deriveFleetLedgerNotifications.js';

const GENERATED = '2026-10-31T19:28:00.000Z';
const NOW = Date.parse(GENERATED);
const inHours = (h: number) => new Date(NOW + h * 3_600_000).toISOString();

function laneRow(overrides: Record<string, unknown> = {}) {
  return {
    lane: 'devin', running: 10, target: 10, held: false,
    window: 'credits', usedPct: 0, creditsRemaining: null,
    resetAt: inHours(9), burnPctPerHour: 0, tokensPerHour6h: null,
    projectedExhaustion: null, source: 'status', deadSignal: null,
    ...overrides,
  };
}

function ledger(lanes: unknown[] = []) {
  return {
    v: 1, generatedAt: GENERATED,
    sources: { status: 'healthy', apiSpend: 'healthy', jobs: 'healthy' },
    asOf: GENERATED, lanes, apiSpend: null,
  };
}

describe('deriveFleetLedgerNotifications reset waste', () => {
  it('warns when a lane will hit reset with the window still unused', () => {
    const out = deriveFleetLedgerNotifications(ledger([laneRow()]), NOW);
    expect(out).toEqual([expect.objectContaining({
      id: 'ledger-waste-devin', category: 'fleet', severity: 'high',
      title: 'devin: 100% unused, resets in 9h',
      detail: '~100% still unused at reset.',
      ts: GENERATED, actionLabel: 'Open usage',
    })]);
    expect(out[0]!.actionHref).toContain('fleet-usage');
  });

  it('stays silent when the lane already spent most of the window', () => {
    expect(deriveFleetLedgerNotifications(ledger([laneRow({ usedPct: 90 })]), NOW)).toEqual([]);
  });

  it('stays silent when the reset is still days away', () => {
    expect(deriveFleetLedgerNotifications(ledger([laneRow({ resetAt: inHours(72) })]), NOW)).toEqual([]);
  });

  it('stays silent when resetAt is null', () => {
    expect(deriveFleetLedgerNotifications(ledger([laneRow({ resetAt: null })]), NOW)).toEqual([]);
  });

  it('names idle dispatch slots in the detail', () => {
    const out = deriveFleetLedgerNotifications(ledger([laneRow({ running: 7 })]), NOW);
    expect(out[0]!.detail).toBe('~100% still unused at reset · 3 idle slots.');
  });

  it('notes a held lane instead of staying silent when usage is still visible', () => {
    const out = deriveFleetLedgerNotifications(ledger([laneRow({ held: true })]), NOW);
    expect(out).toEqual([expect.objectContaining({
      id: 'ledger-waste-devin', detail: '~100% still unused at reset · lane held.',
    })]);
  });

  it('suppresses a held lane whose usage is not visible at all', () => {
    const row = laneRow({ held: true, usedPct: null, creditsRemaining: 100 });
    expect(deriveFleetLedgerNotifications(ledger([row]), NOW)).toEqual([]);
  });

  it('emits one item per wasting lane', () => {
    const out = deriveFleetLedgerNotifications(ledger([
      laneRow(),
      laneRow({ lane: 'codex', window: 'weekly', usedPct: 10 }),
      laneRow({ lane: 'claude', window: 'weekly', usedPct: 95 }),
    ]), NOW);
    expect(out.map((n) => n.id)).toEqual(['ledger-waste-devin', 'ledger-waste-codex']);
  });

  it('keeps the dead-lane item alongside the waste item for the same lane', () => {
    const row = laneRow({ deadSignal: { lane: 'devin', lastFinishes: 5, emptyFailures: 5, state: 'dead' } });
    const out = deriveFleetLedgerNotifications(ledger([row]), NOW);
    expect(out.map((n) => n.id)).toEqual(['fleet-lane-dead-devin', 'ledger-waste-devin']);
  });
});
