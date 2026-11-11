/**
 * Self-maintaining lane usage (RQ-USAGE-SELF-2). Keeps each lane's used percent, limit and reset
 * fresh in the dispatchd status.json `budget` shape (`weekly_used_pct`, `credits_remaining`,
 * `reset_at`, `source`) without a human reading.
 *
 * Per lane, in order:
 *  1. a sanctioned reading (the lane CLI's own status output or a documented endpoint), injected;
 *  2. an estimate from Phantom's own job accounting (metrics/jobs.jsonl `finish` rows) and the
 *     known reset schedule, written with `estimated: true`;
 *  3. unknown (all numbers null), never zero.
 * A reading is re-read when it is missing, estimated, older than `maxAgeMs`, or past `reset_at`.
 * Nothing here opens tokens, keychains, app databases or any ~/.codex* path; sanctioned readers
 * are supplied by the caller and this module only sees their numbers.
 */

export const SELF_LANES = ['claude', 'codex-personal', 'devin', 'zai', 'gemini', 'omlx'] as const;
export type SelfLane = typeof SELF_LANES[number];

/** Fields this module owns inside a lane's budget entry. Every other field is preserved on write. */
export const OWNED_FIELDS = ['weekly_used_pct', 'credits_remaining', 'reset_at', 'source', 'estimated', 'as_of',
  'burn_pct_per_hour', 'unmeasured_jobs'] as const;

export interface BudgetEntry {
  weekly_used_pct: number | null;
  credits_remaining: number | null;
  reset_at: string | null;
  source: string;
  estimated: boolean;
  as_of: string;
  burn_pct_per_hour: number | null;
  unmeasured_jobs?: number;
}

/** What a sanctioned reader returns. Null from the reader means "no reading", never zero. */
export interface SanctionedReading {
  pctUsed: number | null;
  resetAt: string | null;
  /** Remaining allowance in the lane's own unit (ACUs, credits), when the source reports a limit. */
  creditsRemaining?: number | null;
  /** Allowance size in the lane's unit, used to calibrate later estimates. */
  limit?: number | null;
  source: string;
}
export type SanctionedReader = () => Promise<SanctionedReading | null>;

/** Persisted per-lane calibration from the last sanctioned reading. */
export interface LaneState {
  asOf: string;
  pctUsed: number;
  resetAt: string | null;
  /** Accounting units consumed per percentage point, derived from the reading itself. */
  unitsPerPct: number | null;
  limit: number | null;
}
export type SelfState = Partial<Record<SelfLane, LaneState>>;

export interface JobRow {
  event?: unknown; lane?: unknown; ts?: unknown; tier?: unknown;
  tokens_total?: unknown; tokens_in?: unknown; tokens_out?: unknown; tokens_cache_read?: unknown; acus?: unknown;
}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
export const DEFAULT_MAX_AGE_MS = 30 * 60_000;

/** The lane id used in jobs.jsonl for each self lane. */
const JOB_LANE: Record<SelfLane, string> = {
  claude: 'claude', 'codex-personal': 'codex-personal', devin: 'devin', zai: 'zai', gemini: 'gemini', omlx: 'omlx',
};

interface Spec {
  /** Rolling window length for estimates that roll a passed reset forward; null when unknowable. */
  periodMs: number | null;
  unit: 'tokens' | 'acus' | 'zai-credits' | 'none';
}
const SPEC: Record<SelfLane, Spec> = {
  claude: { periodMs: 7 * DAY, unit: 'tokens' },          // weekly all-models window (docs/research/provider-usage-probes.md)
  'codex-personal': { periodMs: 7 * DAY, unit: 'tokens' }, // weekly secondary window
  devin: { periodMs: null, unit: 'acus' },                 // enterprise cycle edges are not fixed-length
  zai: { periodMs: 7 * DAY, unit: 'zai-credits' },         // docs/lanes/zai.md: 10 000 credits per calendar week
  gemini: { periodMs: null, unit: 'none' },                // no verified limit or reader
  omlx: { periodMs: null, unit: 'none' },                  // local capacity, nothing resets
};
/** docs/lanes/zai.md "Included allowance": weekly bucket, resets Monday 00:00 UTC. */
export const ZAI_WEEKLY_CREDITS = 10_000;

