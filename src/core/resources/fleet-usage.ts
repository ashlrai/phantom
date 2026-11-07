/**
 * Read-only fleet resource feed: `fleet-usage.v1`.
 *
 * Normalizes dispatchd's queue/status.json, the Z.ai usage events, the Gemini
 * daily pacer state and the claude-api budget fields into one numeric row per
 * lane and quota window. Nothing here writes, shells out or opens the network.
 *
 * Only numbers, booleans, enum labels and ISO timestamps are emitted. File text
 * (source strings, lane labels beyond a strict name pattern, errors) is never
 * echoed, and no key or token field is ever read. A missing or malformed
 * source yields a `known: false` row; this module never throws.
 *
 * Note on reuse: the RESOURCEBAR (#2823) and PROVIDERCARDS (#2895) types are not
 * on master, so the types below are the single definition until they land.
 */
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const FLEET_USAGE_SCHEMA = 'fleet-usage.v1' as const;
export const VERSE_APP_FLEET_USAGE_PATH = '/api/app/fleet-usage';

export type FleetUsageWindow = '5h' | '7d' | 'daily' | 'weekly' | 'credits' | 'none';
export type FleetUsageUnit = 'percent' | 'credits' | 'requests' | 'usd';
export type WasteRisk = 'low' | 'medium' | 'high';
export type FleetUsageSource = 'queue/status.json' | 'queue/zai.usage.json' | 'queue/gemini.pacer.json' | 'none';

export interface FleetUsageLane {
  lane: string;
  provider: 'anthropic' | 'openai' | 'zai' | 'google' | 'other';
  /** False when the source file is missing or unreadable; numeric fields are then null. */
  known: boolean;
  quota_unit: FleetUsageUnit;
  used: number | null;
  limit: number | null;
  remaining: number | null;
  window: FleetUsageWindow;
  reset_at: string | null;
  seconds_to_reset: number | null;
  running: number | null;
  target: number | null;
  ceiling: number | null;
  held: boolean | null;
  queued: number | null;
  burn_per_hour: number | null;
  projected_used_at_reset: number | null;
  projected_unused_at_reset: number | null;
  waste_risk: WasteRisk;
  overage_costs_money: boolean;
  source: FleetUsageSource;
  /** Source older than 24h. False when the source is missing (see `known`). */
  stale: boolean;
}

export interface FleetUsageV1 {
  schema: typeof FLEET_USAGE_SCHEMA;
  generated_at: string;
  lanes: FleetUsageLane[];
}

export interface FleetUsageOptions {
  runsDir?: string;
  now?: () => number;
}

/** Z.ai Lite plan: 2,000 credits per rolling 5h, 10,000 per rolling 7d. */
export const ZAI_LITE_LIMITS = { fiveHour: 2_000, sevenDay: 10_000 } as const;
/** Gemini free-tier pacer: 1,000 requests per day. */
export const GEMINI_DAILY_LIMIT = 1_000;
export const STALE_AFTER_MS = 24 * 3_600_000;

const HOUR_MS = 3_600_000;
const MAX_BYTES = 1024 * 1024;
const MAX_EVENTS = 100_000;
const LANE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
/** Lanes always reported, so a missing source shows up as unknown rather than absent. */
const ALWAYS_LANES = ['claude-api'] as const;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => v !== null && typeof v === 'object' && !Array.isArray(v);
const num = (v: unknown): number | null => typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
const bool = (v: unknown): boolean | null => typeof v === 'boolean' ? v : null;
const round = (n: number): number => Math.round(n * 1000) / 1000;

/** Epoch seconds, epoch ms or ISO string to epoch ms. */
function toMs(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v) && v > 0) return v < 1e11 ? v * 1000 : v;
  if (typeof v === 'string' && /^\d{4}-\d\d-\d\dT/.test(v)) {
    const ms = Date.parse(v);
    return Number.isFinite(ms) ? ms : null;
  }
  return null;
}

interface SourceRead { data: unknown; mtimeMs: number }

/** Bounded, symlink-refusing JSON read. Any failure reads as null. */
async function readJson(path: string): Promise<SourceRead | null> {
  let file;
  try { file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); } catch { return null; }
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > MAX_BYTES) return null;
    const bytes = Buffer.alloc(info.size);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    return { data: JSON.parse(bytes.subarray(0, offset).toString('utf8')) as unknown, mtimeMs: info.mtimeMs };
  } catch { return null; } finally { await file.close().catch(() => undefined); }
}

function providerOf(lane: string): FleetUsageLane['provider'] {
  if (lane === 'claude' || lane.startsWith('claude-')) return 'anthropic';
  if (lane === 'codex' || lane.startsWith('codex-')) return 'openai';
  if (lane === 'zai' || lane.startsWith('zai-')) return 'zai';
  if (lane === 'gemini' || lane.startsWith('gemini-')) return 'google';
  return 'other';
}

