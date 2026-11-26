/**
 * Usage spend-down history: the resource ledger's per-pool used share over
 * time, so each plan can be checked against the straight line from 0% at
 * window start to 100% at reset.
 *
 * Storage: `<runs>/metrics/usage-history.json`, beside the ledger's other
 * metrics sources. Rows are only ever appended (then aged out after 14
 * days). A reading is skipped when its value and reset time match the
 * pool's previous row, or when it is not newer than that row.
 *
 * Writes happen only when a caller asks the ledger to record
 * (`readResourceLedger({ recordHistory: true })`). Projection is pure.
 */
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { writePrivateFileAtomicallyAsync } from '../util/private-file-write.js';
import { poolLabel, RUNWAY_SPARE_PERCENT, RUNWAY_STARVE_MIN_IDLE_HOURS, RUNWAY_STARVE_MIN_IDLE_SHARE } from '../usage/runway.js';
import type { ResourceLedgerV1 } from './runs-resource-ledger.js';

export const USAGE_HISTORY_SCHEMA = 'fleet.usage-history.v1' as const;
/** Same data over HTTP (leader-api.ts), with an optional `?pool=<name>`. */
export const USAGE_HISTORY_ROUTE = '/api/verse/leader/resources/usage-history';
export const USAGE_HISTORY_MAX_AGE_MS = 14 * 86_400_000;
/** Whole-file bound: 14 days of 5-minute changes for about 14 pools. */
export const USAGE_HISTORY_MAX_ROWS = 56_000;
const MAX_BYTES = 16 * 1024 * 1024;
/** The ledger's used share is the weekly window (`weekly_used_pct`). */
export const USAGE_WINDOW_MS = 7 * 86_400_000;
/** Within this many percentage points of the ideal line reads as on pace. */
export const PACE_BAND_PCT = 5;

export type UsagePace = 'ahead' | 'on pace' | 'behind' | 'unknown';
export interface UsageReading {
  pool: string; used_pct: number; observed_at: string; reset_at: string | null; source: string | null;
}
/** A newest reading older than this says "unknown", never a pace. */
export const USAGE_RUNWAY_STALE_MS = 3 * 3_600_000;
/** With three or more readings, the longer pace looks back this far. */
export const USAGE_RUNWAY_LONG_MS = 6 * 3_600_000;
export type RunwayVerdict = 'runs dry early' | 'on pace' | 'will leave usage unspent' | 'unknown';
/** Will this pool run dry before its reset or leave usage unspent? Measured from consecutive readings only. */
export interface PoolRunwayRead {
  verdict: RunwayVerdict;
  /** Points per hour between the two most recent distinct readings; null when unknown. */
  pace_per_hour: number | null;
  /** Oldest-to-newest pace over the last 6 hours; null unless there are three or more readings in that span. */
  pace_6h_per_hour: number | null;
  /** Hours until 100% at pace_per_hour; null when unknown or the pace is zero. */
  runway_hours: number | null;
  hours_to_reset: number | null;
  /** runs dry early only: hours the pool sits empty before reset. */
  hours_early: number | null;
  /** will leave usage unspent only: projected unused share at reset. */
  unspent_pct: number | null;
  /** Pace that would finish exactly at reset; null when unknown. */
  target_pace_per_hour: number | null;
  /** "slow to X points per hour" or "speed up to X points per hour"; null when on pace or unknown. */
  advice: string | null;
  /** Why the verdict is unknown; null otherwise. */
  reason: string | null;
  /** One plain sentence, e.g. "Claude: 23% used, 45 h to reset, running dry 28 h early at this pace; slow to 1.7 points per hour". */
  sentence: string;
}
export interface UsageResetEvent { at: string; from_pct: number; to_pct: number }
export interface UsagePoint { at: string; used_pct: number }
export interface PoolUsageSeries {
  pool: string;
  pace: UsagePace;
  /** Why pace is unknown, in plain words; null when pace is known. */
  reason: string | null;
  used_pct: number | null;
  observed_at: string | null;
  reset_at: string | null;
  /** reset_at minus one window; null without a reset time. */
  window_start: string | null;
  /** Measured readings of the current window only. One reading is one point, never a line. */
  points: UsagePoint[];
  /** The straight line from 0% at window start to 100% at reset; null without a reset time. */
  ideal: { from: UsagePoint; to: UsagePoint } | null;
  /** Used share the ideal line expects at the latest reading. */
  ideal_pct: number | null;
  /** Resets seen in the stored history, oldest first. */
  resets: UsageResetEvent[];
  /** Runway verdict from the readings above. */
  runway: PoolRunwayRead;
}
export interface UsageHistoryV1 {
  schema: typeof USAGE_HISTORY_SCHEMA; v: 1; generated_at: string;
  source_state: 'healthy' | 'missing' | 'degraded';
  pools: PoolUsageSeries[];
}

