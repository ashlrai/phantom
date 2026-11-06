import { describe, expect, it } from 'vitest';
import { suggestedTarget, type WasteForecast } from './waste-forecast-model.js';

const forecast: WasteForecast = {
  lane: 'codex-personal', unusedPct: 16, hoursToReset: 8, burnKnown: true,
  neededBurnPctPerHour: 4, tone: 'warn', text: '',
};
const lane = { running: 2, target: 2, held: false };

describe('suggestedTarget', () => {
  it('splits the observed burn across workers and rounds up', () => {
    expect(suggestedTarget(forecast, lane, 2)).toEqual({ target: 4, perWorkerPctPerHour: 1 });
    expect(suggestedTarget({ ...forecast, neededBurnPctPerHour: 4.1 }, lane, 2)?.target).toBe(5);
    // 40 percentage points remaining in eight hours requires 5 workers, not 4.
    expect(suggestedTarget({ ...forecast, neededBurnPctPerHour: 5 }, lane, 2)?.target).toBe(5);
  });

  it('does not suggest a target without a usable at-risk, unheld lane', () => {
    expect(suggestedTarget({ ...forecast, burnKnown: false }, lane, 2)).toBeNull();
    expect(suggestedTarget(forecast, lane, null)).toBeNull();
    expect(suggestedTarget(forecast, { ...lane, running: 0 }, 2)).toBeNull();
    expect(suggestedTarget({ ...forecast, tone: 'ok' }, lane, 2)).toBeNull();
    expect(suggestedTarget(forecast, { ...lane, held: true }, 2)).toBeNull();
    expect(suggestedTarget(forecast, { ...lane, target: 4 }, 2)).toBeNull();
    expect(suggestedTarget(forecast, { ...lane, target: 8 }, 2)).toBeNull();
    expect(suggestedTarget(forecast, { ...lane, target: 65 }, 2)).toBeNull();
  });

  it('caps suggestions at 64', () => {
    expect(suggestedTarget({ ...forecast, neededBurnPctPerHour: 100 }, lane, 2)?.target).toBe(64);
    expect(suggestedTarget(forecast, lane, 0)?.target).toBe(64);
  });
});
