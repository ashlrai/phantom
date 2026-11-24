/**
 * Pool runway: at the measured burn rate, does a subscription window last
 * until it resets?
 *
 *   spend    the window resets with usage left: send filler here.
 *   pace     on track to use it all, right at reset.
 *   starve   it runs dry before reset; the lane then sits idle for `idleHours`.
 *            Keep it for frontier and high-yield work only.
 *   unknown  a needed reading is missing. Never guessed.
 *
 * The use-it-all pacer only asks "will usage go unused?", so a pool at 97%
 * with 59 h to reset reads as low waste risk even though it empties in hours
 * and idles for days. Runway asks both questions.
 *
 * Pure, with no imports: the router (routing/decision-candidates.ts, Tier-1
 * closure) uses it. The dispatchd status reader lives in runway-read.ts.
 */

export const POOL_RUNWAY_SCHEMA = 'pool.runway.v1' as const;
export type RunwayState = 'spend' | 'pace' | 'starve' | 'unknown';
export const RUNWAY_STATES: readonly RunwayState[] = ['spend', 'pace', 'starve', 'unknown'];

/**
 * Projected unused share at reset that counts as spare. Matches the 98% the
 * reset calendar aims for (routing/reset-pressure.ts RESET_TARGET_USED_PERCENT).
 */
export const RUNWAY_SPARE_PERCENT = 2;
/** An idle gap shorter than this (hours, or this share of the time to reset, whichever is larger) is on pace. */
export const RUNWAY_STARVE_MIN_IDLE_HOURS = 1;
export const RUNWAY_STARVE_MIN_IDLE_SHARE = 0.05;

export interface RunwayInput {
  pool: string;
  /** Measured share of the window used now (0-100+); null when unknown. */
  usedPercent: number | null;
  /** Measured percent per hour; null when unknown. 0 means nothing is using it. */
  burnPerHour: number | null;
  /** Hours until the window resets; null when unknown or passed. */
  hoursToReset: number | null;
}

export interface PoolRunway {
  pool: string;
  state: RunwayState;
  usedPercent: number | null;
  burnPerHour: number | null;
  /** Hours until empty at the measured burn. Null when unknown, or when nothing is burning it (never empties). */
  hoursToEmpty: number | null;
  hoursToReset: number | null;
  /** starve only: hours the pool sits empty before reset. */
  idleHours: number | null;
  /** Share projected to go unused at reset; null when unknown. */
  unusedAtResetPercent: number | null;
  /** Burn that would last exactly to reset; null when unknown. */
  safeBurnPerHour: number | null;
  /** What is missing when the state is unknown; null otherwise. */
  reason: string | null;
  /** One plain sentence: what the router should do with this pool. */
  advice: string;
}

export interface RunwaySnapshot {
  schema: typeof POOL_RUNWAY_SCHEMA; v: 1;
  /** The dispatcher tick the readings come from; null when unknown. */
  asOf: string | null;
  headline: string;
  /** starve first (longest idle), then spend (most unused), pace, unknown. */
  pools: PoolRunway[];
  /** Same typed spend-down rows as phm fleet pools; optional for older servers. */
  shares?: PoolShareSnapshot;
}

const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const round1 = (n: number): number => Math.round(n * 10) / 10;
const round2 = (n: number): number => Math.round(n * 100) / 100;
/** "3d 4h", "5h 12m", "40m"; same shape as spend.ts spendCountdown. */
export function runwayHours(hours: number): string {
  if (!(hours > 0)) return 'now';
  const minutes = Math.floor(hours * 60);
  const d = Math.floor(minutes / 1440); const h = Math.floor(minutes % 1440 / 60); const m = minutes % 60;
  return d > 0 ? `${d}d ${h}h` : h > 0 ? `${h}h ${m}m` : `${m}m`;
}
const hoursText = runwayHours;