/** Row with every measurement unknown; callers overwrite what the source provides. */
function blank(lane: string, source: FleetUsageSource): FleetUsageLane {
  return {
    lane, provider: providerOf(lane), known: false, quota_unit: 'percent',
    used: null, limit: null, remaining: null, window: 'none', reset_at: null, seconds_to_reset: null,
    running: null, target: null, ceiling: null, held: null, queued: null,
    burn_per_hour: null, projected_used_at_reset: null, projected_unused_at_reset: null,
    waste_risk: 'low', overage_costs_money: lane === 'claude-api', source, stale: false,
  };
}

function setReset(row: FleetUsageLane, resetMs: number | null, now: number): void {
  if (resetMs === null) return;
  row.reset_at = new Date(resetMs).toISOString();
  row.seconds_to_reset = Math.max(0, Math.round((resetMs - now) / 1000));
}

/**
 * Projection to the end of the window. `horizonMs` is the time over which the
 * current burn keeps running; `capacity` is what could be consumed in total.
 * Waste is the share of capacity that expires unused.
 */
function project(row: FleetUsageLane, horizonMs: number | null, capacity: number | null): void {
  if (row.burn_per_hour === null || horizonMs === null || capacity === null || capacity <= 0) return;
  const base = row.used ?? 0;
  const used = Math.min(capacity, base + row.burn_per_hour * (horizonMs / HOUR_MS));
  row.projected_used_at_reset = round(used);
  const unused = Math.max(0, capacity - used);
  row.projected_unused_at_reset = round(unused);
  const share = unused / capacity;
  row.waste_risk = share >= 0.5 ? 'high' : share >= 0.2 ? 'medium' : 'low';
}

function applyLaneCounts(row: FleetUsageLane, l: Obj): void {
  row.running = num(l.running);
  row.target = num(l.target);
  row.ceiling = num(l.ceiling);
  row.queued = num(l.queued);
  row.held = bool(l.held);
}

// ---------------------------------------------------------------------------
// queue/status.json (dispatchd.status.v1)
// ---------------------------------------------------------------------------

function statusRows(read: SourceRead | null, now: number): FleetUsageLane[] {
  const rows: FleetUsageLane[] = [];
  const data = read?.data;
  const lanesObj = isObj(data) && isObj(data.lanes) ? data.lanes : {};
  const budget = isObj(data) && isObj(data.budget) ? data.budget : {};
  const asOf = isObj(data) ? toMs(data.last_tick) ?? read?.mtimeMs ?? null : null;
  const names = new Set<string>([...Object.keys(lanesObj), ...Object.keys(budget), ...(read ? ALWAYS_LANES : [])]);
  for (const lane of names) {
    if (!LANE_NAME.test(lane) || lane === 'zai' || lane === 'gemini') continue;
    const l = isObj(lanesObj[lane]) ? lanesObj[lane] : {};
    const b = isObj(budget[lane]) ? budget[lane] : {};
    const row = blank(lane, 'queue/status.json');
    row.known = read !== null && (lane in lanesObj || lane in budget);
    row.stale = asOf !== null && now - asOf > STALE_AFTER_MS;
    applyLaneCounts(row, l);
    const pct = num(b.weekly_used_pct);
    const credits = num(b.credits_remaining);
    row.burn_per_hour = num(b.burn_per_hour) ?? num(b.burn_pct_per_hour);
    const resetMs = toMs(b.reset_at);
    setReset(row, resetMs, now);
    const horizon = resetMs === null ? null : Math.max(0, resetMs - now);
    if (lane === 'claude-api') {
      // Metered API credits: remaining dollars, no fixed window.
      row.quota_unit = 'usd';
      row.window = credits !== null ? 'credits' : 'none';
      row.remaining = credits;
      project(row, horizon, credits);
    } else if (pct !== null) {
      row.quota_unit = 'percent';
      row.window = 'weekly';
      row.used = pct;
      row.limit = 100;
      row.remaining = Math.max(0, 100 - pct);
      project(row, horizon, 100);
    } else if (credits !== null) {
      row.quota_unit = 'credits';
      row.window = 'credits';
      row.remaining = credits;
      project(row, horizon, credits);
    }
    rows.push(row);
  }
  return rows;
}

// ---------------------------------------------------------------------------
// queue/zai.usage.json: events [ts, credits] + reserved
// ---------------------------------------------------------------------------