const isoOf = (ms: number): string => new Date(ms).toISOString();
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const rowMs = (r: JobRow): number => (typeof r.ts === 'string' ? Date.parse(r.ts.length === 19 ? `${r.ts}Z` : r.ts) : NaN);
const clampPct = (n: number): number => Math.max(0, Math.min(100, Math.round(n * 10) / 10));

/** Most recent Monday 00:00 UTC at or before `ms`. */
export function zaiWeekStart(ms: number): number {
  const d = new Date(ms);
  const day = (d.getUTCDay() + 6) % 7; // Monday = 0
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day);
}

/** Z.ai credit cost of one finished job (docs/lanes/zai.md formulas), or null when counts are missing. */
export function zaiCredits(r: JobRow): number | null {
  const out = r.tokens_out, inn = r.tokens_in;
  if (!finite(out) || !finite(inn)) return null;
  const cacheRead = finite(r.tokens_cache_read) ? Math.min(r.tokens_cache_read, inn) : 0;
  const uncached = inn - cacheRead;
  if (r.tier === 'fast') return (uncached * 2.3 + cacheRead * 0.56 + out * 8) / 1000;
  return (uncached * 6.9 + cacheRead * 1.7 + out * 24) / 10_000;
}

/** Units consumed by one finished job in the lane's accounting unit; null means unmeasured. */
function unitsOf(unit: Spec['unit'], r: JobRow): number | null {
  if (unit === 'tokens') return finite(r.tokens_total) && r.tokens_total >= 0 ? r.tokens_total : null;
  if (unit === 'acus') return finite(r.acus) && r.acus >= 0 ? r.acus : null;
  if (unit === 'zai-credits') return zaiCredits(r);
  return null;
}

/** Sum of lane units for finish rows in [fromMs, toMs); unmeasured rows are counted, never guessed. */
export function consumed(lane: SelfLane, rows: readonly JobRow[], fromMs: number, toMs: number):
{ units: number; unmeasured: number } {
  const spec = SPEC[lane]; let units = 0; let unmeasured = 0;
  for (const r of rows) {
    if (r.event !== 'finish' || r.lane !== JOB_LANE[lane]) continue;
    const t = rowMs(r);
    if (!(t >= fromMs && t < toMs)) continue;
    const u = unitsOf(spec.unit, r);
    if (u === null) unmeasured += 1; else units += u;
  }
  return { units, unmeasured };
}

/** Parse metrics/jobs.jsonl text; malformed lines are skipped. */
export function parseJobRows(text: string): JobRow[] {
  const rows: JobRow[] = [];
  for (const line of text.split('\n')) {
    if (!line.startsWith('{')) continue;
    try { const v = JSON.parse(line) as unknown; if (v && typeof v === 'object') rows.push(v as JobRow); } catch { /* skip */ }
  }
  return rows;
}

/** True when the entry must be re-read: missing, estimated, stale, or past its reset. */
export function needsRead(entry: Partial<BudgetEntry> | undefined, nowMs: number, maxAgeMs = DEFAULT_MAX_AGE_MS): boolean {
  if (!entry || entry.estimated === true) return true;
  const asOf = typeof entry.as_of === 'string' ? Date.parse(entry.as_of) : NaN;
  if (!Number.isFinite(asOf) || nowMs - asOf > maxAgeMs || asOf > nowMs + 60_000) return true;
  const reset = typeof entry.reset_at === 'string' ? Date.parse(entry.reset_at) : NaN;
  return Number.isFinite(reset) && nowMs >= reset;
}

/** State to remember from a sanctioned reading so a later estimate can be calibrated by data, not by guess. */
export function calibrate(lane: SelfLane, reading: SanctionedReading, rows: readonly JobRow[], nowMs: number): LaneState | null {
  if (reading.pctUsed === null) return null;
  const limit = finite(reading.limit) && reading.limit > 0 ? reading.limit : null;
  let unitsPerPct: number | null = limit === null ? null : limit / 100;
  const spec = SPEC[lane];
  const reset = reading.resetAt ? Date.parse(reading.resetAt) : NaN;
  if (unitsPerPct === null && reading.pctUsed >= 1 && spec.periodMs !== null && Number.isFinite(reset)) {
    const { units } = consumed(lane, rows, reset - spec.periodMs, nowMs);
    if (units > 0) unitsPerPct = units / reading.pctUsed;
  }
  return { asOf: isoOf(nowMs), pctUsed: reading.pctUsed, resetAt: reading.resetAt, unitsPerPct, limit };
}

