import type { DaemonConfig } from '../types.js';

export type DaemonFundingMode = 'legacy-usd' | 'no-paid-cash';

/** Absence preserves existing ceilings and the deliberate legacy zero pause. */
export function daemonFundingMode(daemon?: Partial<DaemonConfig> | null): DaemonFundingMode {
  const mode = daemon?.fundingMode;
  if (mode === undefined || mode === 'legacy-usd') return 'legacy-usd';
  if (mode === 'no-paid-cash') return mode;
  throw new Error('daemon.fundingMode must be legacy-usd or no-paid-cash');
}

export function noPaidCash(daemon?: Partial<DaemonConfig> | null): boolean {
  return daemonFundingMode(daemon) === 'no-paid-cash';
}

/** The USD field governs cash only in the explicitly selected new mode. */
export function daemonCashBudget(daemon: Partial<DaemonConfig> | null | undefined, fallback: number): number {
  if (noPaidCash(daemon)) return 0;
  const budget = daemon?.dailyBudgetUsd;
  return typeof budget === 'number' && Number.isFinite(budget) && budget >= 0 && budget <= Number.MAX_SAFE_INTEGER
    ? budget : fallback;
}

/** Explicit owner selection; never merge these defaults into an existing config. */
export function includedWorkFundingDefaults(): Pick<DaemonConfig, 'fundingMode' | 'dailyBudgetUsd'> {
  return { fundingMode: 'no-paid-cash', dailyBudgetUsd: 0 };
}

export function daemonFundingLabel(daemon: Partial<DaemonConfig> | null | undefined, fallback: number): string {
  return noPaidCash(daemon)
    ? 'Paid cash disabled; included work requires current account and billing proof'
    : `$${daemonCashBudget(daemon, fallback).toFixed(2)}/day secondary ceiling`;
}
