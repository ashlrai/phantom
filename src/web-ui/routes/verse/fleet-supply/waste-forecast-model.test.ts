import { describe, expect, it } from 'vitest';
import type { ResourceLaneRow } from '../usage/fleet-ledger-model.js';
import { wasteForecast, wasteHeadline } from './waste-forecast-model.js';

const now = Date.parse('2026-10-31T23:30:00Z');
const iso = (hours: number) => new Date(now + hours * 3_600_000).toISOString();
const lane = (overrides: Partial<ResourceLaneRow> = {}): ResourceLaneRow => ({
  lane: 'Devin', running: 0, target: 1, held: false, window: 'weekly', usedPct: 0,
  creditsRemaining: null, resetAt: iso(9), burnPctPerHour: 0, tokensPerHour6h: null,
  projectedExhaustion: null, source: null, ...overrides,
});

describe('waste forecast', () => {
  it('forecasts the weekly fixtures without inventing an unknown burn', () => {
    const devin = wasteForecast(lane(), now)!;
    const codex = wasteForecast(lane({ lane: 'codex-personal', usedPct: 62, resetAt: iso(160), burnPctPerHour: 4 }), now)!;
    const claude = wasteForecast(lane({ lane: 'claude', usedPct: 40, resetAt: iso(20), burnPctPerHour: null }), now)!;
    expect(devin).toMatchObject({ unusedPct: 100, hoursToReset: 9, burnKnown: true, tone: 'bad', text: 'Devin: 100% unused at reset (in 9 h) · needs 11.1%/h · burning 0%/h' });
    expect(devin.neededBurnPctPerHour).toBeCloseTo(11.111);
    expect(codex).toMatchObject({ unusedPct: 0, tone: 'ok', burnKnown: true });
    expect(claude).toMatchObject({ unusedPct: 60, tone: 'bad', burnKnown: false, text: expect.stringContaining('burning unknown') });
    expect(wasteForecast(lane({ lane: 'cmp', window: 'credits' }), now)).toBeNull();
    expect(wasteHeadline([devin, codex, claude])).toBe('Waste forecast: 160 points unused across 2 lanes');
  });

  it('clamps the forecast and applies tone boundaries', () => {
    expect(wasteForecast(lane({ usedPct: 110 }), now)?.unusedPct).toBe(0);
    expect(wasteForecast(lane({ usedPct: 50 }), now)?.tone).toBe('bad');
    expect(wasteForecast(lane({ usedPct: 85 }), now)?.tone).toBe('warn');
    const onTrack = wasteForecast(lane({ usedPct: 88 }), now)!;
    expect(onTrack.tone).toBe('ok');
    expect(onTrack.text).not.toContain('needs');
    expect(wasteHeadline([onTrack])).toBe('Waste forecast: on track');
  });

  it('shows held status and precise short durations', () => {
    const forecast = wasteForecast(lane({ held: true, resetAt: iso(8 + 40 / 60) }), now)!;
    expect(forecast.text).toContain('(in 8 h 40 min)');
    expect(forecast.text).toContain(' · held, nothing will burn');
  });

  it('omits lanes without a usable weekly reset or usage', () => {
    for (const overrides of [{ window: 'none' as const }, { usedPct: null }, { resetAt: null }, { resetAt: 'invalid' }, { resetAt: iso(0) }, { resetAt: iso(-1) }]) {
      expect(wasteForecast(lane(overrides), now)).toBeNull();
    }
    expect(wasteHeadline([])).toBeNull();
  });
});