/** The pure verdict for one pool. A missing reading makes the state unknown; nothing is inferred. */
export function runway(input: RunwayInput): PoolRunway {
  const used = num(input.usedPercent) && input.usedPercent >= 0 ? input.usedPercent : null;
  const burn = num(input.burnPerHour) && input.burnPerHour >= 0 ? input.burnPerHour : null;
  const reset = num(input.hoursToReset) && input.hoursToReset > 0 ? input.hoursToReset : null;
  const base: PoolRunway = { pool: input.pool, state: 'unknown', usedPercent: used, burnPerHour: burn, hoursToEmpty: null,
    hoursToReset: reset === null ? null : round2(reset), idleHours: null, unusedAtResetPercent: null, safeBurnPerHour: null, reason: null, advice: '' };
  const missing = used === null ? 'no usage reading' : reset === null ? 'reset time unknown' : null;
  if (missing !== null) return { ...base, reason: missing, advice: `unknown: ${missing}` };
  const left = Math.max(0, 100 - used!);
  const safe = round2(left / reset!);
  if (left === 0) {
    return { ...base, state: 'starve', hoursToEmpty: 0, idleHours: round2(reset!), unusedAtResetPercent: 0, safeBurnPerHour: 0,
      advice: `used up, idle ${hoursText(reset!)} until reset: send nothing new here` };
  }
  // A full reading with no burn rate is still unknown: we will not guess how fast it drains.
  if (burn === null) return { ...base, safeBurnPerHour: safe, reason: 'no burn rate yet', advice: 'unknown: no burn rate yet' };
  const unused = Math.max(0, left - burn * reset!);
  const known = { ...base, safeBurnPerHour: safe, unusedAtResetPercent: round1(unused) };
  if (burn === 0) return { ...known, state: 'spend', advice: `nothing is using it; ${Math.round(left)}% left: send filler here` };
  const empty = left / burn;
  const idle = reset! - empty;
  if (idle >= Math.max(RUNWAY_STARVE_MIN_IDLE_HOURS, reset! * RUNWAY_STARVE_MIN_IDLE_SHARE)) {
    return { ...known, state: 'starve', hoursToEmpty: round2(empty), idleHours: round2(idle),
      advice: `runs out in ${hoursText(empty)}, ${hoursText(idle)} before reset: frontier and high-yield work only; slow to ${safe}%/h` };
  }
  const timed = { ...known, hoursToEmpty: round2(empty) };
  return unused >= RUNWAY_SPARE_PERCENT
    ? { ...timed, state: 'spend', advice: `${Math.round(unused)}% would go unused at reset: send filler here` }
    : { ...timed, state: 'pace', advice: 'on track to use it all by reset' };
}

/** Frontier work always may use a pool; other work may not use a starving one unless its family measurably merges. */
export function runwayAdmits(state: RunwayState, tier: string, highYield: boolean): boolean {
  return state !== 'starve' || tier === 'frontier' || highYield;
}

const ORDER: Record<RunwayState, number> = { starve: 0, spend: 1, pace: 2, unknown: 3 };

export function runwayHeadline(pools: readonly PoolRunway[]): string {
  const starve = pools.filter(row => row.state === 'starve');
  const spend = pools.filter(row => row.state === 'spend');
  const unknown = pools.filter(row => row.state === 'unknown').length;
  if (starve.length === 0 && spend.length === 0 && pools.every(row => row.state === 'unknown')) {
    return pools.length > 0 && pools.every(row => row.reason === 'status missing or stale')
      ? 'Unknown: the dispatcher status is missing or stale.' : 'Unknown: no pool has a burn rate yet.';
  }
  const parts: string[] = [];
  if (starve.length > 0) parts.push(`${starve.map(row => `${row.pool} runs out ${hoursText(row.idleHours ?? 0)} early`).join(', ')}: frontier work only there`);
  if (spend.length > 0) parts.push(`send filler to ${spend.map(row => row.pool).join(', ')}`);
  if (parts.length === 0) parts.push('Every measured pool is on pace');
  const sentence = parts.join('; ');
  return `${sentence[0]!.toUpperCase()}${sentence.slice(1)}${unknown > 0 ? `; ${unknown} unknown` : ''}.`;
}

export function sortRunways(pools: readonly PoolRunway[]): PoolRunway[] {
  return [...pools].sort((a, b) => ORDER[a.state] - ORDER[b.state]
    || (a.state === 'starve' ? (b.idleHours ?? 0) - (a.idleHours ?? 0) : 0)
    || (a.state === 'spend' ? (b.unusedAtResetPercent ?? 0) - (a.unusedAtResetPercent ?? 0) : 0)
    || a.pool.localeCompare(b.pool));
}

