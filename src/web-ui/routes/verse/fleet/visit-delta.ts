import type { FleetRunsV1 } from '../../../../core/verse/fleet-runs-types.js';

export interface VisitMark {
  at: number;
  merged24h: number | null;
  inboxCount: number;
  workers: number;
  personalPct: number | null;
}

/** Build a VisitMark snapshot from a FleetRunsV1 payload, sampled at nowMs. */
export function markFromRuns(runs: FleetRunsV1, nowMs: number): VisitMark {
  // merged24h: sum of lanes with non-null merged24h; null when every lane is null
  const laneTotals = runs.lanes
    .map((l) => l.merged24h)
    .filter((v): v is number => v !== null);
  const merged24h = laneTotals.length === 0 ? null : laneTotals.reduce((sum, v) => sum + v, 0);

  // visit-at: parse generatedAt (ISO); fall back to nowMs when NaN
  const parsed = Date.parse(runs.generatedAt);
  const at = Number.isFinite(parsed) ? parsed : nowMs;

  return {
    at,
    merged24h,
    inboxCount: runs.inbox.length,
    workers: runs.workers.length,
    personalPct: runs.codexPersonal?.usedPct ?? null,
  };
}

/** Format the delta between two VisitMarks as a human-readable sentence. */
export function visitDelta(
  previous: VisitMark | null,
  current: VisitMark,
): string | null {
  // Null when no previous, gap < 5 min, or negative
  if (previous === null) return null;
  const diff = current.at - previous.at;
  if (diff < 5 * 60_000 || diff < 0) return null;

  // Gap formatting
  const gapMs = diff;
  const totalMinutes = Math.round(gapMs / 60_000);

  function formatGap(ms: number): string {
    const totalMins = Math.round(ms / 60_000);
    if (totalMins < 60) return `${totalMins} m`;
    const totalHours = Math.floor(totalMins / 60);
    const remainingMins = totalMins - totalHours * 60;
    if (totalHours < 24) {
      return remainingMins > 0
        ? `${totalHours} h ${remainingMins} m`
        : `${totalHours} h`;
    }
    // Day-scale: total days
    const days = Math.floor(totalHours / 24);
    const remainingHours = totalHours - days * 24;
    return remainingHours > 0
      ? `${days} d ${remainingHours} h`
      : `${days} d`;
  }

  const gap = formatGap(gapMs);
  const parts: string[] = [];

  // merged: "<n> merged" when both are numbers and current > previous
  if (
    typeof previous.merged24h === 'number' &&
    typeof current.merged24h === 'number' &&
    current.merged24h - previous.merged24h > 0
  ) {
    parts.push(`${current.merged24h - previous.merged24h} merged`);
  }

  // inbox: "<n> new interjection(s)"
  const inboxGrowth = current.inboxCount - previous.inboxCount;
  if (inboxGrowth > 0) {
    parts.push(`${inboxGrowth} new interjection${inboxGrowth !== 1 ? 's' : ''}`);
  }

  // workers: "<n> workers now"
  const workerDelta = current.workers - previous.workers;
  if (workerDelta !== 0) {
    parts.push(`${current.workers} workers now`);
  }

  // codex-personal: "codex-personal <a>% → <b>%"
  if (
    typeof previous.personalPct === 'number' &&
    typeof current.personalPct === 'number' &&
    Math.abs(current.personalPct - previous.personalPct) >= 1
  ) {
    parts.push(
      `codex-personal ${Math.round(previous.personalPct)}% → ${Math.round(current.personalPct)}%`,
    );
  }

  const body = parts.length > 0 ? parts.join(', ') : 'no change';
  return `Since you last looked (${gap}): ${body}`;
}
