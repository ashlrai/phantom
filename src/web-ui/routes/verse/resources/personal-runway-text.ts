import { runwayHours } from '../usage/codex-burn-model.js';
import { easternClock } from '../usage/fleet-ledger-model.js';

export function personalRunwayText(input: { usedPct: number | null; pacePerHour: number | null; nowMs: number }): string | null {
  const { usedPct, pacePerHour, nowMs } = input;
  if (usedPct === null || pacePerHour === null || !Number.isFinite(usedPct) || !Number.isFinite(pacePerHour) || pacePerHour <= 0 || !Number.isFinite(nowMs)) return null;
  if (usedPct >= 100) return 'out of personal Codex';
  const hours = runwayHours(usedPct, pacePerHour);
  if (hours === null || !Number.isFinite(hours)) return null;
  const pace = `${pacePerHour.toFixed(1)}%/h`;
  return hours > 48 ? `about ${Math.ceil(hours / 24)} days left at ${pace}`
    : `out near ${easternClock(nowMs + hours * 3_600_000)} at ${pace}`;
}
