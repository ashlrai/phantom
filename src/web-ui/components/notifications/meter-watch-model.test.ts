import { describe, expect, it } from 'vitest';
import type { ResourceLedgerV1 } from '../../routes/verse/usage/fleet-ledger-model.js';
import {
  METER_WATCH_MAX_AGE_MS,
  METER_WATCH_MAX_SAMPLES,
  METER_WATCH_SAMPLE_GAP_MS,
  meterStalls,
  recordMeterSample,
  type MeterSample,
  type MeterWatchLog,
} from './meter-watch-model.js';

const NOW = Date.parse('2026-10-31T12:00:00.000Z');
const MIN = 60_000;

function laneRow(overrides: Record<string, unknown> = {}) {
  return {
    lane: 'codex-personal', running: 5, target: 12, held: false,
    window: 'weekly', usedPct: 40, creditsRemaining: null,
    resetAt: null, burnPctPerHour: null, tokensPerHour6h: null,
    projectedExhaustion: null, source: 'codex-personal-sessions',
    ...overrides,
  };
}
const ledger = (lanes: unknown[]): ResourceLedgerV1 => ({
  v: 1, generatedAt: '2026-10-31T12:00:00.000Z',
  sources: { status: 'healthy', apiSpend: 'healthy', jobs: 'healthy' },
  asOf: '2026-10-31T12:00:00.000Z', lanes, apiSpend: null,
} as ResourceLedgerV1);
const sample = (at: number, usedPct: number | null = 40, creditsRemaining: number | null = null): MeterSample =>
  ({ at, usedPct, creditsRemaining });

describe('recordMeterSample', () => {
  it('appends each lane\'s current reading and returns a new log without mutating', () => {
    const before: MeterWatchLog = { 'codex-personal': [sample(NOW - 10 * MIN)] };
    const after = recordMeterSample(before, ledger([laneRow()]), NOW);
    expect(after['codex-personal']).toEqual([sample(NOW - 10 * MIN), sample(NOW)]);
    expect(before['codex-personal']).toHaveLength(1);
    expect(after).not.toBe(before);
  });

  it('folds an unchanged reading inside the gap instead of spending a sample', () => {
    const log = recordMeterSample({ 'codex-personal': [sample(NOW - MIN)] }, ledger([laneRow()]), NOW);
    expect(log['codex-personal']).toHaveLength(1);
  });

  it('records a changed reading immediately even inside the gap', () => {
    const log = recordMeterSample({ 'codex-personal': [sample(NOW - MIN)] }, ledger([laneRow({ usedPct: 41 })]), NOW);
    expect(log['codex-personal']).toEqual([sample(NOW - MIN), sample(NOW, 41)]);
  });

  it('records an unchanged reading once the gap has passed', () => {
    const log = recordMeterSample({ 'codex-personal': [sample(NOW - METER_WATCH_SAMPLE_GAP_MS)] }, ledger([laneRow()]), NOW);
    expect(log['codex-personal']).toHaveLength(2);
  });

  it('drops samples older than six hours and caps the lane at 48 samples', () => {
    const stale = [sample(NOW - METER_WATCH_MAX_AGE_MS - 1), sample(NOW - MIN)];
    expect(recordMeterSample({ 'codex-personal': stale }, ledger([laneRow()]), NOW)['codex-personal']).toHaveLength(1);
    const full = Array.from({ length: METER_WATCH_MAX_SAMPLES }, (_, i) => sample(NOW - 5 * 60 * MIN + i * MIN));
    const capped = recordMeterSample({ 'codex-personal': full }, ledger([laneRow({ usedPct: 41 })]), NOW);
    expect(capped['codex-personal']).toHaveLength(METER_WATCH_MAX_SAMPLES);
    expect(capped['codex-personal']![METER_WATCH_MAX_SAMPLES - 1]).toEqual(sample(NOW, 41));
  });

  it('drops lanes that left the ledger and returns the input for a null ledger', () => {
    const log: MeterWatchLog = { gone: [sample(NOW - MIN)] };
    expect(recordMeterSample(log, ledger([laneRow()]), NOW).gone).toBeUndefined();
    expect(recordMeterSample(log, null, NOW)).toBe(log);
  });
});

describe('meterStalls', () => {
  const stalls = (log: MeterWatchLog, row: Record<string, unknown> = {}) =>
    meterStalls(log, ledger([laneRow(row)]), NOW)[0]!;

  it('is stuck when equal readings span 61 minutes while the lane runs', () => {
    const s = stalls({ 'codex-personal': [sample(NOW - 61 * MIN), sample(NOW)] });
    expect(s).toEqual({ lane: 'codex-personal', state: 'stuck', stuckMinutes: 61 });
  });

  it('is moving when usedPct moved even one point across the span', () => {
    const s = stalls({ 'codex-personal': [sample(NOW - 61 * MIN, 39), sample(NOW, 40)] });
    expect(s.state).toBe('moving');
  });

  it('is moving when creditsRemaining moved even while usedPct sat still', () => {
    const s = stalls({ 'codex-personal': [sample(NOW - 61 * MIN, null, 90), sample(NOW, null, 80)] },
      { usedPct: null, creditsRemaining: 80, window: 'credits' });
    expect(s.state).toBe('moving');
  });

  it('is moving for an idle lane and a held lane — nothing is expected to move', () => {
    const log = { 'codex-personal': [sample(NOW - 61 * MIN), sample(NOW)] };
    expect(stalls(log, { running: 0 }).state).toBe('moving');
    expect(stalls(log, { held: true }).state).toBe('moving');
  });

  it('is unknown when the span is shorter than 60 minutes', () => {
    expect(stalls({ 'codex-personal': [sample(NOW - 30 * MIN), sample(NOW)] }).state).toBe('unknown');
    expect(stalls({ 'codex-personal': [sample(NOW)] }).state).toBe('unknown');
    expect(stalls({}).state).toBe('unknown');
  });

  it('is unknown when both readings are null or the running count is missing', () => {
    const log = { 'codex-personal': [sample(NOW - 61 * MIN), sample(NOW)] };
    expect(stalls(log, { usedPct: null, creditsRemaining: null, window: 'none' }).state).toBe('unknown');
    expect(stalls(log, { running: null }).state).toBe('unknown');
    const nullLog = { 'codex-personal': [sample(NOW - 61 * MIN, null, null), sample(NOW, null, null)] };
    expect(stalls(nullLog).state).toBe('unknown');
  });

  it('ignores samples older than six hours', () => {
    const log = { 'codex-personal': [sample(NOW - 7 * 60 * MIN), sample(NOW - 30 * MIN), sample(NOW)] };
    expect(stalls(log).state).toBe('unknown');
  });

  it('is stuck when the still run alone spans the hour, even if older samples moved', () => {
    const log = {
      'codex-personal': [sample(NOW - 90 * MIN, 39), sample(NOW - 80 * MIN), sample(NOW - 10 * MIN), sample(NOW)],
    };
    const s = stalls(log);
    expect(s.state).toBe('stuck');
    expect(s.stuckMinutes).toBe(80);
  });

  it('returns one verdict per ledger lane and nothing for a null ledger', () => {
    const rows = [laneRow(), laneRow({ lane: 'claude', running: 0 })];
    const out = meterStalls({}, ledger(rows), NOW);
    expect(out.map((s) => s.lane)).toEqual(['codex-personal', 'claude']);
    expect(out.every((s) => s.stuckMinutes === null)).toBe(true);
    expect(meterStalls({}, null, NOW)).toEqual([]);
  });
});
