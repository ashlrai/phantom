/**
 * routes/verse/home/at-risk-model.ts: the shares and words Home's "Most at
 * risk of going unused" card draws. Pure. Everything comes from the `atRisk`
 * field of the `phm home` summary (home.v1): the share projected to expire
 * unused, the reset instant, and the reading the projection was made from
 * (used now, burn an hour). A summary from a server that does not send the
 * reading gets one "used by its reset" share instead of a guessed split.
 */
import { formatReset } from '../fleet-usage/usage-pane-model.js';
import { resetLocalTime } from '../fleet-usage/usage-board-model.js';
import { usedPercentText } from '../percent-text.js';

/** The summary's value; the reading is optional because an older server omits it. */
export interface AtRiskValue {
  resource: string; percentUnused: number; resetAt: string; reason: string;
  usedPercent?: number; burnPctPerHour?: number;
}
export type AtRiskPartKind = 'used' | 'more' | 'unused';
export interface AtRiskPart { kind: AtRiskPartKind; percent: number; words: string }
export interface AtRiskReading {
  resource: string;
  /** The share projected to expire unused, as printed: "50%". */
  figure: string;
  /** Left to right along the bar; the shares add up to 100. */
  parts: AtRiskPart[];
  /** Share of the window used once the reset arrives (used now plus the burn until then). */
  usedByReset: number;
  /** "resets in 10 h · Tue 5:00 PM", or why there is no countdown. */
  when: string;
  /** False when the reset instant is unreadable or already behind `nowMs`. */
  resetAhead: boolean;
  /** The bar read out in one sentence. */
  words: string;
}

const share = (value: number): number => Math.round(Math.max(0, Math.min(100, value)) * 10) / 10;
const known = (value: number | undefined): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;

/** Burn as written beside the bar: one decimal at most, "<0.1%" for a real burn below that. */
export function burnText(burnPctPerHour: number): string {
  const rounded = Math.round(burnPctPerHour * 10) / 10;
  return burnPctPerHour > 0 && rounded === 0 ? '<0.1%' : `${rounded}%`;
}

export function atRiskReading(risk: AtRiskValue, nowMs: number): AtRiskReading {
  const unused = share(risk.percentUnused), usedByReset = share(100 - unused);
  const parts: AtRiskPart[] = [];
  if (known(risk.usedPercent)) {
    // Used now can never draw past what the projection says is used by the reset.
    const used = Math.min(share(risk.usedPercent), usedByReset), more = share(usedByReset - used);
    parts.push({ kind: 'used', percent: used, words: `${usedPercentText(used)} used now` });
    parts.push({ kind: 'more', percent: more, words: more > 0
      ? `${usedPercentText(more)} more by its reset${known(risk.burnPctPerHour) ? ` at ${burnText(risk.burnPctPerHour)} an hour` : ''}`
      : 'nothing more at the current burn' });
  } else {
    parts.push({ kind: 'more', percent: usedByReset, words: `${usedPercentText(usedByReset)} used by its reset` });
  }
  parts.push({ kind: 'unused', percent: unused, words: `${usedPercentText(unused)} left over` });
  const at = Date.parse(risk.resetAt), clock = resetLocalTime(risk.resetAt, nowMs);
  const resetAhead = Number.isFinite(at) && at > nowMs;
  const when = !Number.isFinite(at) ? 'reset time unknown'
    : !resetAhead ? 'its reset time has passed; waiting for a new reading'
    : clock === null ? formatReset(risk.resetAt, nowMs) : `${formatReset(risk.resetAt, nowMs)} · ${clock}`;
  return { resource: risk.resource, figure: usedPercentText(unused), parts, usedByReset, when, resetAhead,
    words: parts.map(part => part.words).join(', ') };
}
