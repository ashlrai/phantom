/**
 * Historical runtime-pool row projection from explicit recorded evidence. Pure:
 * no clock, env, home, file, network, process or model access, and no imports.
 *
 * Recovered from PR #5952 (head 3d6c8fb7c7f7d52655fb3e0f13ef239686f7b886),
 * scheduler/pools.ts runtimePool() and the per-row mapping inside
 * buildRuntimePools(). Preserved: billing/tier/host/concurrency/monetaryCost/
 * preferencePenalty copied through; enabled = enabled && live; ordinary rows
 * keep `remaining` as recorded (null stays null) with estimate = (remaining
 * === null) and estimateSource 'balance unknown' only then; expiresAt/resetAt
 * ISO strings become epoch ms; a weekly row maps the supplied projection
 * (remaining, resetAtMs, resetEveryDays * 86_400_000, extraUsageCredits ->
 * carryover, label -> estimateSource, estimate true, unlimited false,
 * usedToday 0, expiresAtMs null) and headroomPercent = row.headroomPercent ??
 * Math.round(remaining * 100).
 *
 * NOT preserved here (remaining #5952 work): projectUltra, the fixed pool-id
 * list, hostBlocks, loseItUrgency, tierRank, config/defaults loading. poolOpen
 * lives in recorded-pool-availability.ts.
 *
 * Deliberate differences from the source:
 * - Pool ids are free-form historical labels, not the SchedulerPoolId union.
 *   The weekly shape is chosen by a supplied `weekly` projection, not an id.
 * - Every field is required explicitly (no defaults from config). The source
 *   had them from defaults. `remaining`, `expiresAt`, `resetAt` and
 *   `headroomPercent` must be present as a value or an explicit null; a
 *   missing one rejects instead of reading as healthy or unlimited.
 * - Invalid numbers (NaN, infinite, negative where a count/cost, a non-integral
 *   concurrency, a negative balance) and unparsable dates reject. The source
 *   let NaN flow through, and an unparsable date became NaN.
 * - Booleans must be real booleans; the source coerced truthiness.
 * - A weekly projection remaining must lie in [0, 1]. A weekly row ignores the
 *   row's own remaining/usedToday/expiresAt/resetAt/unlimited, as the source
 *   did, and does not validate them.
 * - Duplicate ids in the list wrapper reject; the source's id set was fixed.
 * - Errors name a fixed field path only and never echo supplied values.
 *
 * Results are historical records, not live quota, a reset forecast, billing
 * eligibility or dispatch authority.
 */

import {
  CODING_CLI_BILLING_CLASSES,
  isFiniteNumber,
  isNonEmptyString,
  type CodingCliBillingClass,
} from './validation.js';

const RECORDED_RUNTIME_POOL_PROVENANCE = {
  sourcePr: 5952,
  sourceSha: '3d6c8fb7c7f7d52655fb3e0f13ef239686f7b886',
  sourceFunction: 'runtimePool',
  listFunction: 'buildRuntimePools',
  basis: 'historical-offline',
} as const;

const TIERS = ['local', 'cheap', 'workhorse', 'frontier'] as const;
const HOSTS = ['mac', 'remote'] as const;
const DAY_MS = 86_400_000;

export interface RecordedRuntimePoolRow {
  readonly id: string;
  readonly billing: CodingCliBillingClass;
  readonly tier: (typeof TIERS)[number];
  readonly host: (typeof HOSTS)[number];
  readonly concurrency: number;
  readonly preferencePenalty: number;
  readonly monetaryCost: number;
  readonly unlimited: boolean;
  readonly live: boolean;
  readonly enabled: boolean;
  readonly softCapPerDay: number;
  readonly usedToday: number;
  /** Null is a recorded unknown balance. Undefined rejects. */
  readonly remaining: number | null;
  readonly expiresAt: string | null;
  readonly resetAt: string | null;
  readonly headroomPercent: number | null;
}

/** Already-calculated recorded weekly estimate. Supplied as data, never derived here. */
export interface RecordedWeeklyProjection {
  readonly remaining: number;
  readonly resetAtMs: number;
  readonly resetEveryDays: number;
  readonly extraUsageCredits: boolean;
  readonly label: string;
}

export interface RecordedRuntimePoolInput {
  readonly row: RecordedRuntimePoolRow;
  readonly weekly?: RecordedWeeklyProjection;
}

export interface RecordedRuntimePool {
  readonly id: string;
  readonly billing: RecordedRuntimePoolRow['billing'];
  readonly tier: RecordedRuntimePoolRow['tier'];
  readonly host: RecordedRuntimePoolRow['host'];
  readonly concurrency: number;
  readonly monetaryCost: number;
  readonly preferencePenalty: number;
  readonly unlimited: boolean;
  readonly remaining: number | null;
  readonly usedToday: number;
  readonly softCapPerDay: number;
  readonly expiresAtMs: number | null;
  readonly resetAtMs: number | null;
  readonly resetEveryMs: number | null;
  readonly carryover: boolean;
  readonly headroomPercent: number | null;
  readonly enabled: boolean;
  readonly estimate: boolean;
  readonly estimateSource: string | null;
  readonly provenance: {
    readonly sourcePr: 5952;
    readonly sourceSha: '3d6c8fb7c7f7d52655fb3e0f13ef239686f7b886';
    readonly sourceFunction: 'runtimePool';
    readonly listFunction: 'buildRuntimePools';
    readonly basis: 'historical-offline';
  };
  readonly historicalOnly: true;
  readonly currentAllowanceEvidence: false;
  readonly dispatchAuthority: false;
}