/** Build the budget entry for a sanctioned reading. */
export function entryFromReading(reading: SanctionedReading, nowMs: number): BudgetEntry {
  return {
    weekly_used_pct: reading.pctUsed === null ? null : clampPct(reading.pctUsed),
    credits_remaining: finite(reading.creditsRemaining) ? reading.creditsRemaining : null,
    reset_at: reading.resetAt, source: reading.source, estimated: false, as_of: isoOf(nowMs),
    burn_pct_per_hour: null,
  };
}

/**
 * Estimate from Phantom accounting plus the known reset schedule. Returns null when no honest
 * estimate exists (then the caller writes unknown and the autopilot holds the current target).
 */
export function estimateLane(lane: SelfLane, state: LaneState | undefined, rows: readonly JobRow[], nowMs: number): BudgetEntry | null {
  const spec = SPEC[lane];
  if (spec.unit === 'none') return null;
  const base = { estimated: true, as_of: isoOf(nowMs), burn_pct_per_hour: null as number | null };

  if (lane === 'zai') {
    const start = zaiWeekStart(nowMs); const end = start + 7 * DAY;
    const { units, unmeasured } = consumed(lane, rows, start, nowMs);
    return { ...base, weekly_used_pct: clampPct(units / ZAI_WEEKLY_CREDITS * 100),
      credits_remaining: Math.max(0, Math.round((ZAI_WEEKLY_CREDITS - units) * 10) / 10),
      reset_at: isoOf(end), source: 'estimate:phantom-accounting+zai-schedule', ...(unmeasured ? { unmeasured_jobs: unmeasured } : {}) };
  }
  if (!state) return null;
  const asOf = Date.parse(state.asOf);
  if (!Number.isFinite(asOf) || asOf > nowMs) return null;
  let resetMs = state.resetAt ? Date.parse(state.resetAt) : NaN;
  let windowStart = asOf; let basePct = state.pctUsed;
  let resetOut: string | null = state.resetAt;
  if (Number.isFinite(resetMs) && nowMs >= resetMs) {
    // A passed reset is evidence the window rolled. Roll it by the known period, else the next reset is unknown.
    if (spec.periodMs === null) { resetOut = null; windowStart = resetMs; basePct = 0; }
    else {
      const k = Math.floor((nowMs - resetMs) / spec.periodMs) + 1;
      windowStart = resetMs + (k - 1) * spec.periodMs; resetMs += k * spec.periodMs;
      resetOut = isoOf(resetMs); basePct = 0;
    }
  }
  const { units, unmeasured } = consumed(lane, rows, windowStart, nowMs);
  let pct: number | null;
  if (units === 0) pct = basePct;
  else if (state.unitsPerPct && state.unitsPerPct > 0) pct = basePct + units / state.unitsPerPct;
  else pct = null;
  const used = pct === null ? null : clampPct(pct);
  const credits = state.limit !== null && used !== null ? Math.max(0, Math.round(state.limit * (1 - used / 100) * 100) / 100) : null;
  const hours = (nowMs - asOf) / HOUR;
  const burn = used !== null && hours > 0 && resetOut === state.resetAt ? Math.max(0, Math.round((used - state.pctUsed) / hours * 100) / 100) : null;
  return { ...base, weekly_used_pct: used, credits_remaining: credits, reset_at: resetOut,
    source: 'estimate:phantom-accounting+last-reading', burn_pct_per_hour: burn, ...(unmeasured ? { unmeasured_jobs: unmeasured } : {}) };
}

