/** Pure provenance-aware reset opportunity, independent of dispatch authority. */
import { assessSeat, classifyWindow, HEADROOM_READING_MAX_AGE_MS, type SeatCapacity } from './headroom.js';
import { costBasisOf } from './tiers.js';
import type { SeatBudgetPolicy } from './types.js';
import type { AccountSchedulingView, ResetProvenance, TaskWorkForecast } from './scheduling-types.js';
import { narrowClaudeApiGrantReadView } from '../resources/claude-api-grant-types.js';

export const UNKNOWN_RESET: Readonly<ResetProvenance> = Object.freeze({ kind: 'unknown', at: null, description: null, source: null });

/** Refuse inconsistent timestamps/semantics; a date alone never proves expiry. */
export function validResetProvenance(value: unknown): value is ResetProvenance {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as ResetProvenance;
  if (!['fixed-period', 'weekly-deadline', 'rolling-release', 'balance', 'unknown'].includes(v.kind) ||
    v.description !== null && typeof v.description !== 'string' || v.source !== null && typeof v.source !== 'string') return false;
  const instant = (s: unknown): s is string => typeof s === 'string' && Number.isFinite(Date.parse(s)) && new Date(s).toISOString() === s;
  if (v.at !== null && !instant(v.at) || v.startsAt != null && !instant(v.startsAt)) return false;
  if (v.kind === 'fixed-period' && (!instant(v.at) || !instant(v.startsAt) || v.startsAt >= v.at || !v.source)) return false;
  if (v.kind === 'weekly-deadline' && (!instant(v.at) || v.startsAt != null ||
    !(v.source === 'claude-native-usage-report' && ['pro', 'max'].includes(v.plan ?? '') && v.windowDurationMins === undefined ||
      v.source === 'codex-native-rate-limits' && ['plus', 'pro'].includes(v.plan ?? '') && v.windowDurationMins === 10080))) return false;
  return !(v.kind === 'balance' && v.at !== null);
}

/** A qualified account deadline, not a promise of no allowance carryover. */
export function hasResetDeadline(reset: ResetProvenance): boolean {
  return reset.kind === 'fixed-period' || reset.kind === 'weekly-deadline';
}

export function forecastFit(forecast: { durationMs: Pick<NonNullable<TaskWorkForecast['durationMs']>, 'p25' | 'p75'> | null } | null, resetAt: string | null, nowMs: number): TaskWorkForecast['fit'] {
  const duration = forecast?.durationMs;
  const slack = resetAt === null ? NaN : Date.parse(resetAt) - nowMs;
  if (!duration || !Number.isFinite(slack) || slack <= 0) return 'unknown';
  return duration.p75 <= slack ? 'likely-before-reset' : duration.p25 > slack ? 'unlikely-before-reset' : 'uncertain';
}

