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

function prune(rows: UsageReading[], nowMs: number): UsageReading[] {
  return rows.filter(r => ms(r.observed_at) <= nowMs && ms(r.observed_at) > nowMs - USAGE_HISTORY_MAX_AGE_MS)
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
    if (!validRow(reading) || ms(reading.observed_at) > nowMs || ms(reading.observed_at) <= nowMs - USAGE_HISTORY_MAX_AGE_MS) continue;
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
    const at = lane.observation?.asOf ?? lane.quotaEvidence?.statusQuota?.observedAt ?? ledger.asOf;
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
    const last = lastFor(all, reading.pool);
    if (last && ms(reading.observed_at) > ms(last.observed_at) && validRow(reading)) all.push(row(reading));
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
  return snapshot.pools.flatMap(p => {
    const used = p.used_pct === null ? 'unknown' : `${round1(p.used_pct)}% used`;
    const ideal = p.ideal_pct === null ? '' : `, ideal ${p.ideal_pct}%`;
    const head = `${p.pool}: ${used}${ideal}, pace ${p.pace}, ${resetWords(p.reset_at, nowMs)}`;
    const spark = p.points.map(pt => SPARK[Math.min(7, Math.max(0, Math.floor(pt.used_pct / 100 * 8)))]).join('');
    const tail = `  ${p.points.length} reading${p.points.length === 1 ? '' : 's'} this window ${spark}`
      + (p.resets.length ? `; ${p.resets.length} reset${p.resets.length === 1 ? '' : 's'} seen` : '')
      + (p.reason ? `; ${p.reason}` : '');
    return [head, tail];
  });
}
