/**
 * routes/verse/resources/usage-pace-model.ts: the Resources drawer's "Usage pace" section as rows. One read,
 * GET /api/verse/usage-resources, carries the scheduler's pace snapshot (core/usage/pace.ts): `shares`, the
 * same fleet.pools.v1 view `phm fleet pools --json` prints (which pool takes the next job and what share of
 * new work each should get), and `pools`, the pacer's own forecast and suggested running slots.
 *
 * Pure; `nowMs` is passed in. Nothing is derived beyond differences of the numbers a row holds: used so far,
 * the further share its burn uses by the reset, and what is left. A report older than two minutes, a row the
 * read does not hold, or a number that is missing reads "unknown" with the reason, never zero.
 */
import { ageInSeconds } from '../../../lib/relative-time.js';
import { POOL_SHARE_STATES, poolLabel, type PoolShareState } from '../../../../core/usage/runway.js';
import { paceForecastText } from './usage-pace-text.js';

/** The scheduler ticks every few seconds; older than this the report describes another moment. */
export const PACE_FRESH_MS = 120_000;
/** The fixed pools every scheduler budgets; one this read omits still gets a row, as unknown. */
const CORE_POOLS: readonly string[] = ['zai', 'gemini', 'claude', 'codex-personal'];

export type PaceEnding = 'unread' | 'unprojected' | 'dry' | 'unused' | 'even';

export interface PaceRowView {
  pool: string;
  name: string;
  state: PoolShareState;
  /** The verdict in two or three words, for the badge. */
  verdict: string;
  /** The row's reading: its share of new work. */
  figure: string;
  /** Share of new ordinary work, 0 to 100; null when unknown. */
  sharePct: number | null;
  used: number | null;
  more: number | null;
  unused: number | null;
  ending: PaceEnding;
  /** The bar read aloud. */
  valueText: string;
  facts: string[];
  /** Identity colour slot, fixed by the pool's name so it does not move when the ranking does. */
  slot: number;
}

export interface PaceSplitPart { pool: string; name: string; pct: number; slot: number }

export interface PaceView {
  /** `live`: a report from the last two minutes. `stale`: an older one. `none`: no report in the read. */
  state: 'live' | 'stale' | 'none';
  asOf: string | null;
  headline: string;
  /** Why nothing is known, when nothing is. */
  note: string | null;
  rows: PaceRowView[];
  /** How new ordinary work is split, pools with a share above zero only, in rank order. */
  split: PaceSplitPart[];
  /** Some bar draws more than the share used, so the key names those parts. */
  projected: boolean;
}

const VERDICT: Readonly<Record<PoolShareState, string>> = { wasting: 'Send work here', on_pace: 'On pace', starving: 'Top priority only', unknown: 'Unknown' };

type Bag = Record<string, unknown>;
const object = (v: unknown): v is Bag => v !== null && typeof v === 'object' && !Array.isArray(v);
const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const clamp = (n: number): number => Math.max(0, Math.min(100, n));
const tenth = (n: number): number => Math.round(n * 10) / 10;

/** "50 h" as `phm fleet pools` says it; minutes under an hour so a near reset never reads "0 h". */
export function hoursWords(hours: number): string {
  return hours < 1 ? `${Math.max(1, Math.round(hours * 60))} min` : `${Math.round(hours)} h`;
}

/** "40 seconds ago", "3 minutes ago": how old the scheduler's report is. */
export function agoWords(ms: number): string {
  return ageInSeconds(ms / 1000, 'words');
}

function slotsFact(row: Bag | undefined, fresh: boolean): string {
  const slots = row?.recommendedSlots;
  return `suggested running slots ${fresh && num(slots) && Number.isInteger(slots) && slots >= 0 ? slots : 'unknown'}`;
}

function unknownRow(pool: string, why: string, pace: Bag | undefined, fresh: boolean): Omit<PaceRowView, 'slot'> {
  const forecast = paceForecastText(pace ?? null, fresh);
  return { pool, name: poolLabel(pool), state: 'unknown', verdict: VERDICT.unknown, figure: 'share unknown', sharePct: null,
    used: null, more: null, unused: null, ending: 'unread', valueText: 'usage unknown',
    facts: [why, ...(forecast === 'unknown' ? [] : [`pacer forecast: ${forecast}`]), slotsFact(pace, fresh)] };
}

