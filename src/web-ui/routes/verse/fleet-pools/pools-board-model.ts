/**
 * The Pools board's words, derived only from pools.v1 (`phm pools`): which rows are behind, the next reset, and each
 * row's labelled facts. Pure. A value the view does not hold reads "unknown" with the view's own reason, never zero.
 */
import type { PoolRow, PoolScope, PoolsViewV1 } from '../../../../core/fleet/pools-view.js';
import { elapsedWords, leadWords, type WindowPace } from '../fleet-usage/window-pace-model.js';

export type PoolFilter = 'all' | 'fast' | 'behind' | 'pace' | 'unknown';
export type PoolGroup = Exclude<PoolFilter, 'all'>;
/** `fast` is a pool that runs empty before its reset ("slow down"); `behind` would leave usage unused ("add work"). */
export const poolGroup = (row: PoolRow): PoolGroup => row.verdict === 'slow down' ? 'fast' : row.wasteRisk === 'unknown' ? 'unknown' : row.wasteRisk === 'low' ? 'pace' : 'behind';

export function poolCounts(pools: readonly PoolRow[]): Record<PoolFilter, number> {
  const counts = { all: pools.length, fast: 0, behind: 0, pace: 0, unknown: 0 };
  for (const row of pools) counts[poolGroup(row)] += 1;
  return counts;
}

export function poolsHeadline(pools: readonly PoolRow[]): string {
  const { all, fast, behind, unknown } = poolCounts(pools);
  if (all === 0) return 'No resources reported.';
  if (unknown === all) return 'No current reading for any resource. Nothing here is known to be on pace.';
  const flagged = [fast ? `${fast} too fast` : '', behind ? `${behind} behind` : ''].filter(Boolean).join(', ');
  return `${flagged || 'Nothing is behind'}${unknown ? `, ${unknown} unknown` : ''}.`;
}

/** A length of time in the two largest units that matter: "2 d 12 h", "5 h 30 min", "40 min". */
export function span(hours: number): string {
  const minutes = Math.max(1, Math.round(hours * 60));
  const days = Math.floor(minutes / 1440), rest = Math.floor(minutes % 1440 / 60), mins = minutes % 60;
  if (days) return `${days} d${rest ? ` ${rest} h` : ''}`;
  return rest ? `${rest} h${mins ? ` ${mins} min` : ''}` : `${mins} min`;
}

const HOUR_MS = 3_600_000;
const ms = (iso: string | null): number => iso === null ? NaN : Date.parse(iso);
/** Hours from the view's own clock to `iso`; null when either time is missing. Negative once it has passed. */
export const hoursUntil = (iso: string | null, view: Pick<PoolsViewV1, 'generatedAt'>): number | null => {
  const hours = (ms(iso) - ms(view.generatedAt)) / HOUR_MS;
  return Number.isFinite(hours) ? hours : null;
};

/** The soonest reset still ahead, as last reported, whatever the state of that pool's usage reading. */
export function nextReset(view: PoolsViewV1): { id: string; hours: number } | null {
  let next: { id: string; hours: number } | null = null;
  for (const row of view.pools) {
    const hours = hoursUntil(row.resetAt, view);
    if (hours !== null && hours > 0 && (next === null || hours < next.hours)) next = { id: row.id, hours };
  }
  return next;
}

/** Where the bar ends at reset if the current burn holds: used so far plus what the burn adds. */
export function projectedEndPct(row: PoolRow): number | null {
  return row.usedPct === null || row.projectedUnusedPct === null ? null : Math.max(row.usedPct, Math.round((100 - row.projectedUnusedPct) * 10) / 10);
}

/** `dry`: empty early enough that the view says slow down. `unused`: resets with usage left. `even`: used up by its reset. */
export type PoolBarEnding = 'unread' | 'unprojected' | 'dry' | 'unused' | 'even';
export interface PoolBarShares {
  /** Further share this burn uses by the reset, and the share left after it; null when nothing is projected. */
  more: number | null;
  unused: number | null;
  ending: PoolBarEnding;
  /** The bar read aloud. */
  words: string;
}

/** A card's bar as shares of the window: the row's own usage, time elapsed and projected unused share, nothing derived beyond their difference. */
export function poolBar(row: PoolRow): PoolBarShares {
  if (row.usedPct === null) return { more: null, unused: null, ending: 'unread', words: 'usage unknown' };
  const end = projectedEndPct(row);
  const words = `${row.usedPct}% used${row.elapsedPct === null ? '' : `, ${row.elapsedPct}% of the window elapsed`}`;
  if (end === null) return { more: null, unused: null, ending: 'unprojected', words };
  const round = (value: number): number => Math.round(Math.max(0, Math.min(100, value)) * 10) / 10;
  const unused = round(100 - end);
  return {
    more: round(end - row.usedPct), unused, ending: row.verdict === 'slow down' ? 'dry' : unused > 0 ? 'unused' : 'even',
    words: `${words}, ${end}% by reset at this burn${unused > 0 ? `, ${unused}% left unused` : ''}`,
  };
}

export const KIND_WORD: Readonly<Record<PoolRow['kind'], string>> = { subscription: 'weekly plan', credits: 'credit balance', unmetered: 'no usage window' };
const BASIS_WORD: Readonly<Record<NonNullable<PoolRow['burnBasis']>, string>> = { reported: 'reported', 'least-squares': 'trend of recent readings', held: 'lane is held' };
const number = new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 });
const pct = (value: number | null): string | null => value === null ? null : `${value}%`;