function zaiRows(read: SourceRead | null, counts: Obj, now: number): FleetUsageLane[] {
  const windows = [
    { window: '5h' as const, ms: 5 * HOUR_MS, limit: ZAI_LITE_LIMITS.fiveHour },
    { window: '7d' as const, ms: 7 * 24 * HOUR_MS, limit: ZAI_LITE_LIMITS.sevenDay },
  ];
  const data = read?.data;
  const rawEvents = isObj(data) && Array.isArray(data.events) ? data.events.slice(-MAX_EVENTS) : null;
  const events: { ms: number; credits: number }[] = [];
  for (const e of rawEvents ?? []) {
    const ms = Array.isArray(e) ? toMs(e[0]) : null;
    const credits = Array.isArray(e) ? num(e[1]) : null;
    if (ms !== null && credits !== null && ms <= now) events.push({ ms, credits });
  }
  const reserved = isObj(data) ? num(data.reserved) ?? 0 : 0;
  const lastMs = events.reduce((m, e) => Math.max(m, e.ms), 0);
  const asOf = read ? Math.max(read.mtimeMs, lastMs) : null;
  return windows.map(w => {
    const row = blank('zai', 'queue/zai.usage.json');
    applyLaneCounts(row, counts);
    row.quota_unit = 'credits';
    row.window = w.window;
    row.limit = w.limit;
    row.stale = asOf !== null && now - asOf > STALE_AFTER_MS;
    if (rawEvents === null) return row;
    const inWindow = events.filter(e => e.ms > now - w.ms);
    // Reserved credits are held for in-flight jobs, so they count against the window.
    const used = inWindow.reduce((s, e) => s + e.credits, 0) + reserved;
    row.known = true;
    row.used = round(used);
    row.remaining = round(Math.max(0, w.limit - used));
    // Rolling window: capacity starts coming back when the oldest event ages out.
    const oldest = inWindow.reduce<number | null>((m, e) => m === null ? e.ms : Math.min(m, e.ms), null);
    setReset(row, oldest === null ? null : oldest + w.ms, now);
    // Burn: average credits per hour over the last 5h of events.
    row.burn_per_hour = round(events.filter(e => e.ms > now - 5 * HOUR_MS).reduce((s, e) => s + e.credits, 0) / 5);
    // Steady state: events age out as new ones land, so project one full window
    // of the current pace on its own (reserved credits are a transient hold).
    const probe = { ...row, used: 0 } as FleetUsageLane;
    project(probe, w.ms, w.limit);
    row.projected_used_at_reset = probe.projected_used_at_reset;
    row.projected_unused_at_reset = probe.projected_unused_at_reset;
    row.waste_risk = probe.waste_risk;
    return row;
  });
}

// ---------------------------------------------------------------------------
// queue/gemini.pacer.json: daily request counter
// ---------------------------------------------------------------------------

function geminiRow(read: SourceRead | null, counts: Obj, now: number): FleetUsageLane {
  const row = blank('gemini', 'queue/gemini.pacer.json');
  applyLaneCounts(row, counts);
  row.quota_unit = 'requests';
  row.window = 'daily';
  row.limit = GEMINI_DAILY_LIMIT;
  const d = read?.data;
  if (!isObj(d)) return row;
  row.stale = now - read!.mtimeMs > STALE_AFTER_MS;
  row.known = true;
  const limit = num(d.limit) ?? GEMINI_DAILY_LIMIT;
  row.limit = limit;
  const nextMidnight = Math.floor(now / 86_400_000) * 86_400_000 + 86_400_000;
  const resetMs = toMs(d.reset_at) ?? nextMidnight;
  // A counter that belongs to an earlier day has rolled over.
  const today = new Date(now).toISOString().slice(0, 10);
  const counterDay = typeof d.date === 'string' ? d.date : typeof d.day === 'string' ? d.day : null;
  const rolled = (counterDay !== null && counterDay < today) || resetMs <= now;
  const used = rolled ? 0 : num(d.used) ?? num(d.count) ?? num(d.requests) ?? 0;
  row.used = used;
  row.remaining = Math.max(0, limit - used);
  setReset(row, rolled && resetMs <= now ? nextMidnight : resetMs, now);
  const resetAt = Date.parse(row.reset_at ?? '');
  // Burn over the elapsed share of today (UTC) once any requests were seen.
  const dayStart = nextMidnight - 86_400_000;
  const elapsedH = Math.max(1, (now - dayStart) / HOUR_MS);
  row.burn_per_hour = round(used / elapsedH);
  project(row, Number.isFinite(resetAt) ? Math.max(0, resetAt - now) : null, limit);
  return row;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export function defaultRunsDir(): string {
  return process.env.ASHLR_RUNS_DIR ?? join(homedir(), '.ashlr-runs');
}

/** Never throws: every source failure degrades to `known: false`. */
export async function readFleetUsage(opts: FleetUsageOptions = {}): Promise<FleetUsageV1> {
  const now = (opts.now ?? Date.now)();
  const queue = join(opts.runsDir ?? defaultRunsDir(), 'queue');
  const [status, zai, gemini] = await Promise.all([
    readJson(join(queue, 'status.json')),
    readJson(join(queue, 'zai.usage.json')),
    readJson(join(queue, 'gemini.pacer.json')),
  ]);
  const lanes = [
    ...statusRows(status, now),
    ...zaiRows(zai, statusCounts(status, 'zai'), now),
    geminiRow(gemini, statusCounts(status, 'gemini'), now),
  ].sort((a, b) => a.lane < b.lane ? -1 : a.lane > b.lane ? 1 : a.window < b.window ? -1 : a.window > b.window ? 1 : 0);
  return { schema: FLEET_USAGE_SCHEMA, generated_at: new Date(now).toISOString(), lanes };
}

/** running/target/ceiling/held/queued for a lane whose quota comes from another file. */
function statusCounts(status: SourceRead | null, lane: string): Obj {
  const d = status?.data;
  const l = isObj(d) && isObj(d.lanes) ? d.lanes[lane] : undefined;
  return isObj(l) ? l : {};
}
