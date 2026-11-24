/**
 * Plan pace check: per usage plan, is it burning too fast, too slow, or on pace?
 *
 * Numbers come from the runway report (`usageRunway` in fleet/usage-history.ts,
 * the one place pace is measured); this file only classifies them and words the
 * warning. Unknown stays unknown (null, verdict "unknown"), never a guess.
 *
 *   too fast  the plan runs out TOO_FAST_HOURS or more before its reset
 *   too slow  at this pace more than TOO_SLOW_UNSPENT_PCT of it is unspent at reset
 *
 * `postPaceAlerts` sends one plain line per plan to the Leader thread (the
 * existing `postLeaderMessage`), at most once per plan per PACE_ALERT_GAP_MS.
 */
import { join } from 'node:path';
import type { PoolUsageSeries } from '../fleet/usage-history.js';
import { poolLabel } from './runway.js';

export const PLAN_PACE_SCHEMA = 'usage.plan-pace.v1' as const;
export const TOO_FAST_HOURS = 6;
export const TOO_SLOW_UNSPENT_PCT = 15;
export const PACE_ALERT_GAP_MS = 2 * 3_600_000;
const STATE_MAX_BYTES = 8 * 1024;

export type PlanPaceVerdict = 'on pace' | 'too fast' | 'too slow' | 'unknown';

export interface PlanPaceRow {
  plan: string;
  used_percent: number | null;
  hours_to_reset: number | null;
  points_per_hour: number | null;
  /** Points per hour that would use the rest of the plan exactly at reset. */
  even_pace_points_per_hour: number | null;
  /** Positive = runs out this many hours before reset; negative = still has time left at reset. */
  hours_early: number | null;
  /** Share of the plan left unspent at reset at the current pace; 0 when it runs out first. */
  unspent_percent: number | null;
  /** Hours from now until the plan is empty at the current pace. */
  runs_out_in_hours: number | null;
  verdict: PlanPaceVerdict;
  /** Why the verdict is unknown; null otherwise. */
  reason: string | null;
}

export interface PlanPaceV1 { schema: typeof PLAN_PACE_SCHEMA; v: 1; generated_at: string; plans: PlanPaceRow[] }

const round1 = (n: number): number => Math.round(n * 10) / 10;

/** Pure verdict from numbers the runway report already measured. */
export function paceVerdict(hoursEarly: number | null, unspentPct: number | null): PlanPaceVerdict {
  if (hoursEarly === null || unspentPct === null) return 'unknown';
  if (hoursEarly >= TOO_FAST_HOURS) return 'too fast';
  if (unspentPct > TOO_SLOW_UNSPENT_PCT) return 'too slow';
  return 'on pace';
}

/** One row per plan from the usage-history series (which wrap the runway report). */
export function planPaceRows(series: readonly PoolUsageSeries[]): PlanPaceRow[] {
  return series.map(s => {
    const r = s.runway;
    const used = s.used_pct;
    const pace = r.pace_per_hour;
    const toReset = r.hours_to_reset;
    const known = r.verdict !== 'unknown' && used !== null && pace !== null && toReset !== null;
    const runsOut = known && r.runway_hours !== null ? r.runway_hours : null;
    const early = known && runsOut !== null ? round1(toReset! - runsOut) : null;
    const unspent = known ? round1(Math.max(0, 100 - used! - pace! * toReset!)) : null;
    return {
      plan: s.pool, used_percent: used, hours_to_reset: toReset, points_per_hour: pace,
      even_pace_points_per_hour: r.target_pace_per_hour, hours_early: early, unspent_percent: unspent,
      runs_out_in_hours: runsOut, verdict: paceVerdict(early, unspent),
      reason: r.verdict === 'unknown' ? r.reason : early === null && known ? 'pace is zero' : null,
    };
  });
}

/** Read every plan the runway report knows (takes a fresh ledger reading, as `phm fleet usage-history` does). */
export async function readPlanPace(opts: { runsDir?: string; now?: () => number } = {}): Promise<PlanPaceV1> {
  const { readUsageHistory } = await import('../fleet/usage-history.js');
  const nowMs = (opts.now ?? Date.now)();
  const history = await readUsageHistory({ ...opts, now: () => nowMs });
  return { schema: PLAN_PACE_SCHEMA, v: 1, generated_at: new Date(nowMs).toISOString(), plans: planPaceRows(history.pools) };
}

const num = (n: number): string => String(Math.round(n * 10) / 10);

