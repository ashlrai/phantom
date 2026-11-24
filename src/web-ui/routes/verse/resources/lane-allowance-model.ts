/**
 * routes/verse/resources/lane-allowance-model.ts: what one Lane allowances card may draw and say. Pure; `now` is
 * passed in. The row is `GET /api/usage/lanes` (core/usage/lane-allowance.ts, the same read as
 * `phm usage history --lane`), and every share on the bar comes from it:
 *
 *   used     the measured share of the allowance.
 *   unused   the router's own projection for this window (`projectedUnusedPct`), which core only passes on when
 *            the posture receipt matches the reading's account, model, window start and reset.
 *   more     what is left between the two: on course to be used by the reset.
 *   dry      the measured burn reaches the limit before the reset (`history.exhaustAt`), counted only when the
 *            history describes the same reset as the reading.
 *   elapsed  the share of the window's time gone, only when the reading reports where its window began.
 *
 * A stale reading, an unknown reset or a reset that has passed draws the last measured share and projects
 * nothing. No usable reading draws no share at all, so the bar is hatched: unknown is never 0%.
 */
import type { LaneAllowanceRow } from '../../../../core/usage/lane-allowance.js';
import { RESOURCE_LIVE_STALE_MS } from '../../../../core/usage/resource-live/types.js';
import { elapsedWords, leadWords } from '../fleet-usage/window-pace-model.js';

export interface LaneReading {
  /** The observation is dated after `now`: nothing on it is believed. */
  invalid: boolean;
  ageMinutes: number | null;
  stale: boolean;
  hasUsage: boolean;
}

export function laneReading(row: LaneAllowanceRow, now: number): LaneReading {
  const observed = row.measuredAt ? Date.parse(row.measuredAt) : NaN;
  const invalid = row.freshness === 'invalid-future' || (row.measuredAt !== null && (!Number.isFinite(observed) || observed > now));
  const ageMinutes = !invalid && Number.isFinite(observed) ? Math.floor((now - observed) / 60_000) : null;
  const stale = !invalid && (row.freshness === 'stale' || now - observed > RESOURCE_LIVE_STALE_MS);
  return { invalid, ageMinutes, stale, hasUsage: !invalid && ageMinutes !== null && row.used !== null && row.limit !== null && row.usedPct !== null };
}

/** `unknown` no usable reading · `last` a share with nothing projected · `open` current, nothing projected. */
export type AllowanceEnding = 'unknown' | 'last' | 'open' | 'spent' | 'dry' | 'unused' | 'level';

export interface AllowanceBar {
  used: number | null;
  more: number | null;
  unused: number | null;
  elapsed: number | null;
  ending: AllowanceEnding;
  /** How the window ends, as a clause with no full stop; null when nothing is projected. */
  end: string | null;
  /** Time gone and where use sits against an even spend; null without a reported window start. */
  pace: string | null;
  lead: 'behind' | 'ahead' | 'level' | null;
  /** The whole bar in words, for the meter's value text. */
  words: string;
}

const clamp = (value: number): number => Math.max(0, Math.min(100, value));
const instant = (iso: string | null | undefined): number => iso ? Date.parse(iso) : NaN;

export function allowanceBar(row: LaneAllowanceRow, reading: LaneReading, now: number, localTime: (iso: string) => string): AllowanceBar {
  const none = { more: null, unused: null, elapsed: null, end: null, pace: null, lead: null };
  if (!reading.hasUsage) return { ...none, used: null, ending: 'unknown', words: 'usage unknown' };
  const used = clamp(row.usedPct!);
  const usedWords = `${Math.round(used)}% used`;
  const reset = instant(row.resetAt);
  if (reading.stale || !Number.isFinite(reset) || reset <= now) {
    const why = reading.stale ? 'last reading, now stale' : Number.isFinite(reset) ? 'its recorded reset has passed' : 'reset unknown';
    return { ...none, used, ending: 'last', words: `${usedWords}; ${why}` };
  }

  let ending: AllowanceEnding = 'open', more: number | null = null, unused: number | null = null, end: string | null = null;
  const history = row.history;
  const exhaust = history?.burn && instant(history.resetAt) === reset ? instant(history.exhaustAt) : NaN;
  if (used >= 100) {
    ending = 'spent'; end = 'All of it is used until the reset';
  } else if (Number.isFinite(exhaust) && exhaust > now && exhaust < reset) {
    ending = 'dry'; more = 100 - used; end = `Runs out about ${localTime(history!.exhaustAt!)}, before the reset, at the measured burn`;
  } else if (row.posture !== 'unknown' && row.projectedUnusedPct !== null && Number.isFinite(row.projectedUnusedPct)) {
    const projected = Math.round(clamp(row.projectedUnusedPct));
    if (projected < 1) { ending = 'level'; more = 100 - used; end = 'On course to be used by the reset, by the router’s projection'; }
    else {
      ending = 'unused'; unused = Math.min(clamp(row.projectedUnusedPct), 100 - used); more = 100 - used - unused;
      end = `About ${projected}% would go unused at the reset, by the router’s projection`;
    }
  }

  const start = instant(row.windowStart);
  let elapsed: number | null = null, pace: string | null = null, lead: AllowanceBar['lead'] = null;
  if (Number.isFinite(start) && start < reset && start <= now) {
    elapsed = Math.round((now - start) / (reset - start) * 1000) / 10;
    const points = Math.round(used - elapsed);
    const timed = { elapsedPct: elapsed, startsAt: row.windowStart!, basis: 'reported' as const, lead: ending === 'spent' ? null : points };
    const against = leadWords(timed);
    pace = `${elapsedWords(timed)}${against ? `; ${against}` : ''}`;
    lead = against === null ? null : points < 0 ? 'behind' : points > 0 ? 'ahead' : 'level';
  }
  return { used, more, unused, elapsed, ending, end, pace, lead, words: [usedWords, end, pace].filter(Boolean).join('. ') };
}

/** True once a bar draws more than the share used, so the key under the heading has something to explain. */
export const barNeedsKey = (bar: AllowanceBar): boolean => bar.more !== null || bar.unused !== null || bar.elapsed !== null;
