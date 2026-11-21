/**
 * `pools.spenddown.v1`: for each plan, how much is spent, where a straight line from the last reset would be by now,
 * and where the current burn ends at reset, with a verdict in plain words. Behind `phm pools spenddown`,
 * GET /api/app/pools/spenddown, and the one-row-per-pool chart on the desktop usage panel and the phone Home.
 *
 * Derived only from pools.v1 (`buildPoolsView`), so the burn, the reset and the staleness rules are the ones
 * `phm pools` already uses; nothing here re-measures. A pool with no current reading is "no reading", never zero.
 */
import { join } from 'node:path';
import { poolLabel } from '../usage/runway.js';
import type { PoolRow, PoolsViewV1 } from './pools-view.js';
import { signInFix } from './pools-waste.js';
import type { QueueSupplyV1 } from './queue-supply.js';

export const SPENDDOWN_SCHEMA = 'pools.spenddown.v1';
export const SPENDDOWN_PATH = '/api/app/pools/spenddown';

/** on-pace and under are the two good-to-know cases; idle is a freshly refilled pool whose lane has queued rows but nothing running; over runs dry early; drained is empty now; unknown has no reading. */
export type SpendDownState = 'on-pace' | 'under' | 'idle' | 'over' | 'drained' | 'unknown';

export interface SpendDownRow {
  id: string;
  label: string;
  state: SpendDownState;
  /** Share of the window's allowance used now, 0 to 1; null without a current reading. */
  used_frac: number | null;
  reset_at: string | null;
  /** Where a straight line from the last reset would be now, 0 to 1: the bar's tick. Null when the window is unknown. */
  even_pace_frac: number | null;
  /** Share used at reset if the current burn holds, 0 to 1: the bar's marker. Null when the burn is unknown. */
  projected_at_reset: number | null;
  /** When the pool runs dry before its reset at this burn; null otherwise. */
  projected_empty_at: string | null;
  /** The whole story in plain words: "spending on pace", "refilled, lane idle", "behind: will waste ~12%", "exhausted until Fri 6 PM", "unknown". */
  verdict: string;
  /** Hours until the reset, one decimal; null when the reset is unknown or already passed. */
  resets_in_h: number | null;
  /** When the plan's last reading was captured; null when none was ever recorded. */
  as_of: string | null;
  /** Minutes since that reading, whole; null when there is none or its time is not usable. */
  reading_age_min: number | null;
  /** Why there is no reading; null when there is one. */
  reason: string | null;
  /** Hours of work queued for this pool: ready jobs times the pool's recent median job time. 0 for an empty queue; null when the queue or the job times are unknown. Absent on older payloads. */
  queued_hours?: number | null;
  /** Jobs running on the pool's lane right now, as the dispatcher last reported them; null when unreported. Absent on older payloads. */
  running?: number | null;
  /** Slots the lane is allowed to run; null when unreported. Absent on older payloads. */
  target?: number | null;
  /** Rows waiting in the ready queue for this pool's lane; 0 for an empty queue; null when the queue could not be read. Absent on older payloads. */
  queued_rows?: number | null;
  /** "sign-in" when the lane is held waiting for a sign-in (the verdict then says "blocked: sign-in"); null otherwise. Absent on older payloads. */
  blocked?: 'sign-in' | null;
  /** The one step that clears a block, in plain words; null when not blocked. */
  blocked_fix?: string | null;
}

/** What the chart adds to pools.v1: the queue, each lane's recent median job time, and why held lanes are held. Each may be missing. */
export interface SpendDownExtras {
  supply?: Pick<QueueSupplyV1, 'pools'> | null;
  /** Median minutes per finished job by lane over the recent window; a lane with no finished jobs is absent or null. */
  medianJobMinByLane?: Readonly<Record<string, number | null>> | null;
  heldReasons?: Readonly<Record<string, string | null>>;
}

export interface SpendDownV1 {
  schema: typeof SPENDDOWN_SCHEMA;
  generated_at: string;
  /** Plans that run dry early or leave a lot unspent first, then the rest as `phm pools` orders them. */
  pools: SpendDownRow[];
}

const frac = (pct: number | null): number | null => pct === null ? null : Math.round(Math.min(100, Math.max(0, pct)) * 10) / 1000;