export function assessResetOpportunity(seat: SeatCapacity, policy: SeatBudgetPolicy, nowMs: number,
  forecast: TaskWorkForecast | null = null): AccountSchedulingView {
  if (seat.engine === 'claude-api' || seat.seatId.toLowerCase() === 'claude-api') {
    const grant = narrowClaudeApiGrantReadView({ v: 1, state: 'healthy', rows: [seat.claudeApiGrant] })?.rows[0];
    const captured = grant?.capturedAt === null ? NaN : Date.parse(grant?.capturedAt ?? '');
    const cutoff = grant?.admissionCutoff ?? null;
    const fresh = Number.isFinite(captured) && captured <= nowMs && nowMs - captured <= HEADROOM_READING_MAX_AGE_MS;
    const duration = forecast?.durationMs;
    const knownDuration = forecast?.cohort.engine === 'claude-api' &&
      (forecast.cohort.seatId === null || forecast.cohort.seatId === seat.seatId) && duration !== null && duration !== undefined &&
      Number.isFinite(duration.p25) && Number.isFinite(duration.p75) && duration.p25 > 0 && duration.p75 >= duration.p25;
    const hasBalance = grant?.remainingUsdMicros != null && grant.totalUsdMicros !== null && BigInt(grant.remainingUsdMicros) > 0n;
    const fit = fresh && hasBalance && knownDuration ? forecastFit(forecast, cutoff, nowMs) : 'unknown';
    // Expiry fit is an estimate against a conservative cutoff, not a reset or
    // permission to spend. Current signed grants contain no Claude API lane.
    return { seatId: seat.seatId, observedAt: grant?.capturedAt ?? null, admission: 'held', headroomPercent: null,
      reset: { kind: 'balance', at: null, description: cutoff === null ? 'API credit expiry is unknown.'
        : `API admission cutoff: ${cutoff}.`, source: 'claude-api-grant-display' },
      opportunity: { kind: 'held', reason: 'Claude API is not commissioned in the signed grant; credit history does not authorize spending.' },
      forecast: forecast === null ? null : { ...forecast, fit } };
  }
  const assessment = assessSeat(seat, policy, { nowMs });
  const observed = seat.observedAt === null ? NaN : Date.parse(seat.observedAt);
  const fresh = seat.free || Number.isFinite(observed) && observed <= nowMs && nowMs - observed <= HEADROOM_READING_MAX_AGE_MS;
  // Every account-wide window must still be current. An expired conflicting
  // window cannot be ignored simply because another period looks attractive.
  const accountWindows = seat.windows.filter((w) => classifyWindow(seat.engine,w,nowMs) !== 'model');
  const outsidePeriod = accountWindows.some((w) => w.resetProvenance?.kind === 'fixed-period' &&
    validResetProvenance(w.resetProvenance) && (Date.parse(w.resetProvenance.startsAt!) > nowMs || Date.parse(w.resetProvenance.at!) <= nowMs));
  const expired = accountWindows.some((w) => w.resetsAt !== null && Date.parse(w.resetsAt) <= nowMs);
  // A billing date is not proof that paid credits expire. Only the actual
  // effective subscription lane qualifies for allowance-deadline preference.
  // Other lanes retain ordinary admission; verified gift expiry is a separate
  // provider/account evidence contract that this projection does not invent.
  const subscription = (seat.costBasis ?? costBasisOf(seat.engine)) === 'subscription';
  const finitePeriods = accountWindows.filter((w) => subscription && w.resetProvenance && validResetProvenance(w.resetProvenance) &&
    w.resetsAt === w.resetProvenance.at && Date.parse(w.resetProvenance.at!) > nowMs &&
    (w.resetProvenance.kind === 'fixed-period' && Date.parse(w.resetProvenance.startsAt!) <= nowMs ||
      w.resetProvenance.kind === 'weekly-deadline' && (seat.engine === 'claude' && w.id === 'seven_day' && w.resetProvenance.source === 'claude-native-usage-report' ||
        seat.engine === 'codex' && w.id === 'codex_codex_secondary' && w.resetProvenance.source === 'codex-native-rate-limits')));
  const earliest = finitePeriods.sort((a, b) => Date.parse(a.resetProvenance!.at!) - Date.parse(b.resetProvenance!.at!))[0];
  const unknownWindow = seat.windows.find((w) => w.resetDescription || w.resetsAt);
  const reported = accountWindows.find((w) => w.resetProvenance && !hasResetDeadline(w.resetProvenance) && validResetProvenance(w.resetProvenance));
  const reset: ResetProvenance = earliest?.resetProvenance ?? reported?.resetProvenance ?? (seat.windowless ? {
    kind: 'balance', at: null, description: 'No expiring quota window reported.', source: 'seat-cost-contract',
  } : { ...UNKNOWN_RESET, at: unknownWindow?.resetsAt ?? null, description: unknownWindow?.resetDescription ?? null });
  const admission = !fresh || expired || outsidePeriod || assessment.unknownUsage ? 'unknown'
    : assessment.headroom.eligibleForAutonomy ? 'eligible' : 'held';
  const fit = forecastFit(forecast, hasResetDeadline(reset) ? reset.at : null, nowMs);
  const qualified = forecast === null ? null : { ...forecast, fit };
  return { seatId: seat.seatId, observedAt: seat.observedAt, admission,
    headroomPercent: assessment.headroom.autonomyHeadroomPercent, reset,
    opportunity: { kind: admission === 'unknown' ? 'unknown' : admission === 'held' ? 'held'
      : hasResetDeadline(reset) && fit !== 'unlikely-before-reset' ? 'before-reset' : 'ordinary',
    reason: admission === 'unknown' ? 'A fresh, current account-window observation is required.'
      : admission === 'held' ? assessment.headroom.reasons[0] ?? 'Current policy holds this account.'
      : hasResetDeadline(reset) ? fit === 'unlikely-before-reset' ? 'Observed work duration exceeds this period; prefer shorter useful work.'
        : reset.kind === 'weekly-deadline' ? 'Qualified native subscription weekly deadline has admitted headroom; work fit remains an estimate.'
          : 'Provider-reported fixed period ends with admitted headroom; work fit remains an estimate.'
      : 'Use ordinary admitted routing; allowance expiry is not established.' }, forecast: qualified };
}