/** Wire guard for clients: a reply that is not pool.runway.v1 is treated as unknown, never rendered. */
export function isRunwaySnapshot(value: unknown): value is RunwaySnapshot {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as Partial<RunwaySnapshot>;
  return v.schema === POOL_RUNWAY_SCHEMA && v.v === 1 && typeof v.headline === 'string' && Array.isArray(v.pools)
    && v.pools.every(row => row !== null && typeof row === 'object' && typeof row.pool === 'string'
      && RUNWAY_STATES.includes(row.state) && typeof row.advice === 'string');
}

/**
 * Pool share: which pool should take the next job. Same ledger readings as
 * runway() (used percent, burn percent per hour, hours to reset), with the
 * fleet's plain thresholds:
 *
 *   starving  runs dry before 80% of the time to reset has passed: top-priority work only.
 *   wasting   projected use at reset is under 90%: send new work here first.
 *   on_pace   neither.
 *   unknown   any reading is missing, or the reset time has already passed. Never guessed.
 */
export const POOL_SHARE_SCHEMA = 'fleet.pools.v1' as const;
export type PoolShareState = 'starving' | 'wasting' | 'on_pace' | 'unknown';
export const POOL_SHARE_STATES: readonly PoolShareState[] = ['wasting', 'on_pace', 'starving', 'unknown'];
export const POOL_STARVING_RUNWAY_SHARE = 0.8;
export const POOL_WASTING_PROJECTED_PERCENT = 90;

export interface PoolShareInput {
  pool: string;
  resetAt?: string | null;
  unit?: 'percent' | 'usd';
  remainingUsd?: number | null;
  reason?: string | null;
  usedPercent: number | null;
  burnPerHour: number | null;
  hoursToReset: number | null;
}

export interface PoolShare {
  pool: string;
  reset_at: string | null;
  /** Percent of the allowance per hour, including gifts with a known grant. */
  burn_pct_per_hour: number | null;
  unit: 'percent' | 'usd';
  remaining_usd: number | null;
  /** Plain words, shared by the CLI and desktop/phone. */
  verdict: string;
  /** Hours until empty at the measured burn; null when unknown or when nothing burns it (never empties). */
  runway_hours: number | null;
  /** As read; zero or negative means the reset already passed (state unknown). */
  hours_to_reset: number | null;
  /** 0-100+, as read; null when missing. */
  used_percent: number | null;
  /** used + burn x hours to reset, capped at 100; null when unknown. */
  projected_percent_at_reset: number | null;
  state: PoolShareState;
  /** Share (0-1) of new non-urgent work this pool should take; 0 when starving; null when unknown. */
  suggested_share: number | null;
  /** 1 = send the next job here. Wasting first, then on pace, then starving; unknown last. */
  rank: number;
  /** What is missing when unknown; null otherwise. */
  reason: string | null;
  /** One plain line, e.g. "Claude: 99% left, resets in 50 h, send work here". */
  line: string;
}

export interface PoolShareSnapshot {
  schema: typeof POOL_SHARE_SCHEMA;
  asOf: string | null;
  /** The pool that should take the next ordinary job; null when no pool is known to have room. */
  next_pool: string | null;
  pools: PoolShare[];
}

/** "codex-personal" -> "Codex personal". */
export function poolLabel(pool: string): string {
  if (pool === 'claude-api') return 'Claude API';
  const words = pool.replace(/[-_]+/g, ' ').trim();
  return words ? `${words[0]!.toUpperCase()}${words.slice(1)}` : pool;
}

const SHARE_ORDER: Record<PoolShareState, number> = { wasting: 0, on_pace: 1, starving: 2, unknown: 3 };
const wholeHours = (n: number): string => `${Math.max(0, Math.round(n))} h`;

/**
 * Pure: one verdict per pool and a suggested share of new work. Wasting pools
 * split new work by the room they would leave unused; on-pace pools take what
 * is left of that room (an equal split when no pool has room); starving pools
 * take only top-priority work (share 0). Rows come back ranked.
 */