const POOL = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const ms = (iso: string | null): number => iso === null ? NaN : Date.parse(iso);
const isoTime = (v: unknown): v is string => typeof v === 'string' && Number.isFinite(Date.parse(v)) && v.length <= 40;
const round1 = (n: number): number => Math.round(n * 10) / 10;

export function usageHistoryPath(runsDir: string): string {
  return join(runsDir, 'metrics', 'usage-history.json');
}

function validRow(v: unknown): v is UsageReading {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
  const r = v as Record<string, unknown>;
  return typeof r.pool === 'string' && POOL.test(r.pool) && typeof r.used_pct === 'number' && Number.isFinite(r.used_pct)
    && r.used_pct >= 0 && r.used_pct <= 1000 && isoTime(r.observed_at) && (r.reset_at === null || isoTime(r.reset_at))
    && (r.source === null || (typeof r.source === 'string' && r.source.length <= 160));
}

/** undefined when the file is absent; null when it is not a small regular JSON file. */
async function readHistoryFile(path: string): Promise<unknown> {
  let handle;
  try { handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); } catch (e) {
    return (e as { code?: unknown }).code === 'ENOENT' ? undefined : null;
  }
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > MAX_BYTES) return null;
    return JSON.parse(await handle.readFile('utf8')) as unknown;
  } catch { return null; } finally { await handle.close().catch(() => undefined); }
}

function lastFor(rows: readonly UsageReading[], pool: string): UsageReading | undefined {
  for (let i = rows.length - 1; i >= 0; i--) if (rows[i]!.pool === pool) return rows[i];
  return undefined;
}

const row = (r: UsageReading): UsageReading =>
  ({ pool: r.pool, used_pct: r.used_pct, observed_at: r.observed_at, reset_at: r.reset_at, source: r.source });

const ownSchema = (raw: unknown): boolean => raw !== null && typeof raw === 'object' && !Array.isArray(raw)
  && (raw as Record<string, unknown>).schema === USAGE_HISTORY_SCHEMA && Array.isArray((raw as Record<string, unknown>).rows);

/** Valid rows within the last 14 days, oldest first. Malformed rows are dropped. */
export function parseUsageHistory(raw: unknown, nowMs: number): UsageReading[] {
  if (!ownSchema(raw)) return [];
  return prune(((raw as { rows: unknown[] }).rows).filter(validRow).map(row), nowMs);
}

function inHistoryWindow(reading: UsageReading, nowMs: number): boolean {
  const observedMs = ms(reading.observed_at);
  return observedMs <= nowMs && observedMs > nowMs - USAGE_HISTORY_MAX_AGE_MS;
}

function prune(rows: UsageReading[], nowMs: number): UsageReading[] {
  return rows.filter(r => inHistoryWindow(r, nowMs))
    .sort((a, b) => ms(a.observed_at) - ms(b.observed_at)).slice(-USAGE_HISTORY_MAX_ROWS);
}

