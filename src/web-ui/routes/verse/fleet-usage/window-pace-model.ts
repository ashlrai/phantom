/**
 * routes/verse/fleet-usage/window-pace-model.ts: where a usage window stands in time. The accounts read gives
 * some windows a start (usage-contract WindowPeriod: the provider's own billing period, or seven days before a
 * reset the server qualified as weekly). With a start and a reset, the share of the window's time already gone
 * is plain arithmetic, and so is how far the measured use sits from an even spend. Nothing is projected: there
 * is no burn rate in this read. Pure; `nowMs` is passed in. A window with no known start, or one whose reset
 * has passed, has no pace at all (null), never a zero.
 */
import type { UsageWindowRow } from './usage-pane-model.js';

export interface WindowPace {
  /** Share of the window's time already gone, 0 to 100, one decimal. */
  elapsedPct: number;
  startsAt: string;
  basis: 'reported' | 'weekly';
  /** Measured use minus time gone, in whole points: negative is behind an even spend. Null without a measured reading. */
  lead: number | null;
}

type PaceWindow = Pick<UsageWindowRow, 'usedPercent' | 'resetsAt' | 'limitReached' | 'measured' | 'period'>;

export function windowPace(window: PaceWindow, nowMs: number): WindowPace | null {
  const period = window.period ?? null;
  if (period === null || window.resetsAt === null) return null;
  const start = Date.parse(period.startsAt), end = Date.parse(window.resetsAt);
  // Before its start or after its reset the reading describes another window.
  if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end || nowMs < start || nowMs >= end) return null;
  const elapsed = (nowMs - start) / (end - start) * 100;
  const used = window.measured && !window.limitReached && typeof window.usedPercent === 'number' && Number.isFinite(window.usedPercent)
    ? Math.max(0, Math.min(100, window.usedPercent)) : null;
  return { elapsedPct: Math.round(elapsed * 10) / 10, startsAt: period.startsAt, basis: period.basis, lead: used === null ? null : Math.round(used - elapsed) };
}

/** "71% of the window gone", the clause the meter's value text and the line under it share. */
export const elapsedWords = (pace: WindowPace): string => `${Math.round(pace.elapsedPct)}% of the window gone`;

/** Use against an even spend, in words; null when there is no measured use to compare. */
export function leadWords(pace: WindowPace): string | null {
  if (pace.lead === null) return null;
  if (pace.lead === 0) return 'use is level with an even spend';
  const points = Math.abs(pace.lead);
  return `use is ${points} ${points === 1 ? 'point' : 'points'} ${pace.lead < 0 ? 'behind' : 'ahead of'} an even spend`;
}

/** Where the start came from, so a derived start is never read as a reported one. */
export const startWords = (pace: WindowPace, localTime: (iso: string) => string): string =>
  pace.basis === 'reported' ? `began ${localTime(pace.startsAt)}, as the provider reported` : `began about ${localTime(pace.startsAt)}, seven days before its reset`;