/** Only compare opportunities after the caller has enforced eligibility and tier. */
export function opportunityPriority(view: AccountSchedulingView, nowMs: number): number {
  if (view.admission !== 'eligible' || view.opportunity.kind !== 'before-reset') return 0;
  if (!hasResetDeadline(view.reset) || !validResetProvenance(view.reset) || !Number.isFinite(nowMs)) return 0;
  const duration = view.forecast?.durationMs?.p75;
  const remaining = view.reset.at === null ? NaN : Date.parse(view.reset.at) - nowMs;
  if (typeof duration !== 'number' || !Number.isFinite(duration) || duration <= 0 || !Number.isFinite(remaining) || remaining <= 0) return 0;
  // Continuous proximity, not a fixed urgency horizon: it increases as the
  // reported deadline approaches this work's observed upper-quartile duration.
  // Fit bands preserve likely-over-uncertain preference; no estimate means no
  // priority. Explicit time also prevents a recorded fit surviving its reset.
  const proximity = 1 / (1 + remaining / duration);
  const fit = forecastFit(view.forecast, view.reset.at, nowMs);
  return fit === 'likely-before-reset' ? 1 + proximity : fit === 'uncertain' ? proximity : 0;
}

// ---------------------------------------------------------------------------
// Reset calendar: target burn rate per pool, weekly quota before credits
// ---------------------------------------------------------------------------

/**
 * The share of an expiring window the calendar aims to have used at reset.
 * Landing short of 100 keeps a small margin against the provider's own
 * rounding and against work started just before the deadline.
 */
export const RESET_TARGET_USED_PERCENT = 98;

/**
 * One pool's reset calendar entry: the instant its current allowance window
 * resets and the percent of that allowance still unspent. A pool may also
 * carry a credit balance independent of the window (Codex credits are spent
 * only after the expiring weekly quota lane). Pure data; the caller supplies
 * provider readings and resets, never invented values.
 */
export interface ResetCalendarPool {
  pool: string;
  /** ISO instant the current allowance window resets; null when unknown. */
  resetAt: string | null;
  /** Percent of the window allowance still unspent (0-100); null when unknown. */
  remainingPercent: number | null;
  /** Spendable credit balance in the pool's own units; absent or 0 means no credits lane. */
  creditBalance?: number | null;
}

/** Refuse malformed calendar entries; an unparseable reset is not evidence. */
export function validResetCalendarPool(value: unknown): value is ResetCalendarPool {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as ResetCalendarPool;
  if (typeof v.pool !== 'string' || v.pool.trim().length === 0 || v.pool.length > 128) return false;
  if (v.resetAt !== null && (typeof v.resetAt !== 'string' || !Number.isFinite(Date.parse(v.resetAt)))) return false;
  if (v.remainingPercent !== null && (typeof v.remainingPercent !== 'number' ||
    !Number.isFinite(v.remainingPercent) || v.remainingPercent < 0 || v.remainingPercent > 100)) return false;
  return v.creditBalance === undefined || v.creditBalance === null ||
    typeof v.creditBalance === 'number' && Number.isFinite(v.creditBalance) && v.creditBalance >= 0;
}