/**
 * Append new readings. A reading is skipped when it is not newer than its
 * pool's last row, or when value and reset time are both unchanged.
 */
export function appendUsageReadings(rows: readonly UsageReading[], readings: readonly UsageReading[], nowMs: number): { rows: UsageReading[]; changed: boolean } {
  const next = prune([...rows], nowMs);
  let changed = next.length !== rows.length;
  for (const reading of readings) {
    if (!validRow(reading) || !inHistoryWindow(reading, nowMs)) continue;
    const last = lastFor(next, reading.pool);
    if (last && (ms(reading.observed_at) <= ms(last.observed_at)
      || (last.used_pct === reading.used_pct && last.reset_at === reading.reset_at))) continue;
    next.push(row(reading));
    changed = true;
  }
  return { rows: next.slice(-USAGE_HISTORY_MAX_ROWS), changed };
}

/** The ledger's current per-pool readings. A pool without a measured share or a reading time is skipped. */
export function ledgerUsageReadings(ledger: ResourceLedgerV1): UsageReading[] {
  return ledger.lanes.flatMap(lane => {
    const at = lane.observation?.asOf ?? lane.quotaEvidence?.statusQuota?.observedAt;
    if (lane.usedPct === null || !isoTime(at)) return [];
    const reading = { pool: lane.lane, used_pct: lane.usedPct, observed_at: new Date(ms(at)).toISOString(),
      reset_at: lane.resetAt === null ? null : new Date(ms(lane.resetAt)).toISOString(), source: lane.source };
    return validRow(reading) ? [reading] : [];
  });
}

/** True when `cur` begins a new window after `prev`. */
function startsWindow(prev: UsageReading, cur: UsageReading): boolean {
  const prevReset = ms(prev.reset_at), curReset = ms(cur.reset_at);
  if (!Number.isFinite(prevReset) || !Number.isFinite(curReset)) return false;
  // A drop with the same or a later reset time, or the old reset passed and a later one is reported.
  return (cur.used_pct < prev.used_pct && curReset >= prevReset)
    || (prevReset <= ms(cur.observed_at) && curReset > prevReset);
}

const pts = (n: number): string => `${Math.round(n * 100) / 100}`;

/**
 * Pure. Pace from consecutive readings of one pool, then whether it runs dry
 * before `resetAt` or leaves usage unspent. Readings before the window start
 * (`resetAt` minus `windowMs`) are ignored; a used share that goes down means
 * the pool was reset, so the series restarts there. A single reading, a stale
 * newest reading, identical values or no reset time is "unknown", never a guess.
 */
