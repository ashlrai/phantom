/**
 * src/web-ui/routes/verse/fleet/live-age.ts — compute a worker's live age
 * from a fleet snapshot so the Fleet section's 1 Hz tick can show progress
 * between 5 s polls without freezing the card.
 *
 * Pure function: no Date.now(), no I/O.  nowMs is injected so the function
 * can be tested deterministically.
 */

export const LIVE_AGE_TICK_MS = 1000;

/**
 * @param ageSeconds  — worker age measured by ps at snapshot time (or null).
 * @param generatedAt — ISO-8601 instant the snapshot was generated.
 * @param nowMs       — reference time (Date.now() in production; a fixed ms
 *                      value when tested).
 * @returns live age in whole seconds, or null when input is invalid.
 *
 * When the snapshot is fresh this is approximately `ageSeconds +
 * (now − generatedAt)` in seconds.  A clock that ran backwards (now before
 * generatedAt) caps at the original ageSeconds, and a stale snapshot is
 * capped at ageSeconds + 600 so a stale snapshot cannot inflate forever.
 */
export function liveAgeSeconds(
  ageSeconds: number | null,
  generatedAt: string,
  nowMs: number,
): number | null {
  if (ageSeconds === null) return null;
  const parsed = Date.parse(generatedAt);
  if (!Number.isFinite(parsed)) return null;
  const elapsedMs = nowMs - parsed;
  const elapsedSec = Math.floor(elapsedMs / 1000);
  const result = ageSeconds + Math.max(0, elapsedSec);
  return Math.min(result, ageSeconds + 600);
}
