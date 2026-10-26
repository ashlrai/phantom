/**
 * Read-only view of the daemon's daily budget for fleet status: the cap the
 * daemon enforces (cfg.daemon.dailyBudgetUsd, else the $1/day default, with an
 * explicit 0 meaning stopped) against the spend its state file records for the
 * current UTC budget day. Uses only data Phantom already keeps; an unreadable
 * state file makes spend unknown (null), never zero.
 */
import type { AshlrConfig } from '../types.js';
import type { LoadDaemonStateStrictResult } from '../daemon/state.js';

/** Mirrors the daemon loop's default cap (src/core/daemon/loop.ts DEFAULTS). */
export const DEFAULT_DAILY_BUDGET_USD = 1;

export interface FleetBudget {
  /** UTC budget day (YYYY-MM-DD) the spend applies to. */
  day: string;
  dailyBudgetUsd: number;
  budgetSource: 'config' | 'default';
  /** Estimated spend recorded for `day`; null when the daemon state is unreadable. */
  spentTodayUsd: number | null;
  remainingUsd: number | null;
  /** The paid daily cap is reached (or budget 0 = stopped); zero-dollar producers may still run. */
  capReached: boolean | null;
  reasons: string[];
}

export function fleetBudget(cfg: AshlrConfig, state: LoadDaemonStateStrictResult, now: Date = new Date()): FleetBudget {
  const day = now.toISOString().slice(0, 10);
  const raw = cfg.daemon?.dailyBudgetUsd;
  const configured = typeof raw === 'number' && Number.isFinite(raw) && raw >= 0 && raw <= Number.MAX_SAFE_INTEGER;
  const dailyBudgetUsd = configured ? raw : DEFAULT_DAILY_BUDGET_USD;
  const reasons: string[] = [];
  if (dailyBudgetUsd === 0) reasons.push('budget-zero-stopped');
  if (!state.ok) {
    reasons.push(`daemon-state-${state.reason}`);
    return { day, dailyBudgetUsd, budgetSource: configured ? 'config' : 'default', spentTodayUsd: null, remainingUsd: null,
      capReached: dailyBudgetUsd === 0 ? true : null, reasons };
  }
  const s = state.state;
  // A state file from an earlier day has rolled over: nothing is charged to today yet.
  const spentTodayUsd = s.todayDate === day ? s.todaySpentUsd : 0;
  const pessimistic = s.todayDate === day && s.spendGuardAccounting?.budgetDay === day && s.spendGuardAccounting.budgetExhausted === true;
  if (pessimistic) reasons.push('unknown-exposure-closes-day');
  return {
    day, dailyBudgetUsd, budgetSource: configured ? 'config' : 'default', spentTodayUsd,
    remainingUsd: pessimistic ? 0 : Math.max(0, Math.round((dailyBudgetUsd - spentTodayUsd) * 1e6) / 1e6),
    capReached: dailyBudgetUsd === 0 || pessimistic || spentTodayUsd >= dailyBudgetUsd,
    reasons,
  };
}
