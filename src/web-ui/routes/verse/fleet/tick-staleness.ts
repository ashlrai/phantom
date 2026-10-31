/**
 * src/web-ui/routes/verse/fleet/tick-staleness.ts — classify how stale
 * the orchestrator tick is, so fleet views share one precise helper
 * instead of ad-hoc "tick N s ago" logic.
 *
 * Pure function: no imports, no Date.now(), no external state.  nowMs
 * is injected so the function can be tested deterministically.
 */

export type TickStaleness = {
  level: 'fresh' | 'late' | 'stale' | 'unknown';
  ageSeconds: number | null;
  text: string;
};

/**
 * Classify how long ago `lastTick` occurred relative to `nowMs`.
 *
 * @param lastTick — ISO-8601 instant from the orchestrator, or null.
 * @param nowMs    — arbitrary reference timestamp (Date.now() when
 *                   consumed; a fixed ms value when tested).
 */
export function tickStaleness(
  lastTick: string | null,
  nowMs: number,
): TickStaleness {
  /* ---------- unknown path ---------- */
  if (!lastTick) {
    return { level: 'unknown', ageSeconds: null, text: 'tick unknown' };
  }

  const tickMs = Date.parse(lastTick);
  if (!Number.isFinite(tickMs)) {
    return { level: 'unknown', ageSeconds: null, text: 'tick unknown' };
  }

  const diffMs = nowMs - tickMs;

  /* Future tick — small skew (≤ 60 s) is treated as 0 age. */
  if (diffMs < -60_000) {
    return { level: 'unknown', ageSeconds: null, text: 'tick unknown' };
  }

  /* ---------- age in seconds (integer, ≥ 0) ---------- */
  const ageSeconds = Math.max(0, Math.round(diffMs / 1000));

  /* ---------- staleness level ---------- */
  let level: TickStaleness['level'];
  if (ageSeconds < 5 * 60) {
    /* under 5 minutes */
    level = 'fresh';
  } else if (ageSeconds < 20 * 60) {
    /* 5 minutes up to 20 minutes */
    level = 'late';
  } else {
    /* 20 minutes or more */
    level = 'stale';
  }

  /* ---------- text ---------- */
  const text = formatStalenessText(ageSeconds);

  return { level, ageSeconds, text };
}

/** Format age-seconds into the user-facing "tick … ago" text. */
function formatStalenessText(ageSeconds: number): string {
  if (ageSeconds < 60) {
    return `tick ${ageSeconds} s ago`;
  }

  const totalMinutes = Math.floor(ageSeconds / 60);
  if (totalMinutes < 60) {
    return `tick ${totalMinutes} min ago`;
  }

  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `tick ${hours} h ${String(minutes).padStart(2, '0')} min ago`;
}