/** "Fri 6 PM", in the reader's own time zone. */
function dayAndHour(iso: string): string {
  const at = new Date(iso);
  return `${at.toLocaleString('en-US', { weekday: 'short' })} ${at.toLocaleString('en-US', { hour: 'numeric' })}`.replace(/\s/g, ' ');
}

/** "20 min old", "3 h old", "2 d old". */
function ageText(min: number): string {
  return min < 60 ? `${min} min old` : min < 2880 ? `${Math.round(min / 60)} h old` : `${Math.round(min / 1440)} d old`;
}

/** A pool this unused and this early in its window has just refilled; past either line an idle lane is just behind. */
export const REFILLED_MAX_USED_PCT = 10;
export const REFILLED_MAX_ELAPSED_PCT = 25;

/** Rows are waiting, the lane is open and nothing is running. Unreported slots or queue never count as idle. */
const laneIdle = (row: PoolRow, queued: number | null): boolean => row.held !== true && row.running === 0 && queued !== null && queued > 0;

function stateOf(row: PoolRow, queued: number | null): SpendDownState {
  if (row.usedPct === null) return 'unknown';
  if (row.verdict === 'fully used' || row.usedPct >= 100) return 'drained';
  if (laneIdle(row, queued) && row.usedPct <= REFILLED_MAX_USED_PCT && (row.elapsedPct === null || row.elapsedPct <= REFILLED_MAX_ELAPSED_PCT)) return 'idle';
  if (row.verdict === 'slow down') return 'over';
  if (row.verdict === 'add work') return 'under';
  return row.verdict === 'on pace' ? 'on-pace' : 'unknown';
}

function verdictOf(row: PoolRow, state: SpendDownState, ageMin: number | null): string {
  switch (state) {
    case 'on-pace': return 'spending on pace';
    case 'idle': return 'refilled, lane idle';
    case 'under': return `behind: will waste ~${Math.round(row.projectedUnusedPct ?? 0)}%`;
    case 'over': return `will run out ${row.projectedEmptyAt === null ? 'early' : `about ${dayAndHour(row.projectedEmptyAt)}`}: slow down`;
    case 'drained': return row.resetAt === null ? 'exhausted' : `exhausted until ${dayAndHour(row.resetAt)}`;
    case 'unknown':
      if (row.usedPct === null && ageMin !== null && row.reason?.startsWith('no reading since')) return `unknown: no fresh reading (${ageText(ageMin)})`;
      return row.usedPct === null ? 'unknown: no reading' : 'unknown: not enough readings for a pace';
  }
}

/** ready jobs x median job minutes, in hours with one decimal; 0 for an empty queue; null when either input is unknown. */
export function queuedHours(ready: number | null | undefined, medianMin: number | null | undefined): number | null {
  if (ready === null || ready === undefined) return null;
  if (ready === 0) return 0;
  return medianMin === null || medianMin === undefined || !(medianMin > 0) ? null : Math.round(ready * medianMin / 6) / 10;
}

export function buildSpendDown(view: Pick<PoolsViewV1, 'pools' | 'generatedAt'>, extras: SpendDownExtras = {}): SpendDownV1 {
  const nowMs = Date.parse(view.generatedAt);
  const pools = view.pools.map((row): SpendDownRow => {
    const ready = extras.supply?.pools.find(p => p.id === row.id)?.ready ?? null;
    const state = stateOf(row, ready);
    const asOfMs = row.asOf === null ? NaN : Date.parse(row.asOf);
    const ageMin = Number.isFinite(asOfMs) && Number.isFinite(nowMs) && asOfMs <= nowMs ? Math.floor((nowMs - asOfMs) / 60_000) : null;
    const resetMs = row.resetAt === null ? NaN : Date.parse(row.resetAt);
    const resetsIn = Number.isFinite(resetMs) && Number.isFinite(nowMs) && resetMs > nowMs ? Math.round((resetMs - nowMs) / 360_000) / 10 : null;
    const fully = state === 'drained';
    const fix = signInFix(row, extras.heldReasons);
    return {
      id: row.id, label: poolLabel(row.id), state, used_frac: frac(row.usedPct), reset_at: row.resetAt,
      even_pace_frac: frac(row.elapsedPct),
      projected_at_reset: fully ? 1 : row.projectedUnusedPct === null ? null : frac(100 - row.projectedUnusedPct),
      projected_empty_at: row.projectedEmptyAt, verdict: fix === null ? verdictOf(row, state, ageMin) : 'blocked: sign-in', resets_in_h: resetsIn, as_of: row.asOf, reading_age_min: ageMin, reason: row.usedPct === null ? row.reason ?? 'no reading' : row.reason,
      running: row.running, target: row.target, queued_rows: ready,
      queued_hours: queuedHours(ready, extras.medianJobMinByLane?.[row.id]), blocked: fix === null ? null : 'sign-in', blocked_fix: fix,
    };
  });
  return { schema: SPENDDOWN_SCHEMA, generated_at: view.generatedAt, pools };
}