export interface RefreshInput {
  overrides: Record<string, unknown>;
  state: SelfState;
  rows: readonly JobRow[];
  nowMs: number;
  readers: Partial<Record<SelfLane, SanctionedReader>>;
  lanes?: readonly SelfLane[];
  maxAgeMs?: number;
}
export interface LaneOutcome { lane: SelfLane; action: 'kept' | 'read' | 'estimated' | 'unknown'; entry: BudgetEntry | null }
export interface RefreshResult { overrides: Record<string, unknown>; state: SelfState; outcomes: LaneOutcome[] }

const unknownEntry = (nowMs: number, source: string): BudgetEntry => ({
  weekly_used_pct: null, credits_remaining: null, reset_at: null, source, estimated: false, as_of: isoOf(nowMs), burn_pct_per_hour: null,
});

/**
 * One pass. Pure apart from the injected readers: returns the new overrides (only owned fields of
 * lane entries change) and the new calibration state. A fresh non-estimated entry from any writer
 * (including a human or bot) is kept until it ages out or passes its reset.
 */
export async function refreshLanes(input: RefreshInput): Promise<RefreshResult> {
  const overrides: Record<string, unknown> = { ...input.overrides };
  const state: SelfState = { ...input.state };
  const outcomes: LaneOutcome[] = [];
  for (const lane of input.lanes ?? SELF_LANES) {
    const cur = overrides[lane] && typeof overrides[lane] === 'object' && !Array.isArray(overrides[lane])
      ? overrides[lane] as Record<string, unknown> : undefined;
    if (!needsRead(cur as Partial<BudgetEntry> | undefined, input.nowMs, input.maxAgeMs)) {
      outcomes.push({ lane, action: 'kept', entry: cur as unknown as BudgetEntry }); continue;
    }
    let reading: SanctionedReading | null = null;
    try { reading = (await input.readers[lane]?.()) ?? null; } catch { reading = null; }
    // A reading whose own reset already passed is not current evidence.
    if (reading?.resetAt && Date.parse(reading.resetAt) <= input.nowMs) reading = null;
    let entry: BudgetEntry; let action: LaneOutcome['action'];
    if (reading && (reading.pctUsed !== null || finite(reading.creditsRemaining))) {
      const st = calibrate(lane, reading, input.rows, input.nowMs);
      if (st) state[lane] = st;
      entry = entryFromReading(reading, input.nowMs); action = 'read';
    } else {
      const est = estimateLane(lane, state[lane], input.rows, input.nowMs);
      if (est) { entry = est; action = 'estimated'; }
      else { entry = unknownEntry(input.nowMs, lane === 'gemini' ? 'unknown:no-sanctioned-reader' : 'unknown:no-reading-or-estimate'); action = 'unknown'; }
    }
    // Never replace a still-current typed number with an unknown.
    if (action === 'unknown' && cur && finite(cur['weekly_used_pct']) && typeof cur['reset_at'] === 'string' &&
      Date.parse(cur['reset_at']) > input.nowMs && cur['estimated'] !== true) {
      outcomes.push({ lane, action: 'kept', entry: cur as unknown as BudgetEntry }); continue;
    }
    overrides[lane] = { ...(cur ?? {}), ...entry };
    outcomes.push({ lane, action, entry });
  }
  return { overrides, state, outcomes };
}

/**
 * Autopilot input from a budget entry. Estimated entries count like readings (that is the point:
 * an estimate must not leave a lane held at floor). Entries older than `ttlMs`, with an unparsable
 * time, or without a percent are unknown.
 */
export function budgetEntryQuota(entry: unknown, nowMs: number, ttlMs = 2 * DEFAULT_MAX_AGE_MS):
{ value: { usedPercent: number } | null; asOf: string | null; ttlMs: number } {
  const e = entry && typeof entry === 'object' ? entry as Record<string, unknown> : {};
  const asOf = typeof e['as_of'] === 'string' && Number.isFinite(Date.parse(e['as_of'])) ? e['as_of'] : null;
  const pct = e['weekly_used_pct'];
  if (asOf === null || !finite(pct) || pct < 0 || pct > 100 || Date.parse(asOf) > nowMs + 60_000) return { value: null, asOf, ttlMs };
  return { value: { usedPercent: pct }, asOf, ttlMs };
}
