const MINUTE_MS = 60_000;
const HOUR_MIN = 60;
const DAY_MIN = 24 * HOUR_MIN;

/**
 * One consistent phrase for when a provider's usage window resets.
 * The remaining time is rounded up to whole minutes first, then the unit is
 * chosen from that rounded value, so a 59m30s remainder reads "resets in 1h"
 * rather than "resets in 60m".
 */
export function resetCountdown(resetAt: string | null | undefined, nowMs: number): string {
  const resetMs = resetAt ? Date.parse(resetAt) : Number.NaN;
  if (Number.isNaN(resetMs)) return 'reset unknown';

  const remainingMs = resetMs - nowMs;
  if (remainingMs <= 0) return 'reset passed';

  // Positive input, so ceil is always at least 1: the "minimum 1m" floor holds.
  const totalMin = Math.ceil(remainingMs / MINUTE_MS);

  if (totalMin < HOUR_MIN) return `resets in ${totalMin}m`;

  if (totalMin < 2 * DAY_MIN) {
    const hours = Math.floor(totalMin / HOUR_MIN);
    const minutes = totalMin % HOUR_MIN;
    return minutes === 0 ? `resets in ${hours}h` : `resets in ${hours}h ${minutes}m`;
  }

  const days = Math.floor(totalMin / DAY_MIN);
  const hours = Math.floor((totalMin % DAY_MIN) / HOUR_MIN);
  return hours === 0 ? `resets in ${days}d` : `resets in ${days}d ${hours}h`;
}
