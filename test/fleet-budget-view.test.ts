import { describe, expect, it } from 'vitest';
import { DEFAULT_DAILY_BUDGET_USD, fleetBudget } from '../src/core/fleet/budget-view.js';
import type { LoadDaemonStateStrictResult } from '../src/core/daemon/state.js';
import type { AshlrConfig, DaemonState } from '../src/core/types.js';

const now = new Date('2026-10-15T12:00:00.000Z');
const config = (dailyBudgetUsd: number): AshlrConfig =>
  ({ daemon: { dailyBudgetUsd } } as AshlrConfig);
const state = (todaySpentUsd: number): LoadDaemonStateStrictResult => ({
  ok: true,
  fresh: false,
  state: { todayDate: '2026-10-15', todaySpentUsd } as DaemonState,
});

describe('fleetBudget', () => {
  it('uses the default when no budget is configured', () => {
    expect(fleetBudget({} as AshlrConfig, state(0), now)).toMatchObject({
      dailyBudgetUsd: DEFAULT_DAILY_BUDGET_USD,
      budgetSource: 'default',
    });
  });

  it('uses the configured budget', () => {
    expect(fleetBudget(config(5), state(0), now)).toMatchObject({
      day: '2026-10-15', dailyBudgetUsd: 5, budgetSource: 'config',
    });
  });

  it('reports remaining funds when spend is under budget', () => {
    expect(fleetBudget(config(5), state(1.25), now)).toMatchObject({
      spentTodayUsd: 1.25, remainingUsd: 3.75, capReached: false, reasons: [],
    });
  });

  it('clamps remaining funds to zero when spend is over budget', () => {
    expect(fleetBudget(config(5), state(6), now)).toMatchObject({
      spentTodayUsd: 6, remainingUsd: 0, capReached: true, reasons: [],
    });
  });

  it('reports the full budget remaining when there is no spend', () => {
    expect(fleetBudget(config(5), state(0), now)).toMatchObject({
      spentTodayUsd: 0, remainingUsd: 5, capReached: false, reasons: [],
    });
  });
});