export function usageRunway(pool: string, readings: readonly UsagePoint[], resetAt: string | null, nowMs: number, windowMs = USAGE_WINDOW_MS): PoolRunwayRead {
  const name = poolLabel(pool);
  const resetMs = ms(resetAt);
  let series = readings.filter(r => Number.isFinite(ms(r.at)) && ms(r.at) <= nowMs && (!Number.isFinite(resetMs) || ms(r.at) >= resetMs - windowMs))
    .sort((a, b) => ms(a.at) - ms(b.at));
  for (let i = series.length - 1; i > 0; i--) if (series[i]!.used_pct < series[i - 1]!.used_pct) { series = series.slice(i); break; }
  const latest = series.at(-1);
  const hoursToReset = Number.isFinite(resetMs) ? (resetMs - nowMs) / 3_600_000 : null;
  const used = latest ? `${Math.round(latest.used_pct)}% used, ` : '';
  const unknown = (reason: string): PoolRunwayRead => ({ verdict: 'unknown', pace_per_hour: null, pace_6h_per_hour: null, runway_hours: null,
    hours_to_reset: hoursToReset === null ? null : Math.round(hoursToReset * 10) / 10, hours_early: null, unspent_pct: null,
    target_pace_per_hour: null, advice: null, reason, sentence: `${name}: ${used}unknown (${reason})` });
  if (!latest) return unknown('no readings yet');
  if (hoursToReset === null) return unknown('reset time unknown');
  if (hoursToReset <= 0) return unknown('reset passed; waiting for a new reading');
  if (series.length < 2) return unknown('only one reading');
  if (nowMs - ms(latest.at) > USAGE_RUNWAY_STALE_MS) return unknown('latest reading is stale');
  // Newest reading of a flat run is not the change; the first reading at the newest value is.
  let first = series.length - 1;
  while (first > 0 && series[first - 1]!.used_pct === latest.used_pct) first--;
  if (first === 0) return unknown('readings are identical; no pace yet');
  const hours = (a: UsagePoint, b: UsagePoint): number => (ms(b.at) - ms(a.at)) / 3_600_000;
  const pace = (series[first]!.used_pct - series[first - 1]!.used_pct) / hours(series[first - 1]!, series[first]!);
  const recent = series.filter(r => ms(r.at) >= ms(latest.at) - USAGE_RUNWAY_LONG_MS);
  const longPace = recent.length >= 3 && ms(series[first]!.at) > ms(recent[0]!.at)
    ? (series[first]!.used_pct - recent[0]!.used_pct) / hours(recent[0]!, series[first]!) : null;
  const left = Math.max(0, 100 - latest.used_pct);
  const target = left / hoursToReset;
  const runwayHours = pace > 0 ? left / pace : null;
  const early = runwayHours === null ? 0 : hoursToReset - runwayHours;
  const unspent = Math.max(0, left - pace * hoursToReset);
  const verdict: RunwayVerdict = early >= Math.max(RUNWAY_STARVE_MIN_IDLE_HOURS, hoursToReset * RUNWAY_STARVE_MIN_IDLE_SHARE) ? 'runs dry early'
    : unspent >= RUNWAY_SPARE_PERCENT ? 'will leave usage unspent' : 'on pace';
  const advice = verdict === 'runs dry early' ? `slow to ${pts(target)} points per hour`
    : verdict === 'will leave usage unspent' ? `speed up to ${pts(target)} points per hour` : null;
  const claim = verdict === 'runs dry early' ? `running dry ${Math.round(early)} h early at this pace`
    : verdict === 'will leave usage unspent' ? `${Math.round(unspent)}% would go unused at this pace` : 'on pace';
  return { verdict, pace_per_hour: Math.round(pace * 100) / 100, pace_6h_per_hour: longPace === null ? null : Math.round(longPace * 100) / 100,
    runway_hours: runwayHours === null ? null : Math.round(runwayHours * 10) / 10, hours_to_reset: Math.round(hoursToReset * 10) / 10,
    hours_early: verdict === 'runs dry early' ? Math.round(early * 10) / 10 : null,
    unspent_pct: verdict === 'will leave usage unspent' ? Math.round(unspent * 10) / 10 : null,
    target_pace_per_hour: Math.round(target * 100) / 100, advice, reason: null,
    sentence: `${name}: ${used}${Math.round(hoursToReset)} h to reset, ${claim}${advice ? `; ${advice}` : ''}` };
}

/**
 * One pool's current window: measured points, the ideal line and a pace word.
 * `rows` may hold any pools and any order; only `pool` is read.
 */