export interface ResetPaceStatus {
  pool: string;
  resetAt: string | null;
  remainingPercent: number | null;
  /** Hours from nowMs until reset; null when the reset is unknown or already passed. */
  hoursToReset: number | null;
  /**
   * Allowance percent per hour the pool must burn from now to land at the
   * target at reset. Null when the reset or the reading is unknown; 0 when
   * the reading already meets the target.
   */
  pacePerHour: number | null;
}

/**
 * Required burn rate for one pool: the unspent allowance above the margin,
 * spread evenly over the time left before reset. A reset in the past makes the
 * reading stale, not spendable, so the pace stays unknown rather than negative.
 */
export function resetPace(pool: ResetCalendarPool, nowMs: number, target = RESET_TARGET_USED_PERCENT): ResetPaceStatus {
  const resetMs = pool.resetAt === null ? NaN : Date.parse(pool.resetAt);
  const hoursToReset = Number.isFinite(resetMs) && resetMs > nowMs ? (resetMs - nowMs) / 3_600_000 : null;
  const remaining = typeof pool.remainingPercent === 'number' && Number.isFinite(pool.remainingPercent)
    ? Math.max(0, Math.min(100, pool.remainingPercent)) : null;
  const spendable = remaining === null ? null : Math.max(0, remaining - (100 - target));
  const pacePerHour = hoursToReset !== null && hoursToReset > 0 && spendable !== null ? spendable / hoursToReset : null;
  return { pool: pool.pool, resetAt: pool.resetAt, remainingPercent: remaining, hoursToReset, pacePerHour };
}

export type ResetLaneKind = 'weekly' | 'credits';

/** One spend lane inside a pool, in the order the router should spend it. */
export interface ResetLane {
  pool: string;
  kind: ResetLaneKind;
  /** Weekly lanes carry the required burn; credits lanes always null. */
  pacePerHour: number | null;
  resetAt: string | null;
  /** Weekly lanes carry the unspent window percent; credits lanes null. */
  remainingPercent: number | null;
  /** Credits lanes carry the spendable balance in pool units; weekly lanes null. */
  creditBalance: number | null;
}

function compareLaneIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Lane order for spending: every spendable weekly quota lane precedes every
 * credits lane, because the weekly allowance expires and the balance does
 * not. Weekly lanes rank by required burn (most behind first), then earlier
 * reset, then pool id. A weekly lane whose reset already passed is stale
 * evidence and drops out; one with a known remainder but no usable reset
 * keeps its lane after the paced ones. Credits lanes rank by balance.
 */
export function resetLaneOrder(pools: readonly ResetCalendarPool[], nowMs: number,
  target = RESET_TARGET_USED_PERCENT): ResetLane[] {
  const weekly: { lane: ResetLane; pace: number | null }[] = [];
  const credits: { lane: ResetLane; balance: number }[] = [];
  for (const pool of pools) {
    if (!validResetCalendarPool(pool)) continue;
    const resetMs = pool.resetAt === null ? NaN : Date.parse(pool.resetAt);
    const resetPassed = Number.isFinite(resetMs) && resetMs <= nowMs;
    const pace = resetPace(pool, nowMs, target);
    if (pool.remainingPercent !== null && pool.remainingPercent > 0 && !resetPassed) {
      weekly.push({
        lane: { pool: pool.pool, kind: 'weekly', pacePerHour: pace.pacePerHour,
          resetAt: pool.resetAt, remainingPercent: pace.remainingPercent, creditBalance: null },
        pace: pace.pacePerHour,
      });
    }
    if (typeof pool.creditBalance === 'number' && pool.creditBalance > 0) {
      credits.push({ lane: { pool: pool.pool, kind: 'credits', pacePerHour: null,
        resetAt: null, remainingPercent: null, creditBalance: pool.creditBalance }, balance: pool.creditBalance });
    }
  }
  const resetRank = (lane: ResetLane): number => lane.resetAt === null ? Infinity : Date.parse(lane.resetAt);
  weekly.sort((a, b) => {
    const ap = a.pace === null ? Infinity : -a.pace;
    const bp = b.pace === null ? Infinity : -b.pace;
    return ap - bp || resetRank(a.lane) - resetRank(b.lane) || compareLaneIds(a.lane.pool, b.lane.pool);
  });
  credits.sort((a, b) => b.balance - a.balance || compareLaneIds(a.lane.pool, b.lane.pool));
  return [...weekly.map((row) => row.lane), ...credits.map((row) => row.lane)];
}

