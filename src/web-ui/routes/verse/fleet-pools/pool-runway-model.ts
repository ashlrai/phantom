/**
 * routes/verse/fleet-pools/pool-runway-model.ts — "Runway ahead" on the Pools
 * board: every plan pool and per-model window with a reset still ahead, on one
 * line of time from the view's own clock to the furthest reset, and on that
 * line where the pool runs empty when pools.v1 says it does before its reset.
 *
 * Pure, and it decides nothing: the empty time is `projectedEmptyAt`, the
 * unused share is `projectedUnusedPct`, both as `phm pools` prints them. A
 * pool with no usage or no burn reading is drawn to its reset with the words
 * "usage unknown" or "burn unknown", never as lasting. A per-model window has
 * no burn of its own in the view, so it gets a reset and its usage, nothing
 * projected. A row with no reset ahead is named beside the line with the
 * reason, never given a position.
 */
import type { PoolRow, PoolsViewV1 } from '../../../../core/fleet/pools-view.js';
import { resetTicks, type ResetTick } from '../fleet-usage/reset-timeline-model.js';
import { scopeName, span } from './pools-board-model.js';

const HOUR_MS = 3_600_000;

/**
 * `dry`: runs empty before its reset. `lasts`: reaches its reset at this burn.
 * `held`: its lane is held, so nothing is burning. `unknown`: no usage or no
 * burn reading, so nothing is projected. `window`: a per-model window.
 */
export type RunwayState = 'dry' | 'lasts' | 'held' | 'unknown' | 'window';

export interface RunwayRow {
  key: string;
  /** The pool whose card holds this row. */
  pool: string;
  /** "claude", or "Fable" for a per-model window under its pool. */
  name: string;
  scope: boolean;
  state: RunwayState;
  /** The view's own verdict is "slow down" or "fully used". A pool that runs empty a little early and is still "on pace" is drawn dry, not flagged. */
  flagged: boolean;
  resetAt: string;
  /** 0–100 along the line; the furthest reset sits at 100. */
  resetPct: number;
  /** Where it runs empty, when that is before its reset. 0 when it already has. */
  emptyPct: number | null;
  /** "in 2 d 12 h · Nov 19, 4:00 PM" */
  when: string;
  /** "empty in 1 d 9 h, then dry 1 d 3 h until reset" */
  words: string;
}

export interface OffRunway { key: string; name: string; why: string }

export interface PoolRunway {
  rows: RunwayRow[];
  off: OffRunway[];
  ticks: ResetTick[];
  /** One sentence over the line. */
  summary: string;
}

const round1 = (value: number): number => Math.round(value * 10) / 10;
const parse = (iso: string | null): number => iso === null ? NaN : Date.parse(iso);

/** Why a row has no place on the line. */
function offWhy(row: PoolRow, resetMs: number): string {
  if (row.kind === 'unmetered') return 'no usage window';
  if (row.kind === 'credits') return typeof row.daysLeft === 'number' ? `credit balance, expires in ${row.daysLeft} d` : 'credit balance, no window';
  return Number.isFinite(resetMs) ? 'its reset has passed' : 'no reset time reported';
}

/** A plan pool's state and words, from the row alone. `untilMs` is the wait to its reset. */
function projected(row: PoolRow, nowMs: number, untilMs: number): Pick<RunwayRow, 'state' | 'words'> & { emptyMs: number | null } {
  if (row.usedPct === null) return { state: 'unknown', words: 'usage unknown', emptyMs: null };
  const dry = (ms: number): string => `dry ${span(ms / HOUR_MS)} until reset`;
  if (row.usedPct >= 100) return { state: 'dry', words: `fully used, ${dry(untilMs)}`, emptyMs: 0 };
  const emptyMs = parse(row.projectedEmptyAt) - nowMs;
  if (Number.isFinite(emptyMs) && emptyMs < untilMs) {
    const wait = Math.max(0, emptyMs);
    return { state: 'dry', words: `${wait > 0 ? `empty in ${span(wait / HOUR_MS)}` : 'empty now'}, then ${dry(untilMs - wait)}`, emptyMs: wait };
  }
  const left = `${round1(100 - row.usedPct)}% left`;
  if (row.burnBasis === 'held') return { state: 'held', words: `${left}, lane held`, emptyMs: null };
  if (row.burnPctPerHour === null) return { state: 'unknown', words: `${left}, burn unknown`, emptyMs: null };
  const unused = row.projectedUnusedPct;
  return { state: 'lasts', words: unused !== null && unused > 0 ? `lasts to reset, ${unused}% unused at this burn` : 'lasts to reset', emptyMs: null };
}

