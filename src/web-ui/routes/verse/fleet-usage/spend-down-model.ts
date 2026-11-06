/**
 * routes/verse/fleet-usage/spend-down-model.ts — which measured windows will
 * reset with usage still unspent.
 *
 * Pure and deterministic: `nowMs` is passed in. There is no burn rate in the
 * accounts payload, so nothing is projected — only the measured share left
 * and the time to the provider's reset are reported.
 */
import type { UsageRow } from './usage-pane-model.js';

/** A window resetting within this many hours is close enough to act on. */
export const WASTE_RISK_MAX_HOURS_TO_RESET = 48;
/** ...and is only worth flagging when at least this share of it is still unspent. */
export const WASTE_RISK_MIN_LEFT_PERCENT = 30;

const HOUR_MS = 60 * 60 * 1000;

export interface SpendDownItem {
  accountId: string;
  accountLabel: string;
  windowLabel: string;
  /** 0–100, measured share of the window not yet used. */
  leftPercent: number;
  resetsAt: string;
  hoursToReset: number;
  level: 'waste-risk' | 'on-track';
}

/** Measured, future-resetting windows of observed accounts; waste-risk first, then soonest reset. */
export function spendDown(rows: UsageRow[], nowMs: number): SpendDownItem[] {
  const items: SpendDownItem[] = [];
  for (const row of rows) {
    if (row.state !== 'observed') continue;
    for (const w of row.windows) {
      if (!w.measured || typeof w.usedPercent !== 'number' || !Number.isFinite(w.usedPercent) || !w.resetsAt) continue;
      const at = Date.parse(w.resetsAt);
      if (!Number.isFinite(at) || at <= nowMs) continue;
      const leftPercent = Math.min(100, Math.max(0, 100 - w.usedPercent));
      const hoursToReset = (at - nowMs) / HOUR_MS;
      items.push({
        accountId: row.id,
        accountLabel: row.label,
        windowLabel: w.label,
        leftPercent,
        resetsAt: w.resetsAt,
        hoursToReset,
        level: hoursToReset <= WASTE_RISK_MAX_HOURS_TO_RESET && leftPercent >= WASTE_RISK_MIN_LEFT_PERCENT ? 'waste-risk' : 'on-track',
      });
    }
  }
  return items.sort((a, b) =>
    Number(b.level === 'waste-risk') - Number(a.level === 'waste-risk')
    || a.hoursToReset - b.hoursToReset
    || `${a.accountLabel} ${a.windowLabel}`.localeCompare(`${b.accountLabel} ${b.windowLabel}`));
}