/** The current window of a wall-clock recurring reset, e.g. weekly Sunday 8:21 PM in a named zone. */
export interface RecurringResetWindow {
  startsAt: string;
  resetAt: string;
}

/**
 * Add `days` wall-clock days to `ms` inside `zone`, so a weekly reset stays on
 * the same local time across daylight-saving changes. Without a zone it is a
 * fixed day count. Returns NaN when the zone or arithmetic fails.
 */
function shiftWallClockDays(ms: number, days: number, zone: string | null): number {
  if (!zone) return ms + days * 86_400_000;
  try {
    const parts = (t: number) => Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
      timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
    }).formatToParts(t).map((p) => [p.type, p.value]));
    const p = parts(ms);
    const target = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day) + days,
      Number(p.hour), Number(p.minute), Number(p.second));
    let candidate = target;
    for (let i = 0; i < 3; i++) {
      const q = parts(candidate);
      candidate += target - Date.UTC(Number(q.year), Number(q.month) - 1, Number(q.day),
        Number(q.hour), Number(q.minute), Number(q.second));
    }
    return candidate;
  } catch {
    return NaN;
  }
}

/**
 * Resolve the window containing `nowMs` for a recurring reset anchored at a
 * known reset instant (for example the Grok Ultra weekly reset, Sunday 8:21 PM
 * America/New_York). The anchor itself is a past or future reset; stepping it
 * by whole wall-clock periods brackets the current window. Returns null when
 * the inputs are malformed or the window cannot be bracketed.
 */
export function recurringResetWindow(anchorIso: string, everyDays: number,
  timezone: string | null, nowMs: number): RecurringResetWindow | null {
  let reset = Date.parse(anchorIso);
  if (!Number.isFinite(reset) || !Number.isFinite(everyDays) || everyDays <= 0 ||
    everyDays > 366 || !Number.isFinite(nowMs)) return null;
  let steps = 0;
  while (steps < 1000) {
    const previous = shiftWallClockDays(reset, -everyDays, timezone);
    if (!Number.isFinite(previous) || previous <= nowMs) break;
    reset = previous;
    steps++;
  }
  while (reset <= nowMs && steps++ < 2000) reset = shiftWallClockDays(reset, everyDays, timezone);
  const start = shiftWallClockDays(reset, -everyDays, timezone);
  if (!Number.isFinite(reset) || !Number.isFinite(start) || start >= reset || start > nowMs || reset <= nowMs) return null;
  return { startsAt: new Date(start).toISOString(), resetAt: new Date(reset).toISOString() };
}

/**
 * Bridge a capacity seat into a calendar pool: the remaining percent comes
 * from the account weekly window (the session window stands in when the
 * provider reports no long one), the reset from that window's machine reset
 * or its qualified provenance. Credit balances are not part of the seat
 * shape; a caller that knows one sets it on the returned entry.
 */
export function resetCalendarPoolForSeat(seat: SeatCapacity, nowMs: number): ResetCalendarPool {
  const rows = seat.windows
    .map((window) => ({ window, cls: classifyWindow(seat.engine, window, nowMs) }))
    .filter((row) => row.cls !== 'model' && row.window.usedPercent !== null);
  const weekly = rows.filter((row) => row.cls === 'weekly');
  const chosen = (weekly.length > 0 ? weekly : rows)
    .sort((a, b) => b.window.usedPercent! - a.window.usedPercent!)[0] ?? null;
  const resetAt = chosen === null ? null : chosen.window.resetsAt ??
    (chosen.window.resetProvenance && validResetProvenance(chosen.window.resetProvenance)
      ? chosen.window.resetProvenance.at : null);
  return {
    pool: seat.seatId,
    resetAt,
    remainingPercent: chosen === null ? null : Math.max(0, 100 - chosen.window.usedPercent!),
  };
}
