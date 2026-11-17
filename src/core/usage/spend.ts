/**
 * Spend-down per resource: will each subscription window, credit and gift be
 * spent before it resets or expires? Reads only the dispatchd status file's
 * `budget` block. Unknown stays unknown (null), never zero.
 *
 * This module is in the Tier-1 import closure (test/fixtures/authority/
 * tier1-closure.json): add no imports here without that review.
 */
import { open } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { PACE_POOLS } from './pace.js';

/** behind = a measured share would go unused at reset; sorted first. */
export type SpendVerdict = 'behind' | 'on-pace' | 'used-up' | 'expired' | 'unknown';
export interface SpendRow {
  pool: string;
  /** 'percent' for a subscription window, 'usd' for a credit or gift balance (`budget.<lane>.gift`). */
  unit: 'percent' | 'usd';
  /** Why the verdict is unknown or expired; null when the reading is complete. */
  reason: string | null;
  /** Measured share used now; may exceed 100 when a provider reports overage. */
  usedPercent: number | null;
  /** Window reset, or the credit's expiry. */
  resetAt: string | null;
  hoursLeft: number | null;
  /** Percent per hour, or USD per hour when unit is 'usd'. */
  burnPerHour: number | null;
  projectedUnusedPercent: number | null;
  /** min(100, used + burn x hours left): the second bar. */
  projectedUsedPercent: number | null;
  /** Unspent USD on a credit or gift; null for percent windows. */
  remainingUsd: number | null;
  /** Projected unspent USD at expiry; null for percent windows or when unknown. */
  projectedUnusedUsd: number | null;
  verdict: SpendVerdict;
  /** Plain-words verdict printed as-is by the CLI and the desktop. */
  summary: string;
  /** Countdown to reset or expiry, e.g. "3d 4h"; null when unknown or passed. */
  resetsIn: string | null;
}
export interface SpendSnapshot { v: 1; asOf: string | null; pools: SpendRow[] }

const HOUR_MS = 3_600_000;
/** Keep absent pools visible; legacy and additional recorded pools remain supported. */
const SPEND_POOLS = ['codex-personal', 'codex-cmp', 'claude', 'claude-api', 'devin', 'zai', 'local', ...PACE_POOLS];
/** A gift or credit reading older than a day is stale (matches TYPED_MAX_AGE_MS in resources/lane-autopilot.ts). */
const GIFT_MAX_AGE_MS = 24 * HOUR_MS;
/** Overage readings above this are malformed, not measured. */
const MAX_USED_PCT = 1000;
const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const usd = (v: unknown): number | null => {
  const n = typeof v === 'string' && /^\d+(?:\.\d+)?$/.test(v.trim()) ? Number(v) : v;
  return num(n) && n >= 0 ? n : null;
};
const time = (v: unknown): number => typeof v === 'string' ? Date.parse(v) : num(v) ? v * 1000 : NaN;
const round1 = (n: number): number => Math.round(n * 10) / 10;

