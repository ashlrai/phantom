/**
 * Pace of one usage pool against its reset: is it spending so fast it will be empty
 * more than a day early ("ahead"), so slowly that room is left over ("behind"), or about right.
 *
 * `paceVerdict` is pure (no clock, no files). The router, autofill and `phm jobs gaps --propose`
 * use it as advisory pace evidence; only measured exhaustion stops owned loops.
 * Nothing here changes a plan or a bill: it only chooses among pools already included.
 */
import { reservePace } from '../usage/reserve-pace.js';
import { poolLabel } from '../usage/runway.js';
import type { PoolRow } from './pools-view.js';

export const PACE_SCHEMA = 'fleet.pace.v1';
/** A pool empty this many hours before its reset is "ahead". */
export const AHEAD_EMPTY_EARLY_HOURS = 24;
/** A pool that would end its window with at least this share unused is "behind". */
export const BEHIND_UNUSED_PCT = 15;

export type PaceState = 'on-pace' | 'ahead' | 'behind' | 'unknown';

export type PaceInput = Pick<PoolRow, 'id' | 'usedPct' | 'hoursLeft' | 'burnPctPerHour' | 'resetAt'> & {
  observedAt?: string | null; source?: string; headroom?: { slots: number | null; ramBytes?: number; cpuCores?: number };
};