export function planPoolShares(inputs: readonly PoolShareInput[]): PoolShare[] {
  const rows = inputs.map(input => {
    const used = num(input.usedPercent) && input.usedPercent >= 0 ? input.usedPercent : null;
    const burn = num(input.burnPerHour) && input.burnPerHour >= 0 ? input.burnPerHour : null;
    const hours = num(input.hoursToReset) ? input.hoursToReset : null;
    const reason = input.reason ?? (used === null ? 'no usage reading' : burn === null ? 'no burn rate yet'
      : hours === null ? 'reset time unknown' : hours <= 0 ? 'reset already passed; waiting for a new reading' : null);
    const base = { pool: input.pool, reset_at: input.resetAt ?? null, burn_pct_per_hour: burn,
      unit: input.unit ?? 'percent', remaining_usd: input.remainingUsd ?? null, runway_hours: null as number | null, hours_to_reset: hours === null ? null : round1(hours),
      used_percent: used === null ? null : round1(used), projected_percent_at_reset: null as number | null };
    if (reason !== null) return { ...base, state: 'unknown' as PoolShareState, reason, room: 0 };
    const left = Math.max(0, 100 - used!);
    const runwayHours = burn! > 0 ? left / burn! : left === 0 ? 0 : null;
    const projected = Math.min(100, used! + burn! * hours!);
    const state: PoolShareState = runwayHours !== null && runwayHours < hours! * POOL_STARVING_RUNWAY_SHARE ? 'starving'
      : projected < POOL_WASTING_PROJECTED_PERCENT ? 'wasting' : 'on_pace';
    return { ...base, runway_hours: runwayHours === null ? null : round1(runwayHours), projected_percent_at_reset: round1(projected),
      state, reason: null, room: state === 'starving' ? 0 : 100 - projected };
  });
  const open = rows.filter(row => row.state === 'wasting' || row.state === 'on_pace');
  const room = open.reduce((sum, row) => sum + row.room, 0);
  const ranked = [...rows].sort((a, b) => SHARE_ORDER[a.state] - SHARE_ORDER[b.state]
    || b.room - a.room || (b.runway_hours ?? 0) - (a.runway_hours ?? 0) || a.pool.localeCompare(b.pool));
  return ranked.map(({ room: own, ...row }, index) => {
    const share = row.state === 'unknown' ? null : row.state === 'starving' ? 0
      : room > 0 ? round2(own / room) : round2(1 / open.length);
    const name = poolLabel(row.pool);
    const left = row.used_percent === null ? '' : `${Math.max(0, Math.round(100 - row.used_percent))}% left, `;
    const resets = row.hours_to_reset === null || row.hours_to_reset <= 0 ? '' : `resets in ${wholeHours(row.hours_to_reset)}, `;
    const line = row.state === 'unknown' ? `${name}: unknown (${row.reason})`
      : row.state === 'wasting' ? `${name}: ${left}${resets}send work here`
        : row.state === 'on_pace' ? `${name}: ${left}${resets}on pace, normal work`
          : `${name}: ${left}runs dry in ${wholeHours(row.runway_hours ?? 0)}, ${resets}top-priority work only`;
    const early = Math.max(0, (row.hours_to_reset ?? 0) - (row.runway_hours ?? 0));
    const verdict = row.state === 'unknown' ? `unknown: ${row.reason === 'no usage reading' ? 'no reading' : row.reason}`
      : row.state === 'starving' ? `will run dry ${early >= 24 ? `${Math.round(early / 24)} days` : `${Math.round(early)} hours`} early`
        : row.state === 'wasting' ? `will waste ${Math.round(100 - row.projected_percent_at_reset!)}%` : 'on pace';
    return { ...row, verdict, suggested_share: share, rank: index + 1, line };
  });
}

export function poolShareSnapshot(inputs: readonly PoolShareInput[], asOf: string | null): PoolShareSnapshot {
  const pools = planPoolShares(inputs);
  return { schema: POOL_SHARE_SCHEMA, asOf, next_pool: pools.find(row => (row.suggested_share ?? 0) > 0)?.pool ?? null, pools };
}

/** One sentence for the CLI and compact desktop/phone rows. */
export function poolSpendLine(row: PoolShare): string {
  const pct = (n: number | null) => n === null ? 'unknown' : `${Number(n.toFixed(2))}%`;
  const reset = row.reset_at === null ? 'unknown' : `${row.hours_to_reset} h (${row.reset_at})`;
  return `${poolLabel(row.pool)}${row.unit === 'usd' ? ' gift' : ''}: ${row.verdict} · ${pct(row.used_percent)} used · ${pct(row.burn_pct_per_hour)}/h · ${pct(row.projected_percent_at_reset)} at reset · ${row.unit === 'usd' ? 'expires' : 'resets'} in ${reset}`;
}