/** The one plain line for a plan that is too fast or too slow; null otherwise. */
export function paceAlertLine(row: PlanPaceRow, nowMs: number, timeZone?: string): string | null {
  const name = poolLabel(row.plan);
  if (row.verdict === 'too fast' && row.points_per_hour !== null && row.runs_out_in_hours !== null && row.hours_early !== null) {
    const when = new Date(nowMs + row.runs_out_in_hours * 3_600_000)
      .toLocaleString('en-US', { weekday: 'long', hour: 'numeric', ...(timeZone ? { timeZone } : {}) }).replace(',', '');
    return `${name} is burning ${num(row.points_per_hour)} points an hour; at this rate it runs out ${when}, ${Math.round(row.hours_early)} hours before its reset.`;
  }
  if (row.verdict === 'too slow' && row.points_per_hour !== null && row.unspent_percent !== null) {
    const speed = row.even_pace_points_per_hour === null ? '' : ` Speed up to ${num(row.even_pace_points_per_hour)} points an hour to use it all.`;
    return `${name} is burning only ${num(row.points_per_hour)} points an hour; at this rate ${Math.round(row.unspent_percent)}% goes unused at its reset.${speed}`;
  }
  return null;
}

/** Last alert time (ms) per plan. */
export type PaceAlertState = Record<string, number>;

/** Pure: lines to post now (at most one per plan per 2 hours) and the state once they are posted. */
export function planPaceAlerts(rows: readonly PlanPaceRow[], state: PaceAlertState, nowMs: number, timeZone?: string):
  { posts: { plan: string; text: string }[]; state: PaceAlertState } {
  const next: PaceAlertState = { ...state };
  const posts: { plan: string; text: string }[] = [];
  for (const row of rows) {
    const text = paceAlertLine(row, nowMs, timeZone);
    if (text === null) continue;
    const last = state[row.plan];
    if (typeof last === 'number' && nowMs >= last && nowMs - last < PACE_ALERT_GAP_MS) continue;
    posts.push({ plan: row.plan, text });
    next[row.plan] = nowMs;
  }
  return { posts, state: next };
}

export function parsePaceAlertState(text: string | null): PaceAlertState {
  const out: PaceAlertState = {};
  if (text === null) return out;
  try {
    const raw: unknown = JSON.parse(text);
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      for (const [plan, at] of Object.entries(raw)) if (typeof at === 'number' && Number.isFinite(at) && /^[a-z0-9][a-z0-9._-]{0,39}$/.test(plan)) out[plan] = at;
    }
  } catch { /* damaged state: start over, worst case one repeat line */ }
  return out;
}

export interface PaceAlertDeps {
  stateDir: string;
  /** Synchronous so the locked read-plan-post-write section never yields. Throws when the post fails. */
  post(text: string): void;
}

/** Post each due line, then record the time. A failed post leaves that plan unrecorded, so the next tick retries. */
export async function postPaceAlerts(rows: readonly PlanPaceRow[], deps: PaceAlertDeps, nowMs: number, timeZone?: string): Promise<string[]> {
  if (!rows.some(r => r.verdict === 'too fast' || r.verdict === 'too slow')) return [];
  const [{ acquireLocalStoreLockWithOutcome, releaseLocalStoreLock }, prefs] = await Promise.all([
    import('../fleet/local-store-lock.js'), import('../verse/preferences.js'),
  ]);
  prefs.ensurePrivateDirectory(deps.stateDir);
  const path = join(deps.stateDir, 'pace-alerts.json');
  const lock = acquireLocalStoreLockWithOutcome(`${path}.lock`);
  if (lock.state !== 'acquired') return [];
  const sent: string[] = [];
  try {
    let state: PaceAlertState;
    try { state = parsePaceAlertState(prefs.readPrivateFileCapped(path, STATE_MAX_BYTES)?.text ?? null); } catch { state = {}; }
    const plan = planPaceAlerts(rows, state, nowMs, timeZone);
    const next = { ...state };
    for (const post of plan.posts) {
      try { deps.post(post.text); sent.push(post.text); next[post.plan] = nowMs; } catch { /* retried next tick */ }
    }
    if (sent.length) prefs.writePrivateFileAtomic(path, `${JSON.stringify(next)}\n`);
  } finally { releaseLocalStoreLock(lock.lock); }
  return sent;
}

/** Production wiring for the Leader tick: read the plans, post due lines to the Leader thread. */
export async function runDefaultPaceAlerts(): Promise<string[]> {
  const [{ postLeaderMessage }, memo] = await Promise.all([import('../vision/leader-thread.js'), import('../vision/leader-memo.js')]);
  const pace = await readPlanPace();
  const sent = await postPaceAlerts(pace.plans, {
    stateDir: memo.leaderRoot(),
    post: text => { postLeaderMessage({ channel: 'telegram', kind: 'update', text }); },
  }, Date.parse(pace.generated_at));
  // A notice failure must not hide the pace alerts already posted.
  try { sent.push(...await (await import('../fleet/lane-held-notice.js')).runDefaultHeldLaneNotices()); } catch { /* retried next tick */ }
  return sent;
}