export interface PaceVerdict extends Partial<Omit<ReturnType<typeof reservePace>, 'verdict'>> {
  verdict?: 'ok' | 'over' | 'unknown' | 'free' | 'stale' | 'spent';
  observedAt?: string | null; source?: string; ageHours?: number | null;
  headroom?: PaceInput['headroom'];
  pool: string;
  state: PaceState;
  usedPct: number | null;
  hoursToReset: number | null;
  /** When the pool is empty at the recent rate; null when it lasts past the reset or the rate is unknown. */
  emptyAt: string | null;
  /** Percent of the window per hour that would use exactly what is left by the reset. */
  evenPacePerHour: number | null;
  /** Percent of the window per hour over the recent readings. */
  recentPerHour: number | null;
  resetAt: string | null;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

export function paceVerdict(pool: PaceInput, nowMs: number): PaceVerdict {
  const { usedPct, hoursLeft: hours, burnPctPerHour: recent } = pool;
  const base = { ageHours: pool.observedAt ? Math.max(0, Math.floor((nowMs - Date.parse(pool.observedAt)) / 3_600_000)) : null, observedAt: pool.observedAt, source: pool.source, headroom: pool.headroom, ...reservePace(pool), pool: pool.id, usedPct, hoursToReset: hours, resetAt: pool.resetAt };
  const evidence = poolEvidence(pool, nowMs);
  if (evidence) return { ...base, state: 'unknown', emptyAt: null, evenPacePerHour: null, recentPerHour: null, ...evidence };
  if (usedPct === null || hours === null || hours <= 0 || recent === null || !Number.isFinite(recent)) {
    return { ...base, state: 'unknown', emptyAt: null, evenPacePerHour: null, recentPerHour: recent ?? null };
  }
  const left = Math.max(0, 100 - usedPct);
  const even = round2(left / hours);
  const emptyHours = recent > 0 ? left / recent : Infinity;
  const emptyAt = emptyHours < hours ? new Date(nowMs + emptyHours * 3_600_000).toISOString() : null;
  const state: PaceState = left > 0 && emptyHours < hours - AHEAD_EMPTY_EARLY_HOURS ? 'ahead'
    : left > 0 && left - recent * hours >= BEHIND_UNUSED_PCT ? 'behind' : 'on-pace';
  return { ...base, state, emptyAt, evenPacePerHour: even, recentPerHour: round2(recent) };
}

/** "Sat 4 PM" in the reader's zone. */
const when = (iso: string): string => new Date(iso).toLocaleString('en-US', { weekday: 'short', hour: 'numeric' }).replace(',', '');

/** "claude ahead of pace (empty Sat 4 PM, reset Thu 6 PM)". Only for an ahead pool. */
export function aheadWords(v: PaceVerdict): string {
  const empty = v.emptyAt ? `empty ${when(v.emptyAt)}` : 'empty early';
  return `${v.pool} ahead of pace (${empty}${v.resetAt ? `, reset ${when(v.resetAt)}` : ''})`;
}

/** One plain line per pool for `phm fleet pace`. */
export function paceLine(v: PaceVerdict): string {
  if (v.line) return v.line;
  const label = poolLabel(v.pool);
  if (v.state === 'unknown') return `${label}: unknown (no usable reading)`;
  const rates = `${v.usedPct}% used, ${v.recentPerHour}%/h recent vs ${v.evenPacePerHour}%/h even`;
  const head = v.state === 'ahead' ? aheadWords(v).replace(v.pool, label)
    : v.state === 'behind' ? `${label} behind pace (would end with room left)` : `${label} on pace`;
  return `${head}: ${rates}`;
}

/** The word a screen shows beside a pool: "ahead", "behind", "on pace" or "unknown". */
export const paceWord = (state: PaceState): string => state === 'on-pace' ? 'on pace' : state;

/**
 * One plain sentence for a desktop or phone row: "Claude: 64%, empty about Sat 4 PM, resets Thu 6 PM. Ahead of pace."
 * Only what the verdict holds is said; an unknown pool says so and guesses nothing.
 */
export function paceSentence(v: PaceVerdict): string {
  if (v.line && ['free', 'stale', 'spent'].includes(v.verdict ?? '')) return v.line;
  const label = poolLabel(v.pool);
  if (v.state === 'unknown') return `${label}: unknown, no usable reading.`;
  const parts = [`${Math.round(v.usedPct ?? 0)}%`];
  if (v.state === 'ahead') parts.push(`empty about ${v.emptyAt ? when(v.emptyAt) : 'early'}`);
  if (v.resetAt) parts.push(`resets ${when(v.resetAt)}`);
  const verdict = v.state === 'ahead' ? 'Ahead of pace' : v.state === 'behind' ? 'Behind pace, room left over' : 'On pace';
  return `${label}: ${parts.join(', ')}. ${verdict}.`;
}

export interface FleetPaceV1 { schema: typeof PACE_SCHEMA; generatedAt: string; pools: PaceVerdict[]; gaps: string[] }

/** Verdicts for every pool in a pools view. Pure. */
export function buildFleetPace(view: { generatedAt: string; pools: readonly PaceInput[] }, nowMs: number): FleetPaceV1 {
  return {
    schema: PACE_SCHEMA, generatedAt: view.generatedAt,
    pools: view.pools.map(p => paceVerdict(p, nowMs)).sort((a, b) => a.pool.localeCompare(b.pool)),
    gaps: ['Pool names are matched to lanes of the same name; a lane with no pool row is unknown.'],
  };
}

/** Reads the status budget and usage history, then the verdicts. Read-only. */
export async function readFleetPace(opts: { runsDir?: string; now?: () => number } = {}): Promise<FleetPaceV1> {
  const nowMs = (opts.now ?? Date.now)();
  const [{ readDispatchStatus }, { readUsageSamples }, { burnSeries }, { homedir }, { join }] = await Promise.all([
    import('../usage/spend.js'), import('./usage-history.js'), import('../usage/burn-rate.js'), import('node:os'), import('node:path'),
  ]);
  const runsDir = opts.runsDir ?? process.env.ASHLR_RUNS_DIR ?? join(homedir(), '.ashlr-runs');
  const raw = await readDispatchStatus(join(runsDir, 'queue/status.json'));
  const object = (v: unknown): Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
  const status = object(raw), budget = object(status.budget), samples = await readUsageSamples({ runsDir, nowMs });
  const { readPoolSources } = await import('./pool-evidence.js');
  const tick = Date.parse(String(status.last_tick ?? ''));
  const fresh = tick <= nowMs && nowMs - tick <= 120_000;
  const sources = await readPoolSources(runsDir, budget, fresh ? object(status.lanes) : {}, samples, nowMs, fresh ? tick : null);
  const pools = Object.keys(sources).filter(id => /^[a-z0-9][a-z0-9._-]{0,79}$/.test(id)).map(id => {
    const sample = sources[id]!;
    const usedPct = sample.usedPct;
    const resetMs = Date.parse(sample.resetAt ?? '');
    const resetAt = sample.resetAt;
    const hoursLeft = resetAt ? (resetMs - nowMs) / 3_600_000 : sample.hoursLeft;
    const pair = burnSeries(samples.filter(s => s.pool === id && usedPct !== null && s.used_pct <= usedPct
      && (resetAt === null || s.reset_at !== null && Math.abs(Date.parse(s.reset_at) - resetMs) <= 300_000))
      .map(s => ({ at: s.observed_at, used_pct: s.used_pct, reset_at: s.reset_at })), nowMs).slice(-2);
    const [older, newer] = pair;
    const span = older && newer ? (Date.parse(newer.at) - Date.parse(older.at)) / 3_600_000 : 0;
    const burn = span > 0 && nowMs - Date.parse(newer!.at) <= 3_600_000 ? (newer!.used_pct - older!.used_pct) / span : sample.burnPctPerHour;
    return { ...sample, id, usedPct, hoursLeft, resetAt, burnPctPerHour: burn };
  });
  return buildFleetPace({ generatedAt: new Date(nowMs).toISOString(), pools }, nowMs);
}

/** Verdicts keyed by pool/lane name, or an empty map when the read fails (unknown changes nothing). */
export async function readPaceByPool(opts: { runsDir?: string; now?: () => number } = {}): Promise<Map<string, PaceVerdict>> {
  try { return new Map((await readFleetPace(opts)).pools.map(p => [p.pool, p])); } catch { return new Map(); }
}

/** Special verdicts do not invent a burn rate or infer a refill from an expired record. */
function poolEvidence(p: PaceInput, now: number): Partial<PaceVerdict> | null {
  const age = p.observedAt ? (now - Date.parse(p.observedAt)) / 3_600_000 : NaN;
  if (age > 24) return { verdict: 'stale', ageHours: Math.floor(age), usedPct: null, safeBurnPerHour: null, hoursToEmpty: null, hoursToReset: null,
    line: `${p.id}: stale (${Math.floor(age)}h); refresh the provider reading` };
  if (p.resetAt && Date.parse(p.resetAt) <= now) return { verdict: 'unknown', usedPct: null, hoursToReset: null, safeBurnPerHour: null, hoursToEmpty: null,
    line: `${p.id}: unknown (reset elapsed; refresh the provider reading)` };
  if (p.usedPct !== null && p.usedPct >= 100 && p.hoursLeft !== null && p.hoursLeft > 0 && p.resetAt) return {
    state: 'ahead', emptyAt: new Date(now).toISOString(), verdict: 'spent', safeBurnPerHour: 0, hoursToEmpty: 0, line: `${p.id}: spent until ${p.resetAt}`,
  };
  if (p.headroom) return { state: (p.headroom.slots ?? 0) > 0 ? 'behind' : 'unknown', verdict: p.headroom.slots === null ? 'unknown' : 'free', headroom: p.headroom, source: p.id === 'codex-local' ? 'local RAM/CPU and queue/status.json' : 'queue/status.json lane slots',
    line: `${p.id}: free${p.id === 'codex-local' ? ': local RAM/CPU' : ''}; slot headroom is not billing eligibility; ${p.headroom.slots ?? 'unknown'} slots available${p.headroom.ramBytes === undefined ? '' : `; ${p.headroom.ramBytes} RAM bytes, ${p.headroom.cpuCores?.toFixed(1)} CPU cores available`}` };
  return null;
}
