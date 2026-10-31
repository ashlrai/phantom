import { describe, expect, it } from 'vitest';
import { deriveFleetLedgerNotifications } from './deriveFleetLedgerNotifications.js';

const GENERATED = '2026-10-31T12:00:00.000Z';
const NOW = Date.parse('2026-10-31T12:05:00.000Z');

function laneRow(overrides: Record<string, unknown> = {}) {
  return {
    lane: 'claude', running: 0, target: 2, held: false,
    window: 'weekly', usedPct: 40, creditsRemaining: null,
    resetAt: null, burnPctPerHour: null, tokensPerHour6h: null,
    projectedExhaustion: null, source: 'status',
    deadSignal: { lane: 'claude', lastFinishes: 5, emptyFailures: 5, state: 'dead' },
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

describe('deriveFleetLedgerNotifications', () => {
  it('raises one high fleet notification per dead lane, pointing at the Usage pane', () => {
    const out = deriveFleetLedgerNotifications(ledger([laneRow()]), NOW);
    expect(out).toEqual([expect.objectContaining({
      id: 'fleet-lane-dead-claude', category: 'fleet', severity: 'high',
      title: 'claude is producing empty results',
      detail: '5 of the last 5 finishes changed nothing.',
      ts: GENERATED, actionLabel: 'Open usage',
    })]);
    expect(out[0]!.actionHref).toContain('fleet-usage');
  });

  it('notes that dispatch keeps launching while the dead lane still runs', () => {
    const out = deriveFleetLedgerNotifications(ledger([laneRow({ running: 2 })]), NOW);
    expect(out[0]!.detail).toBe('5 of the last 5 finishes changed nothing. Dispatch keeps launching into it.');
  });

  it('stays silent for a suspect lane — the Usage pane badge covers it', () => {
    const suspect = laneRow({ deadSignal: { lane: 'claude', lastFinishes: 5, emptyFailures: 3, state: 'suspect' } });
    expect(deriveFleetLedgerNotifications(ledger([suspect]), NOW)).toEqual([]);
  });

  it('skips a dead lane that is held — the runs deriver already notifies the hold', () => {
    expect(deriveFleetLedgerNotifications(ledger([laneRow({ held: true })]), NOW)).toEqual([]);
  });

  it('returns nothing for null or malformed input', () => {
    for (const bad of [null, undefined, {}, { v: 1 }, 'dead', ledger([{ lane: 'claude' }])]) {
      expect(deriveFleetLedgerNotifications(bad, NOW)).toEqual([]);
    }
  });

  it('drops the entry on the next derive once the signal returns to ok', () => {
    const dead = ledger([laneRow()]);
    const ok = ledger([laneRow({ deadSignal: { lane: 'claude', lastFinishes: 5, emptyFailures: 1, state: 'ok' } })]);
    expect(deriveFleetLedgerNotifications(dead, NOW).map((n) => n.id)).toEqual(['fleet-lane-dead-claude']);
    expect(deriveFleetLedgerNotifications(ok, NOW)).toEqual([]);
  });

  it('scrubs long tokens out of the lane name in the title', () => {
    const long = `worker ${'a'.repeat(40)}`;
    const row = laneRow({ lane: long, deadSignal: { lane: long, lastFinishes: 5, emptyFailures: 5, state: 'dead' } });
    const out = deriveFleetLedgerNotifications(ledger([row]), NOW);
    expect(out[0]!.title).toBe('worker … is producing empty results');
  });
});