function bad(path: string): never {
  throw new RangeError(`recorded runtime pool: invalid ${path}`);
}

function num(v: unknown, path: string, min: number | null = 0): number {
  if (!isFiniteNumber(v) || (min !== null && v < min)) bad(path);
  return v;
}

function nullableNum(v: unknown, path: string, min: number | null): number | null {
  return v === null ? null : num(v, path, min);
}

function bool(v: unknown, path: string): boolean {
  if (typeof v !== 'boolean') bad(path);
  return v;
}

function oneOf<T extends string>(v: unknown, set: readonly T[], path: string): T {
  if (typeof v !== 'string' || !(set as readonly string[]).includes(v)) bad(path);
  return v as T;
}

function nullableDate(v: unknown, path: string): number | null {
  if (v === null) return null;
  if (typeof v !== 'string') bad(path);
  const ms = Date.parse(v);
  if (!Number.isFinite(ms)) bad(path);
  return ms;
}

function project(input: RecordedRuntimePoolInput, at: string): RecordedRuntimePool {
  const row = input?.row as RecordedRuntimePoolRow | undefined;
  if (typeof row !== 'object' || row === null) return bad(`${at}.row`);
  const p = (f: string): string => `${at}.row.${f}`;
  if (typeof row.id !== 'string' || row.id === '') bad(p('id'));
  const base = {
    id: row.id,
    billing: oneOf(row.billing, CODING_CLI_BILLING_CLASSES, p('billing')),
    tier: oneOf(row.tier, TIERS, p('tier')),
    host: oneOf(row.host, HOSTS, p('host')),
    concurrency: num(row.concurrency, p('concurrency')),
    monetaryCost: num(row.monetaryCost, p('monetaryCost')),
    preferencePenalty: num(row.preferencePenalty, p('preferencePenalty')),
    softCapPerDay: num(row.softCapPerDay, p('softCapPerDay')),
  };
  if (!Number.isInteger(base.concurrency)) bad(p('concurrency'));
  const enabled = bool(row.enabled, p('enabled')) && bool(row.live, p('live'));
  const headroom = nullableNum(row.headroomPercent, p('headroomPercent'), null);
  const tail = {
    provenance: RECORDED_RUNTIME_POOL_PROVENANCE,
    historicalOnly: true,
    currentAllowanceEvidence: false,
    dispatchAuthority: false,
  } as const;

  const w = input.weekly;
  if (w !== undefined) {
    const wp = (f: string): string => `${at}.weekly.${f}`;
    if (typeof w !== 'object' || w === null) bad(`${at}.weekly`);
    const remaining = num(w.remaining, wp('remaining'));
    if (remaining > 1) bad(wp('remaining'));
    const resetAtMs = num(w.resetAtMs, wp('resetAtMs'), null);
    const days = num(w.resetEveryDays, wp('resetEveryDays'));
    if (days <= 0) bad(wp('resetEveryDays'));
    const carryover = bool(w.extraUsageCredits, wp('extraUsageCredits'));
    if (!isNonEmptyString(w.label)) bad(wp('label'));
    return {
      ...base, unlimited: false, remaining, usedToday: 0, expiresAtMs: null, resetAtMs,
      resetEveryMs: days * DAY_MS, carryover,
      headroomPercent: headroom ?? Math.round(remaining * 100),
      enabled, estimate: true, estimateSource: w.label, ...tail,
    };
  }

  const unlimited = bool(row.unlimited, p('unlimited'));
  const usedToday = num(row.usedToday, p('usedToday'));
  if (row.remaining === undefined) bad(p('remaining'));
  const remaining = nullableNum(row.remaining, p('remaining'), 0);
  const expiresAtMs = nullableDate(row.expiresAt, p('expiresAt'));
  const resetAtMs = nullableDate(row.resetAt, p('resetAt'));
  return {
    ...base, unlimited, remaining, usedToday, expiresAtMs, resetAtMs, resetEveryMs: null,
    carryover: true, headroomPercent: headroom, enabled,
    estimate: remaining === null, estimateSource: remaining === null ? 'balance unknown' : null, ...tail,
  };
}

export function recordedRuntimePool(input: RecordedRuntimePoolInput): RecordedRuntimePool {
  return project(input, 'input');
}

/** Caller order preserved; duplicate ids reject. */
export function recordedRuntimePools(inputs: readonly RecordedRuntimePoolInput[]): RecordedRuntimePool[] {
  if (!Array.isArray(inputs)) bad('inputs');
  const seen = new Set<string>();
  return inputs.map((input, i) => {
    const pool = project(input, `inputs[${i}]`);
    if (seen.has(pool.id)) bad(`inputs[${i}].row.id`);
    seen.add(pool.id);
    return pool;
  });
}