export function poolUsageSeries(pool: string, rows: readonly UsageReading[], nowMs: number, windowMs = USAGE_WINDOW_MS): PoolUsageSeries {
  const mine = rows.filter(r => r.pool === pool).sort((a, b) => ms(a.observed_at) - ms(b.observed_at));
  const resets: UsageResetEvent[] = [];
  let start = 0;
  for (let i = 1; i < mine.length; i++) {
    if (!startsWindow(mine[i - 1]!, mine[i]!)) continue;
    start = i;
    if (mine[i]!.used_pct < mine[i - 1]!.used_pct) {
      resets.push({ at: mine[i]!.observed_at, from_pct: mine[i - 1]!.used_pct, to_pct: mine[i]!.used_pct });
    }
  }
  const window = mine.slice(start);
  const latest = window.at(-1) ?? null;
  const resetMs = ms(latest?.reset_at ?? null);
  const startMs = resetMs - windowMs;
  const known = Number.isFinite(resetMs);
  const idealAt = (t: number): number => round1(Math.min(100, Math.max(0, (t - startMs) / windowMs * 100)));
  const series: PoolUsageSeries = {
    pool, pace: 'unknown', reason: null, used_pct: latest?.used_pct ?? null, observed_at: latest?.observed_at ?? null,
    reset_at: known ? latest!.reset_at : null, window_start: known ? new Date(startMs).toISOString() : null,
    points: window.map(r => ({ at: r.observed_at, used_pct: r.used_pct })),
    ideal: known ? { from: { at: new Date(startMs).toISOString(), used_pct: 0 }, to: { at: latest!.reset_at!, used_pct: 100 } } : null,
    ideal_pct: known && latest ? idealAt(ms(latest.observed_at)) : null,
    resets,
    runway: usageRunway(pool, window.map(r => ({ at: r.observed_at, used_pct: r.used_pct })), known ? latest!.reset_at : null, nowMs, windowMs),
  };
  if (!latest) return { ...series, reason: 'No readings yet.' };
  if (!known) return { ...series, reason: 'Reset time unknown.' };
  if (resetMs <= nowMs) return { ...series, reason: 'The window reset. Waiting for a new reading.' };
  if (window.length < 2) return { ...series, reason: 'Only one reading in this window.' };
  const gap = latest.used_pct - series.ideal_pct!;
  return { ...series, pace: gap > PACE_BAND_PCT ? 'ahead' : gap < -PACE_BAND_PCT ? 'behind' : 'on pace' };
}

/** Every pool in the history, plus pools only in `current`. Sorted by pool name. */
export function projectUsageHistory(rows: readonly UsageReading[], nowMs: number, current: readonly UsageReading[] = []): PoolUsageSeries[] {
  const all = appendUsageReadings(rows, current, nowMs).rows;
  // Storage dedupes an unchanged reading; show it as the tail point so a flat run reaches its real reading time.
  for (const reading of current) {
    if (!validRow(reading) || !inHistoryWindow(reading, nowMs)) continue;
    const last = lastFor(all, reading.pool);
    if (last && ms(reading.observed_at) > ms(last.observed_at)) all.push(row(reading));
  }
  const pools = [...new Set(all.map(r => r.pool))].sort();
  return pools.map(pool => poolUsageSeries(pool, all, nowMs));
}

let writes: Promise<unknown> = Promise.resolve();

/** Append the ledger's readings to the stored history. Serialized within this process; never throws. */
export function recordLedgerUsage(runsDir: string, ledger: ResourceLedgerV1, nowMs: number): Promise<void> {
  const readings = ledgerUsageReadings(ledger);
  if (!readings.length) return Promise.resolve();
  const run = writes.then(async () => {
    const path = usageHistoryPath(runsDir);
    const raw = await readHistoryFile(path);
    // Never overwrite a file that exists but cannot be read or is not this schema.
    if (raw !== undefined && !ownSchema(raw)) return;
    const next = appendUsageReadings(parseUsageHistory(raw, nowMs), readings, nowMs);
    if (!next.changed) return;
    await mkdir(join(runsDir, 'metrics'), { recursive: true, mode: 0o700 });
    await writePrivateFileAtomicallyAsync(`${path}.${randomUUID()}.tmp`, path,
      `${JSON.stringify({ schema: USAGE_HISTORY_SCHEMA, rows: next.rows })}\n`,
      { anchorPath: runsDir, label: 'usage history', beforePublish: () => undefined });
  }).catch(() => undefined);
  writes = run;
  return run;
}