export interface PoolFact { label: string; value: string | null; note?: string }

/** The row's labelled readings. `value: null` is drawn as "unknown". An unmetered lane has no usage to list, only its jobs. */
export function poolFacts(row: PoolRow, view: Pick<PoolsViewV1, 'generatedAt'>, localTime: (iso: string) => string): PoolFact[] {
  const age = hoursUntil(row.asOf, view);
  const read: PoolFact = { label: 'Read', value: age === null || age > 0 ? null : -age * 60 < 1 ? 'just now' : `${span(-age)} ago`, note: row.source ?? undefined };
  const jobs: PoolFact = { label: 'Jobs', value: row.running === null ? null : `${row.running}${row.target === null ? '' : ` of ${row.target}`} running` };
  if (row.kind === 'unmetered') return [jobs];
  if (row.kind === 'credits') return [{ label: 'Balance', value: row.creditsRemaining === null ? null : `${number.format(row.creditsRemaining)} credits` }, jobs, read];
  const until = hoursUntil(row.resetAt, view);
  return [
    { label: 'Used', value: pct(row.usedPct) },
    { label: 'Left', value: pct(row.usedPct === null ? null : Math.round((100 - row.usedPct) * 10) / 10) },
    { label: 'Resets', value: until === null ? null : until > 0 ? `in ${span(until)}` : 'passed', note: row.resetAt === null || until === null ? undefined : localTime(row.resetAt) },
    { label: 'Burn', value: row.burnPctPerHour === null ? null : `${row.burnPctPerHour}%/h`, note: row.burnBasis ? `${BASIS_WORD[row.burnBasis]}${row.burnBasis === 'least-squares' ? `, ${row.burn.samples} readings over ${row.burn.window_h} h` : ''}` : undefined },
    { label: 'Unused at reset', value: pct(row.projectedUnusedPct) },
    { label: 'Empty', value: row.projectedEmptyAt !== null ? localTime(row.projectedEmptyAt) : row.burnPctPerHour === null ? null : 'not before reset' },
    jobs,
    read,
  ];
}

/** A per-model window's name: Claude reports them as `seven_day_<model>`. */
export function scopeName(id: string): string {
  const name = id.replace(/^seven_day_/, '').replaceAll('_', ' ');
  return name.charAt(0).toUpperCase() + name.slice(1);
}
/** One per-model window in words. A window whose reset has passed has no percentage to show. */
export function scopeLine(scope: PoolScope): string {
  if (scope.usedPct === null) return 'unknown: its window reset and there is no new reading';
  return `${scope.usedPct}% used, ${scope.hoursLeft === null ? 'reset unknown' : `resets in ${span(scope.hoursLeft)}`}`;
}

const WEEK_HOURS = 168;
/**
 * Where a per-model window stands in time. Only a window the provider names `seven_day_<model>` has a stated
 * length, so only that one gets a start (seven days before its reset); any other id, a missing or passed reset,
 * or a reset further off than the window is long has no pace at all (null), never a zero.
 */
export function scopePace(scope: PoolScope): WindowPace | null {
  const reset = ms(scope.resetAt);
  if (!scope.id.startsWith('seven_day_') || scope.hoursLeft === null || !(scope.hoursLeft > 0) || scope.hoursLeft > WEEK_HOURS || !Number.isFinite(reset)) return null;
  const elapsed = (WEEK_HOURS - scope.hoursLeft) / WEEK_HOURS * 100;
  return { elapsedPct: Math.round(elapsed * 10) / 10, startsAt: new Date(reset - WEEK_HOURS * HOUR_MS).toISOString(), basis: 'weekly',
    lead: scope.usedPct === null ? null : Math.round(scope.usedPct - elapsed) };
}

/** The clauses under a per-model bar: time gone and use against an even spend where the window has a start, then its reset. */
export function scopeDetail(scope: PoolScope, localTime: (iso: string) => string): string[] {
  if (scope.usedPct === null) return ['its window reset and there is no new reading'];
  const pace = scopePace(scope);
  const reset = scope.hoursLeft === null || scope.resetAt === null ? 'reset unknown' : `resets in ${span(scope.hoursLeft)} (${localTime(scope.resetAt)})`;
  return [...(pace ? [elapsedWords(pace), leadWords(pace)].filter((words): words is string => words !== null) : []), reset];
}

/** The per-model bar read aloud: the reading, then how far the window has run when that is known. */
export function scopeWords(scope: PoolScope): string {
  const pace = scopePace(scope);
  return scope.usedPct === null ? 'usage unknown' : `${scopeLine(scope)}${pace ? `, ${elapsedWords(pace)}` : ''}`;
}

/**
 * The per-model window nearest its limit, said only when it is nearer than the pool as a whole: the pool's own
 * bar would otherwise hide a model that is about to stop. Null when no model window is measured above the pool.
 */
export function tightestScope(row: Pick<PoolRow, 'usedPct' | 'scopes'>): string | null {
  let top: PoolScope | null = null;
  for (const scope of row.scopes) if (scope.usedPct !== null && (top === null || scope.usedPct > top.usedPct!)) top = scope;
  if (top === null || row.usedPct === null || top.usedPct! <= row.usedPct) return null;
  return `${scopeName(top.id)} is nearest its limit: ${top.usedPct}% used, against ${row.usedPct}% for the pool.`;
}