function summaryOf(rows: readonly RunwayRow[]): string {
  const pools = rows.filter(row => !row.scope);
  if (pools.length === 0) return 'No plan pool has a reset ahead; only per-model windows are on the line.';
  const count = (state: RunwayState): number => pools.filter(row => row.state === state).length;
  const dry = pools.filter(row => row.state === 'dry').sort((a, b) => (a.emptyPct ?? 0) - (b.emptyPct ?? 0));
  const unknown = count('unknown'), held = count('held'), lasts = count('lasts');
  const of = (n: number): string => `${n} of ${pools.length} plan pool${pools.length === 1 ? '' : 's'}`;
  const out: string[] = [];
  if (dry.length > 0) out.push(`${of(dry.length)} ${dry.length === 1 ? 'runs' : 'run'} empty before reset${dry.length > 1 ? `, ${dry[0]!.name} first` : ''}.`);
  else if (lasts === pools.length) out.push(pools.length === 1 ? 'The plan pool lasts to its reset at this burn.' : `All ${pools.length} plan pools last to their reset at this burn.`);
  else if (lasts > 0) out.push(`${of(lasts)} ${lasts === 1 ? 'lasts' : 'last'} to reset at this burn.`);
  if (held > 0) out.push(`${held} held, burning nothing.`);
  if (unknown > 0) out.push(`${unknown} cannot be projected: no usage or burn reading.`);
  return out.join(' ');
}

/**
 * The line, or null when no pool or per-model window has a reset still ahead
 * of the view's clock (the board then draws nothing here).
 */
export function poolRunway(view: Pick<PoolsViewV1, 'generatedAt' | 'pools'>, localTime: (iso: string) => string): PoolRunway | null {
  const nowMs = Date.parse(view.generatedAt);
  if (!Number.isFinite(nowMs)) return null;
  interface Draft extends Omit<RunwayRow, 'resetPct' | 'emptyPct' | 'when'> { untilMs: number; emptyMs: number | null; order: number }
  const drafts: Draft[] = [];
  const off: OffRunway[] = [];
  for (const row of view.pools) {
    const resetMs = parse(row.resetAt);
    const untilMs = resetMs - nowMs;
    const dated = row.kind === 'subscription' && Number.isFinite(untilMs) && untilMs > 0;
    if (dated) drafts.push({ key: row.id, pool: row.id, name: row.id, scope: false, flagged: row.verdict === 'slow down' || row.verdict === 'fully used', resetAt: row.resetAt as string, untilMs, order: untilMs, ...projected(row, nowMs, untilMs) });
    else off.push({ key: row.id, name: row.id, why: offWhy(row, resetMs) });
    // Per-model windows follow their pool on the line, or stand at their own reset when the pool has no place.
    const scopes = row.scopes.map(scope => ({ scope, wait: parse(scope.resetAt) - nowMs })).sort((a, b) => a.wait - b.wait);
    for (const { scope, wait } of scopes) {
      const name = scopeName(scope.id);
      const key = `${row.id}:${scope.id}`;
      if (!(Number.isFinite(wait) && wait > 0)) { off.push({ key, name: `${row.id} ${name}`, why: Number.isFinite(wait) ? 'its reset has passed' : 'no reset time reported' }); continue; }
      drafts.push({ key, pool: row.id, name, scope: true, state: 'window', flagged: false, resetAt: scope.resetAt as string, untilMs: wait, emptyMs: null, order: dated ? untilMs : wait,
        words: scope.usedPct === null ? 'usage unknown' : `${scope.usedPct}% used` });
    }
  }
  if (drafts.length === 0) return null;
  // Soonest pool reset first; a pool's own row before its per-model windows. The sort is stable.
  drafts.sort((a, b) => a.order - b.order || a.pool.localeCompare(b.pool) || Number(a.scope) - Number(b.scope));
  const spanMs = Math.max(...drafts.map(draft => draft.untilMs));
  const rows = drafts.map(({ untilMs, emptyMs, order: _order, ...row }): RunwayRow => ({
    ...row,
    resetPct: round1(untilMs / spanMs * 100),
    emptyPct: emptyMs === null ? null : round1(emptyMs / spanMs * 100),
    when: `in ${span(untilMs / HOUR_MS)} · ${localTime(row.resetAt)}`,
  }));
  return { rows, off, ticks: resetTicks(nowMs, spanMs), summary: summaryOf(rows) };
}