/** Stored readings for the burn rate (`phm pools`): read-only, empty when the file is absent or damaged. */
export async function readUsageSamples(opts: { runsDir?: string; nowMs?: number } = {}): Promise<UsageReading[]> {
  const runsDir = opts.runsDir ?? join(homedir(), '.ashlr-runs');
  return parseUsageHistory(await readHistoryFile(usageHistoryPath(runsDir)), opts.nowMs ?? Date.now());
}

/** Take a fresh ledger reading (recording it), then project every pool's current window. */
export async function readUsageHistory(opts: { runsDir?: string; now?: () => number; pool?: string } = {}): Promise<UsageHistoryV1> {
  const runsDir = opts.runsDir ?? join(homedir(), '.ashlr-runs');
  const nowMs = (opts.now ?? Date.now)();
  const result: UsageHistoryV1 = { schema: USAGE_HISTORY_SCHEMA, v: 1, generated_at: new Date(nowMs).toISOString(), source_state: 'missing', pools: [] };
  try {
    const { readResourceLedger } = await import('./runs-resource-ledger.js');
    const ledger = await readResourceLedger({ runsDir, now: () => nowMs, recordHistory: true });
    const raw = await readHistoryFile(usageHistoryPath(runsDir));
    const rows = parseUsageHistory(raw, nowMs);
    const current = ledgerUsageReadings(ledger);
    result.pools = projectUsageHistory(rows, nowMs, current).filter(p => opts.pool === undefined || p.pool === opts.pool);
    const damaged = raw !== undefined && !ownSchema(raw);
    result.source_state = damaged || ledger.sources.status === 'degraded' ? 'degraded' : rows.length || current.length ? 'healthy' : 'missing';
  } catch { result.source_state = 'degraded'; }
  return result;
}

const SPARK = '▁▂▃▄▅▆▇█';
const when = (iso: string | null): string => iso === null ? 'unknown'
  : new Date(iso).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

/** Plain words for the reset time: "resets Fri, Nov 20, 4:00 PM (in 2d 3h)". */
export function resetWords(resetAt: string | null, nowMs: number): string {
  const at = ms(resetAt);
  if (!Number.isFinite(at)) return 'reset time unknown';
  if (at <= nowMs) return `reset passed ${when(resetAt)}`;
  const hours = Math.floor((at - nowMs) / 3_600_000);
  const span = hours >= 24 ? `${Math.floor(hours / 24)}d ${hours % 24}h` : hours >= 1 ? `${hours}h` : `${Math.max(1, Math.ceil((at - nowMs) / 60_000))}m`;
  return `resets ${when(resetAt)} (in ${span})`;
}

/** Human lines for the CLI: one line per pool, then its window as a sparkline. */
export function usageHistoryText(snapshot: UsageHistoryV1, nowMs: number): string[] {
  if (!snapshot.pools.length) return [snapshot.source_state === 'degraded' ? 'Usage history unavailable (unknown).' : 'No readings yet.'];
  return [...snapshot.pools.map(p => p.runway.sentence), '', ...snapshot.pools.flatMap(p => {
    const used = p.used_pct === null ? 'unknown' : `${round1(p.used_pct)}% used`;
    const ideal = p.ideal_pct === null ? '' : `, ideal ${p.ideal_pct}%`;
    const head = `${p.pool}: ${used}${ideal}, pace ${p.pace}, ${resetWords(p.reset_at, nowMs)}`;
    const spark = p.points.map(pt => SPARK[Math.min(7, Math.max(0, Math.floor(pt.used_pct / 100 * 8)))]).join('');
    const tail = `  ${p.points.length} reading${p.points.length === 1 ? '' : 's'} this window ${spark}`
      + (p.resets.length ? `; ${p.resets.length} reset${p.resets.length === 1 ? '' : 's'} seen` : '')
      + (p.reason ? `; ${p.reason}` : '');
    return [head, tail];
  })];
}