function shareRow(share: Bag & { pool: string; state: PoolShareState }, pace: Bag | undefined): Omit<PaceRowView, 'slot'> {
  const used = num(share.used_percent) && share.used_percent >= 0 ? tenth(clamp(share.used_percent)) : null;
  if (share.state === 'unknown') {
    const row = unknownRow(share.pool, typeof share.reason === 'string' && share.reason ? share.reason : 'a reading is missing', pace, true);
    // A pool can hold a usage reading and still lack the burn or reset the verdict needs: the share used is drawn, nothing more.
    return used === null ? row : { ...row, used, ending: 'unprojected', valueText: `${Math.round(used)}% used, nothing projected`,
      facts: [`${Math.round(100 - used)}% left`, ...row.facts] };
  }
  const hours = num(share.hours_to_reset) && share.hours_to_reset > 0 ? share.hours_to_reset : null;
  const runway = num(share.runway_hours) && share.runway_hours >= 0 ? share.runway_hours : null;
  const end = used !== null && num(share.projected_percent_at_reset) ? Math.max(used, tenth(clamp(share.projected_percent_at_reset))) : null;
  const more = used === null || end === null ? null : tenth(end - used);
  const unused = end === null ? null : tenth(100 - end);
  const dry = share.state === 'starving';
  const sharePct = num(share.suggested_share) && share.suggested_share >= 0 && share.suggested_share <= 1 ? Math.round(share.suggested_share * 100) : null;
  const facts = [
    used === null ? 'usage unknown' : `${Math.round(100 - used)}% left`,
    dry ? `runs dry in ${runway === null ? 'an unknown time' : hoursWords(runway)}` : null,
    hours === null ? 'reset time unknown' : `resets in ${hoursWords(hours)}`,
    dry || end === null ? null : unused! > 0 ? `${Math.round(end)}% used by the reset at this burn` : 'all of it used by the reset at this burn',
    slotsFact(pace, true),
  ].filter((fact): fact is string => fact !== null);
  const valueText = used === null ? 'usage unknown'
    : `${Math.round(used)}% used${dry ? ', runs dry before the reset' : end === null ? '' : `, ${Math.round(end)}% by the reset at this burn${unused! > 0 ? `, ${Math.round(unused!)}% left unused` : ''}`}`;
  return { pool: share.pool, name: poolLabel(share.pool), state: share.state, verdict: VERDICT[share.state], sharePct,
    figure: dry ? 'no ordinary work' : sharePct === null ? 'share unknown' : `${sharePct}% of new work`,
    used, more, unused, ending: used === null ? 'unread' : end === null ? 'unprojected' : dry ? 'dry' : unused! > 0 ? 'unused' : 'even', valueText, facts };
}

export function paceView(raw: unknown, nowMs: number): PaceView {
  const pace = object(raw) && object(raw.pace) && raw.pace.v === 1 ? raw.pace : null;
  const tick = pace !== null && typeof pace.asOf === 'string' ? Date.parse(pace.asOf) : NaN;
  const asOf = Number.isFinite(tick) ? new Date(tick).toISOString() : null;
  const fresh = asOf !== null && nowMs >= tick && nowMs - tick <= PACE_FRESH_MS;
  const paceRows = new Map<string, Bag>();
  for (const row of pace !== null && Array.isArray(pace.pools) ? pace.pools : []) if (object(row) && typeof row.pool === 'string' && !paceRows.has(row.pool)) paceRows.set(row.pool, row);
  const snapshot = fresh && object(pace!.shares) && Array.isArray(pace!.shares.pools) ? pace!.shares : null;
  const shares = new Map<string, Bag & { pool: string; state: PoolShareState }>();
  for (const row of snapshot === null ? [] : snapshot.pools as unknown[]) {
    if (object(row) && typeof row.pool === 'string' && POOL_SHARE_STATES.includes(row.state as PoolShareState) && !shares.has(row.pool)) shares.set(row.pool, row as Bag & { pool: string; state: PoolShareState });
  }
  // The server ranks the shares; pools it holds no share for follow in the order given, then the core pools it left out.
  const names = [...new Set([...shares.keys(), ...paceRows.keys(), ...CORE_POOLS])];
  const slots = [...names].sort((a, b) => a.localeCompare(b));
  const missing = !fresh ? (asOf === null ? 'no scheduler report' : 'no current scheduler report') : snapshot === null ? 'this server sent no pool shares' : 'the report holds no share for this pool';
  const rows = names.map(pool => {
    const share = shares.get(pool);
    return { ...(share ? shareRow(share, paceRows.get(pool)) : unknownRow(pool, missing, paceRows.get(pool), fresh)), slot: slots.indexOf(pool) };
  });
  const split = rows.filter(row => row.sharePct !== null && row.sharePct > 0).map(row => ({ pool: row.pool, name: row.name, pct: row.sharePct!, slot: row.slot }));
  const next = snapshot !== null && typeof snapshot.next_pool === 'string' && shares.has(snapshot.next_pool) ? snapshot.next_pool : null;
  const state = pace === null || asOf === null ? 'none' : fresh ? 'live' : 'stale';
  return {
    state, asOf, rows, split, projected: rows.some(row => row.more !== null),
    headline: snapshot === null ? 'Where to send work: unknown.' : next === null ? 'No pool is known to have room for ordinary work.' : `Next job goes to ${poolLabel(next)}.`,
    note: snapshot !== null ? null
      : state === 'none' ? 'This read holds no scheduler report.'
        : nowMs < tick ? 'The scheduler report is stamped ahead of this clock, so it is not read as current.'
          : state === 'stale' ? `The scheduler last reported ${agoWords(nowMs - tick)}. A report older than two minutes is not read as current.`
            : 'This server sent no pool shares with its report.',
  };
}
