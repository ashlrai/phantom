/**
 * routes/verse/fleet-supply/held-until-text.ts — the Supply pane's held-lane
 * badge: when a held lane comes back and how long that is from now, in the
 * viewer's local clock, instead of the raw server reason string.
 *
 * Pure; nowMs, locale and timeZone are injected so tests are deterministic.
 */
import { dateTimeFormat } from '../../../components/format/locale-format.js';
import { parseHeldReason } from '../fleet/held-reason.js';

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;

/** "52 min" under 90 minutes, "14 h" under 48 hours, else "3 d". */
function durationText(deltaMs: number): string {
  const minutes = Math.round(deltaMs / MINUTE_MS);
  if (minutes < 90) return `${minutes} min`;
  const hours = Math.round(deltaMs / HOUR_MS);
  if (hours < 48) return `${hours} h`;
  return `${Math.round(hours / 24)} d`;
}

function clockText(atMs: number, locale: string, timeZone: string): string {
  const day = dateTimeFormat(locale, { month: 'short', day: 'numeric', timeZone }).format(atMs);
  const time = dateTimeFormat(locale, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone }).format(atMs);
  return `${day} ${time} ET`;
}

export function heldUntilText(
  reason: string | null | undefined,
  nowMs: number,
  locale = 'en-US',
  timeZone = 'America/New_York',
): string {
  const parsed = parseHeldReason(reason);
  if (parsed === null) return 'Held';
  if (parsed.at === null) return parsed.label;
  // Durations are measured against the minute the badge prints, so "back
  // 01:22, in 14 h" never disagrees with the clock beside it.
  const atMs = Math.floor(Date.parse(parsed.at) / MINUTE_MS) * MINUTE_MS;
  if (!Number.isFinite(atMs)) return parsed.label;
  const head = parsed.label ? `${parsed.label} · ` : '';
  const clock = clockText(atMs, locale, timeZone);
  if (parsed.until) {
    return atMs > nowMs
      ? `${head}back ${clock}, in ${durationText(atMs - nowMs)}`
      : `${head}was due back ${clock}`;
  }
  return `${head}since ${clock}, ${durationText(Math.max(0, nowMs - atMs))} ago`;
}