export function spendCountdown(hours: number | null): string | null {
  if (hours === null || !(hours > 0)) return null;
  const minutes = Math.floor(hours * 60);
  const d = Math.floor(minutes / 1440); const h = Math.floor(minutes % 1440 / 60); const m = minutes % 60;
  return d > 0 ? `${d}d ${h}h` : h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function blank(pool: string, unit: SpendRow['unit'], reason: string): SpendRow {
  return { pool, unit, reason, usedPercent: null, resetAt: null, hoursLeft: null, burnPerHour: null,
    projectedUnusedPercent: null, projectedUsedPercent: null, remainingUsd: null, projectedUnusedUsd: null,
    verdict: 'unknown', summary: `unknown: ${reason}`, resetsIn: null };
}

function percentRow(pool: string, lane: Record<string, unknown>, fresh: boolean, now: number): SpendRow {
  const pace = object(lane.use_it_all) ? lane.use_it_all : {};
  const reset = time(pace.reset_at);
  const reason = !fresh ? 'status missing or stale' : pace.stale === true ? 'reading stale' : pace.known !== true || pace.stale !== false ? 'reading missing' :
    !num(pace.used_pct) || pace.used_pct < 0 || pace.used_pct > MAX_USED_PCT || !Number.isFinite(reset) || reset <= now ||
    !num(pace.burn_pct_per_hour) || pace.burn_pct_per_hour < 0 ? 'reading incomplete or reset passed' : null;
  if (reason !== null) return blank(pool, 'percent', reason);
  const used = pace.used_pct as number; const burn = pace.burn_pct_per_hour as number;
  const hours = (reset - now) / HOUR_MS;
  const unused = Math.max(0, 100 - used - burn * hours);
  const verdict: SpendVerdict = used >= 100 ? 'used-up' : Math.round(unused) >= 1 ? 'behind' : 'on-pace';
  return { ...blank(pool, 'percent', ''), reason: null, usedPercent: used, resetAt: new Date(reset).toISOString(), hoursLeft: hours,
    burnPerHour: burn, projectedUnusedPercent: unused, projectedUsedPercent: Math.min(100, used + burn * hours), verdict,
    summary: verdict === 'behind' ? `behind: ${Math.round(unused)}% would go unused` : verdict === 'used-up' ? 'used up' : 'on pace',
    resetsIn: spendCountdown(hours) };
}

/**
 * `budget.<lane>.gift`: usd_remaining and as_of are required; usd_granted,
 * expires_at and usd_burn_per_hour each fill in more of the row when present.
 */
function giftRow(pool: string, gift: Record<string, unknown>, fresh: boolean, now: number): SpendRow {
  if (!fresh) return blank(pool, 'usd', 'status missing or stale');
  const remaining = usd(gift.usd_remaining); const asOf = time(gift.as_of);
  if (remaining === null || !Number.isFinite(asOf) || asOf > now + 60_000) return blank(pool, 'usd', 'reading missing');
  if (now - asOf > GIFT_MAX_AGE_MS) return blank(pool, 'usd', 'reading stale');
  const expires = time(gift.expires_at);
  if (Number.isFinite(expires) && expires <= now) {
    return { ...blank(pool, 'usd', 'expired'), resetAt: new Date(expires).toISOString(), verdict: 'expired', summary: 'expired' };
  }
  const grantedRaw = usd(gift.usd_granted);
  const granted = grantedRaw !== null && grantedRaw > 0 && grantedRaw >= remaining ? grantedRaw : null;
  const known = { ...blank(pool, 'usd', ''), remainingUsd: remaining,
    usedPercent: granted === null ? null : round1((granted - remaining) / granted * 100) };
  if (remaining === 0) return { ...known, reason: null, verdict: 'used-up', summary: 'used up' };
  if (!Number.isFinite(expires)) return { ...known, reason: 'expiry date missing', summary: 'unknown: expiry date missing' };
  const hours = (expires - now) / HOUR_MS;
  const dated = { ...known, resetAt: new Date(expires).toISOString(), hoursLeft: hours, resetsIn: spendCountdown(hours) };
  const burn = usd(gift.usd_burn_per_hour);
  if (burn === null) return { ...dated, reason: 'no spend rate', summary: 'unknown: no spend rate' };
  const unusedUsd = Math.max(0, remaining - burn * hours);
  const behind = unusedUsd >= 1;
  const unusedPct = granted === null ? null : unusedUsd / granted * 100;
  return { ...dated, reason: null, burnPerHour: burn, projectedUnusedUsd: round1(unusedUsd), projectedUnusedPercent: unusedPct,
    projectedUsedPercent: unusedPct === null ? null : 100 - unusedPct, verdict: behind ? 'behind' : 'on-pace',
    summary: behind ? `behind: ${Math.round(unusedUsd)} USD would go unused` : 'on pace' };
}

const ORDER: Record<SpendVerdict, number> = { behind: 0, unknown: 1, expired: 2, 'on-pace': 3, 'used-up': 4 };

/** Rows sorted behind-first, then unknown; soonest reset first within a verdict. */
export function projectUsageSpend(raw: unknown, now = Date.now()): SpendSnapshot {
  const status = object(raw) ? raw : {};
  const tick = typeof status.last_tick === 'string' ? Date.parse(status.last_tick) : NaN;
  const fresh = status.schema === 'dispatchd.status.v1' && Number.isFinite(tick) && now >= tick && now - tick <= 120_000;
  const budget = object(status.budget) ? status.budget : {};
  const names = [...new Set([...SPEND_POOLS, ...Object.keys(budget).filter(k => /^[a-z0-9][a-z0-9-]{0,63}$/.test(k))])];
  const pools = names.map(pool => {
    const lane = object(budget[pool]) ? budget[pool] : {};
    return object(lane.gift) || pool === 'claude-api'
      ? giftRow(pool, object(lane.gift) ? lane.gift : {}, fresh, now) : percentRow(pool, lane, fresh, now);
  }).sort((a, b) => ORDER[a.verdict] - ORDER[b.verdict]
    || (a.hoursLeft ?? Infinity) - (b.hoursLeft ?? Infinity) || a.pool.localeCompare(b.pool));
  return { v: 1, asOf: Number.isFinite(tick) ? new Date(tick).toISOString() : null, pools };
}
export async function readUsageSpend(path = join(homedir(), '.ashlr-runs', 'queue', 'status.json')): Promise<SpendSnapshot> {
  try {
    const file = await open(path, 'r');
    try {
      // As in readUsagePace, bound the read itself, including a file that grows.
      const bytes = Buffer.alloc(1024 * 1024 + 1);
      let length = 0;
      while (length < bytes.length) {
        const { bytesRead } = await file.read(bytes, length, bytes.length - length, null);
        if (bytesRead === 0) break;
        length += bytesRead;
      }
      if (length === bytes.length) return projectUsageSpend(null);
      return projectUsageSpend(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length))) as unknown);
    } finally { await file.close(); }
  }
  catch { return projectUsageSpend(null); }
}