/** `phm pools spenddown --text`: one line per pool, "Claude: 72% used, even pace 61%, ends near 88%: behind: will waste ~12%; 2 running of 3 slots, 5 queued". */
export function formatSpendDownText(data: SpendDownV1): string {
  if (data.pools.length === 0) return 'No plans reported.';
  const pct = (value: number | null): string => value === null ? 'unknown' : `${Math.round(value * 100)}%`;
  return data.pools.map(row => {
    const queued = `${row.running === undefined ? '' : `; ${slotsText(row.running, row.target ?? null, row.queued_rows ?? null)}`}${row.queued_hours === undefined ? '' : `; ${queuedText(row.queued_hours)}`}`;
    const fix = row.blocked_fix ? ` (${row.blocked_fix})` : '';
    return (row.used_frac === null ? `${row.label}: ${row.verdict}${fix}`
      : `${row.label}: ${pct(row.used_frac)} used, even pace ${pct(row.even_pace_frac)}, ends near ${pct(row.projected_at_reset)}: ${row.verdict}${fix}`) + queued;
  }).join('\n');
}

/** "2 running of 3 slots, 5 queued"; an unreported figure reads "unknown", never 0. */
export function slotsText(running: number | null, target: number | null, queued: number | null): string {
  return `${running === null ? 'running unknown' : `${running} running${target === null ? '' : ` of ${target} slots`}`}, ${queued === null ? 'queue unknown' : `${queued} queued`}`;
}

/** "3.5 h queued", "nothing queued", "queued: unknown". */
export const queuedText = (hours: number | null): string => hours === null ? 'queued: unknown' : hours === 0 ? 'nothing queued' : `${hours} h queued`;

const RECENT_JOBS_HOURS = 72;

/** Median minutes per finished job by lane, from the jobs ledger through the outcome metrics; a lane with no timed job is null. */
export async function readMedianJobMinutes(opts: { runsDir?: string; nowMs: number }): Promise<Record<string, number | null> | null> {
  const [{ readText }, { buildOutcomeMetrics }, { defaultRunsDir }] = await Promise.all([
    import('./empty-cause.js'), import('./outcome-metrics.js'), import('./landed-closes-read.js'),
  ]);
  const text = await readText(join(opts.runsDir ?? defaultRunsDir(), 'metrics', 'jobs.jsonl'), 8 * 1024 * 1024);
  if (text === null) return null;
  const events: unknown[] = [];
  for (const line of text.split(/\r?\n/)) { try { events.push(JSON.parse(line)); } catch { /* blank or partial line */ } }
  const metrics = buildOutcomeMetrics({ events, nowMs: opts.nowMs, hours: RECENT_JOBS_HOURS });
  return Object.fromEntries(metrics.byLane.map(g => [g.name, g.samples.duration > 0 && g.medianDuration !== null ? g.medianDuration / 60 : null]));
}

/** Reads the queue, job times and held reasons (each optional: a failed read leaves that figure unknown), then builds the chart. */
export async function readSpendDown(view: Pick<PoolsViewV1, 'pools' | 'generatedAt'>, opts: { runsDir?: string; nowMs: number }): Promise<SpendDownV1> {
  const runs = opts.runsDir === undefined ? {} : { runsDir: opts.runsDir };
  const now = () => opts.nowMs;
  const [{ readQueueSupply }, { readFleetRunsDirState }] = await Promise.all([import('./queue-supply.js'), import('./runs-dir-state.js')]);
  const [supply, state, medianJobMinByLane] = await Promise.all([
    readQueueSupply({ ...runs, now }).catch(() => null),
    readFleetRunsDirState({ ...runs, now }).catch(() => null),
    readMedianJobMinutes(opts).catch(() => null),
  ]);
  const heldReasons = Object.fromEntries((state?.lanes ?? []).filter(l => l.held).map(l => [l.lane, l.heldReason]));
  return buildSpendDown(view, { supply, medianJobMinByLane, heldReasons });
}
