/**
 * routes/verse/fleet-usage/reset-timeline-model.ts — every reset the Usage
 * board holds, placed on one line of time from now to the furthest of them.
 *
 * Pure: `nowMs` is passed in. A window joins the line only when its provider
 * gave the reset as an instant that is still ahead; a window with a sentence
 * instead (Claude), with no reset at all, or with one that has passed is
 * listed beside the line with the reason, never given a position. Usage is
 * the reading the account row already carries: a flagged limit is the flag,
 * an unmeasured window is "usage unknown", never 0%.
 */
import type { AccountProvider } from '../usage/usage-contract.js';
import { usedPercentText } from '../percent-text.js';
import { resetLocalTime } from './usage-board-model.js';
import { formatReset, type CodexPersonalRow, type UsageRow, type UsageWindowRow } from './usage-pane-model.js';

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
/** Below this span the scale is hours from now; above it, local midnights. */
const DAY_SCALE_FROM_MS = 36 * HOUR_MS;
const MAX_TICKS = 8;

export interface ResetMark {
  key: string;
  provider: AccountProvider;
  /** "Codex Team · Primary" */
  name: string;
  resetsAt: string;
  /** 0–100 along the line; the furthest reset sits at 100. */
  leftPct: number;
  /** "in 3 h 30 m · Thu 4:00 PM" */
  when: string;
  /** "32% used", "limit reached" or "usage unknown". */
  usage: string;
  /** The provider flagged this window as rate-limited. */
  limit: boolean;
}

export interface UndatedReset { key: string; name: string; why: string }
export interface ResetTick { leftPct: number; label: string }

export interface ResetTimeline {
  marks: ResetMark[];
  undated: UndatedReset[];
  ticks: ResetTick[];
  /** One sentence over the line. */
  summary: string;
}

const usageWords = (w: Pick<UsageWindowRow, 'limitReached' | 'measured' | 'usedPercent'>): string =>
  w.limitReached ? 'limit reached' : w.measured && w.usedPercent !== null ? `${usedPercentText(w.usedPercent)} used` : 'usage unknown';

const round1 = (value: number): number => Math.round(value * 10) / 10;

/** Hours from now on a short line, local midnights on a long one; never more than MAX_TICKS. */
export function resetTicks(nowMs: number, spanMs: number): ResetTick[] {
  if (spanMs <= 0) return [];
  if (spanMs < DAY_SCALE_FROM_MS) {
    const hours = spanMs / HOUR_MS;
    const step = [1, 2, 3, 6, 12].find((size) => hours / size <= MAX_TICKS) ?? 12;
    const ticks: ResetTick[] = [];
    for (let h = step; h * HOUR_MS < spanMs; h += step) ticks.push({ leftPct: round1(h * HOUR_MS / spanMs * 100), label: `+${h} h` });
    return ticks;
  }
  const midnights: number[] = [];
  const day = new Date(nowMs);
  day.setHours(24, 0, 0, 0);
  while (day.getTime() < nowMs + spanMs && midnights.length < 400) {
    midnights.push(day.getTime());
    day.setDate(day.getDate() + 1);
  }
  const every = Math.max(1, Math.ceil(midnights.length / MAX_TICKS));
  // A weekday names a day only inside one week; past that the date does.
  const format: Intl.DateTimeFormatOptions = spanMs < 7 * DAY_MS ? { weekday: 'short' } : { month: 'short', day: 'numeric' };
  return midnights
    .filter((_, index) => index % every === 0)
    .map((at) => ({ leftPct: round1((at - nowMs) / spanMs * 100), label: new Date(at).toLocaleDateString(undefined, format) }));
}

/**
 * The line, or null when no window gave a reset instant still ahead (the
 * board then keeps its one sentence saying so and draws nothing).
 */
export function resetTimeline(rows: readonly UsageRow[], personal: CodexPersonalRow | null, nowMs: number): ResetTimeline | null {
  interface Entry { key: string; provider: AccountProvider; name: string; window: UsageWindowRow }
  const entries: Entry[] = [];
  for (const row of rows) {
    if (row.state !== 'observed') continue;
    row.windows.forEach((window, index) => {
      entries.push({ key: `${row.id}:${index}`, provider: row.provider, name: `${row.label} · ${window.label}`, window });
    });
  }
  if (personal !== null) {
    entries.push({
      key: 'fleet:codex-personal', provider: 'codex', name: 'Codex personal · fleet reading',
      window: {
        label: 'personal', usedPercent: personal.usedPct, resetsAt: personal.resetsAt, resetDescription: null,
        limitReached: false, measured: personal.usedPct !== null,
      },
    });
  }

  const dated: (Entry & { at: number })[] = [];
  const undated: UndatedReset[] = [];
  for (const entry of entries) {
    const { resetsAt, resetDescription } = entry.window;
    const at = resetsAt === null ? NaN : Date.parse(resetsAt);
    if (Number.isFinite(at) && at > nowMs) dated.push({ ...entry, at });
    else {
      undated.push({
        key: entry.key, name: entry.name,
        why: resetDescription ?? (Number.isFinite(at) ? 'its reset time has passed' : 'no reset time given'),
      });
    }
  }
  if (dated.length === 0) return null;
  dated.sort((a, b) => a.at - b.at || a.name.localeCompare(b.name));

  const furthest = dated[dated.length - 1];
  const spanMs = furthest.at - nowMs;
  const marks = dated.map((entry): ResetMark => {
    const iso = entry.window.resetsAt as string;
    const clock = resetLocalTime(iso, nowMs);
    const countdown = formatReset(iso, nowMs).replace(/^resets /, '');
    return {
      key: entry.key, provider: entry.provider, name: entry.name, resetsAt: iso,
      leftPct: round1((entry.at - nowMs) / spanMs * 100),
      when: clock === null ? countdown : `${countdown} · ${clock}`,
      usage: usageWords(entry.window),
      limit: entry.window.limitReached,
    };
  });

  const last = formatReset(furthest.window.resetsAt, nowMs).replace(/^resets /, '');
  const limited = marks.filter((mark) => mark.limit).length;
  const summary = [
    marks.length === 1 ? `1 window resets ${last}` : `${marks.length} windows reset, the last ${last}`,
    limited > 0 ? `${limited} flagged at a limit until ${limited === 1 ? 'its' : 'their'} reset` : '',
    undated.length > 0 ? `${undated.length} gave no time to place` : '',
  ].filter(Boolean).join('; ');

  return { marks, undated, ticks: resetTicks(nowMs, spanMs), summary: `${summary}.` };
}
