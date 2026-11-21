/**
 * One lane's usage window as the shares the shared WindowBar draws: used so far, what the measured burn adds
 * by the reset, and what is left unused then.
 *
 * Every share comes from the lane's own fresh readings. The share used needs the amount used and something to
 * divide it by (the limit, or 100 for a percent unit). The projection is the usage sensor's own sum (used plus
 * burn times the hours left), and is drawn only when the sensor also gave its verdict, so the bar never says
 * more than the lane's forecast does. Anything missing leaves that part of the bar out; it is never a zero.
 */

/** How the window ends. `open` is a share with nothing projected; `unread` is no share at all. */
export type LaneEnding = 'dry' | 'meets' | 'unused' | 'spent' | 'open' | 'unread';

export interface LaneBar {
  /** Share used so far, 0 to 100; null when there is no reading of it. */
  used: number | null;
  /** Further share the measured burn uses by the reset; null when nothing is projected. */
  more: number | null;
  /** Share left unused at the reset; null when nothing is projected. */
  unused: number | null;
  ending: LaneEnding;
  /** The share used as the row's figure ("42%"); null when there is none. */
  figure: string | null;
  /** How the window ends, in a few words, for the line under the bar. */
  note: string;
  /** The whole bar in words, for the meter. */
  text: string;
}

export interface LaneBarInput {
  used: number | null;
  limit: number | null;
  unit: string | null;
  /** Usage units per hour. */
  burn: number | null;
  resetAt: string | null;
  verdict: 'early' | 'on-pace' | 'underuse' | 'unknown';
  nowMs: number;
}

const tenth = (value: number): number => Math.round(value * 10) / 10;

function percentText(share: number): string {
  if (share > 0 && share < 1) return 'under 1%';
  return `${Math.round(share)}%`;
}

function unread(note: string): LaneBar {
  return { used: null, more: null, unused: null, ending: 'unread', figure: null, note, text: note };
}

export function laneBar({ used, limit, unit, burn, resetAt, verdict, nowMs }: LaneBarInput): LaneBar {
  if (used === null) return unread('no usage reading');
  const whole = limit !== null && limit > 0 ? limit : unit === 'percent' ? 100 : null;
  if (whole === null) return unread('no limit recorded, so no share');
  const share = tenth(Math.max(0, Math.min(100, (used / whole) * 100)));
  const figure = percentText(share);
  if (share >= 100) return { used: 100, more: null, unused: null, ending: 'spent', figure, note: 'all used', text: 'all of it used' };
  const reset = resetAt ? Date.parse(resetAt) : NaN;
  const hours = (reset - nowMs) / 3_600_000;
  if (verdict === 'unknown' || burn === null || burn < 0 || !(hours > 0)) {
    return { used: share, more: null, unused: null, ending: 'open', figure, note: 'not projected', text: `${figure} used; nothing projected` };
  }
  const rest = 100 - share;
  if (verdict === 'early') {
    return { used: share, more: tenth(rest), unused: 0, ending: 'dry', figure, note: 'runs out before the reset',
      text: `${figure} used; at the measured burn the rest runs out before the reset` };
  }
  const more = tenth(Math.min(rest, (burn * hours / whole) * 100));
  const unused = tenth(rest - more);
  if (verdict === 'on-pace') {
    return { used: share, more, unused, ending: 'meets', figure, note: 'used up at about the reset',
      text: `${figure} used; at the measured burn the rest is used up at about the reset` };
  }
  const left = percentText(unused);
  return { used: share, more, unused, ending: 'unused', figure, note: `${left} left unused at the reset`,
    text: `${figure} used; ${percentText(more)} more by the reset at the measured burn; ${left} left unused` };
}

export function sameLaneBar(left: LaneBar, right: LaneBar): boolean {
  return left.used === right.used && left.more === right.more && left.unused === right.unused
    && left.ending === right.ending && left.figure === right.figure && left.note === right.note && left.text === right.text;
}
