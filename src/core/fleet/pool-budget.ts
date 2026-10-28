/** Value-free pool observations. This ledger is advisory, never dispatch authority. */
export const BUDGET_POOLS = ['codex-cmp', 'codex-personal', 'devin', 'claude', 'grok-build', 'local-omlx', 'grok-ultra'] as const;
export type BudgetPool = typeof BUDGET_POOLS[number];
export type BudgetBucket = 'weeklyPct' | 'credits' | 'acus' | 'capacity';
export type BudgetSource = 'cli' | 'log' | 'manual';
export interface BudgetReading {
  pool: BudgetPool;
  bucket: BudgetBucket;
  remaining: number;
  resetAt: string | null;
  timestamp: string;
  source: BudgetSource;
}
export interface BudgetBucketView {
  remaining: number | null;
  resetAt: string | null;
  timestamp: string | null;
  source: BudgetSource | null;
  state: 'unknown' | 'observed' | 'reset-pending';
  burnPerHour: { last2: number | null; last12h: number | null };
  projectedExhaustion: string | null;
}
export interface PoolBudgetView {
  mode: 'metered' | 'held' | 'capacity-only';
  remainingWeeklyPct: number | null;
  remainingCredits: number | null;
  buckets: Partial<Record<BudgetBucket, BudgetBucketView>>;
}
export interface PoolBudgetSnapshot {
  schema: 'fleet.budgets.v1';
  timestamp: string;
  sourceState: 'healthy' | 'unavailable';
  pools: Record<BudgetPool, PoolBudgetView>;
}
const BUCKETS: Record<BudgetPool, readonly BudgetBucket[]> = {
  'codex-cmp': ['weeklyPct', 'credits'], 'codex-personal': ['weeklyPct', 'credits'],
  devin: ['acus'], claude: ['weeklyPct'], 'grok-build': ['weeklyPct', 'credits'],
  'local-omlx': ['capacity'], 'grok-ultra': ['weeklyPct', 'credits'],
};
const HOUR = 3_600_000;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
export function budgetTime(value: unknown): string {
  if (typeof value !== 'string' || !ISO.test(value) || !Number.isFinite(Date.parse(value)) ||
      new Date(value).toISOString().replace('.000Z', 'Z') !== value.replace('.000Z', 'Z')) {
    throw new Error('Budget timestamps must be valid UTC ISO timestamps');
  }
  return new Date(value).toISOString();
}
/** Construct only whitelisted fields; never retain raw output, identifiers or credentials. */
export function validateBudgetReading(value: unknown): BudgetReading {
  if (!value || typeof value !== 'object') throw new Error('Invalid budget reading');
  const r = value as Record<string, unknown>;
  if (!BUDGET_POOLS.includes(r.pool as BudgetPool)) throw new Error('Unknown budget pool');
  const pool = r.pool as BudgetPool;
  if (!BUCKETS[pool].includes(r.bucket as BudgetBucket)) throw new Error('Unsupported budget bucket');
  if (typeof r.remaining !== 'number' || !Number.isFinite(r.remaining) || r.remaining < 0 ||
      r.remaining > (r.bucket === 'weeklyPct' ? 100 : Number.MAX_SAFE_INTEGER)) throw new Error('Invalid remaining budget');
  if (!['cli', 'log', 'manual'].includes(r.source as string)) throw new Error('Invalid budget source');
  const timestamp = budgetTime(r.timestamp);
  const resetAt = r.resetAt === null ? null : budgetTime(r.resetAt);
  if (resetAt && resetAt <= timestamp) throw new Error('Reset must follow the observation');
  return { pool, bucket: r.bucket as BudgetBucket, remaining: r.remaining, resetAt, timestamp, source: r.source as BudgetSource };
}
function bucketView(readings: BudgetReading[], now: number, capacity: boolean): BudgetBucketView {
  const unknown: BudgetBucketView = { remaining: null, resetAt: null, timestamp: null, source: null,
    state: 'unknown', burnPerHour: { last2: null, last12h: null }, projectedExhaustion: null };
  // A manual reading wins until its explicit reset, or until another manual reading.
  const sorted = readings.filter(r => Date.parse(r.timestamp) <= now).sort((a, b) =>
    a.timestamp.localeCompare(b.timestamp) || Number(a.source === 'manual') - Number(b.source === 'manual') ||
    b.remaining - a.remaining || a.source.localeCompare(b.source) || (a.resetAt ?? '').localeCompare(b.resetAt ?? ''));
  const effective: BudgetReading[] = [];
  let manual: BudgetReading | undefined;
  for (const r of sorted) {
    if (r.source === 'manual') manual = r;
    else if (manual && (!manual.resetAt || r.timestamp < manual.resetAt)) continue;
    if (effective.at(-1)?.timestamp === r.timestamp) effective.pop();
    effective.push(r);
  }
  const latest = effective.at(-1);
  if (!latest) return unknown;
  const expired = latest.resetAt !== null && Date.parse(latest.resetAt) <= now;
  const view: BudgetBucketView = { ...unknown, remaining: expired ? null : latest.remaining,
    resetAt: latest.resetAt, timestamp: latest.timestamp, source: latest.source,
    state: expired ? 'reset-pending' : 'observed' };
  if (expired || capacity) return view;
  // Never interpret a refill or a window boundary as negative burn or bridge it.
  let start = effective.length - 1;
  while (start > 0) {
    const prev = effective[start - 1]!;
    const next = effective[start]!;
    if (prev.remaining < next.remaining || (prev.resetAt && next.timestamp >= prev.resetAt) || prev.resetAt !== next.resetAt) break;
    start--;
  }
  const epoch = effective.slice(start);
  const rate = (first: BudgetReading | undefined): number | null => {
    if (!first || first.timestamp === latest.timestamp) return null;
    return (first.remaining - latest.remaining) / ((Date.parse(latest.timestamp) - Date.parse(first.timestamp)) / HOUR);
  };
  view.burnPerHour.last2 = rate(epoch.at(-2));
  view.burnPerHour.last12h = rate(epoch.find(r => Date.parse(r.timestamp) >= now - 12 * HOUR));
  const burn = view.burnPerHour.last2;
  const exhaustion = Date.parse(latest.timestamp) + (burn && burn > 0 ? latest.remaining / burn * HOUR : 0);
  if (latest.remaining === 0) view.projectedExhaustion = latest.timestamp;
  else if (burn && burn > 0 && exhaustion <= 8.64e15 && (!latest.resetAt || exhaustion < Date.parse(latest.resetAt))) {
    view.projectedExhaustion = new Date(exhaustion).toISOString();
  }
  return view;
}
export function projectPoolBudgets(readings: readonly BudgetReading[], now = new Date(), sourceState: PoolBudgetSnapshot['sourceState'] = 'healthy'): PoolBudgetSnapshot {
  const clean = readings.map(validateBudgetReading);
  const pools = {} as Record<BudgetPool, PoolBudgetView>;
  for (const pool of BUDGET_POOLS) {
    const buckets: PoolBudgetView['buckets'] = {};
    for (const bucket of BUCKETS[pool]) buckets[bucket] = bucketView(clean.filter(r => r.pool === pool && r.bucket === bucket), now.getTime(), pool === 'local-omlx');
    pools[pool] = { mode: pool === 'claude' ? 'held' : pool === 'local-omlx' ? 'capacity-only' : 'metered',
      remainingWeeklyPct: buckets.weeklyPct?.remaining ?? null, remainingCredits: buckets.credits?.remaining ?? null, buckets };
  }
  return { schema: 'fleet.budgets.v1', timestamp: now.toISOString(), sourceState, pools };
}

/** Strict, labelled CLI/log lines. Unrecognized text is discarded, never persisted. */
export function parseBudgetOutput(pool: BudgetPool, source: 'cli' | 'log', output: string, timestamp: string): BudgetReading[] {
  if (output.length > 1_048_576) throw new Error('Budget input exceeds 1 MiB');
  budgetTime(timestamp);
  const readings: BudgetReading[] = [];
  for (const line of output.split(/\r?\n/)) {
    if (line.trim().startsWith('{') && (pool === 'codex-cmp' || pool === 'codex-personal')) {
      readings.push(...parseCodexBudgetLine(pool, source, line, timestamp));
      continue;
    }
    const match = /^(?:rate[- ]limit[: ]+)?(weekly|credits|acus|capacity)\s+(remaining|used)\s*[:=]\s*(\d+(?:\.\d+)?)\s*(%)?(?:\s+resets?\s*[:=]\s*(\S+))?\s*$/i.exec(line.trim());
    if (!match) continue;
    const bucket = { weekly: 'weeklyPct', credits: 'credits', acus: 'acus', capacity: 'capacity' }[match[1]!.toLowerCase()] as BudgetBucket;
    if (match[3]!.length > 20 || (match[2]!.toLowerCase() === 'used' && bucket !== 'weeklyPct') || (match[4] && bucket !== 'weeklyPct')) continue;
    readings.push(validateBudgetReading({ pool, bucket, remaining: match[2]!.toLowerCase() === 'used' ? 100 - Number(match[3]) : Number(match[3]),
      resetAt: match[5] ?? null, timestamp, source }));
  }
  return readings;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
/** Existing Codex event_msg/token_count wire shape; only quota counts and times survive. */
function parseCodexBudgetLine(pool: BudgetPool, source: 'cli' | 'log', line: string, fallback: string): BudgetReading[] {
  let row: Record<string, unknown>;
  try { row = record(JSON.parse(line)); } catch { return []; }
  const payload = record(row.payload);
  if (row.type !== 'event_msg' || payload.type !== 'token_count') return [];
  const timestamp = budgetTime(row.timestamp ?? fallback);
  const limits = record(payload.rate_limits);
  const readings: BudgetReading[] = [];
  for (const key of ['primary', 'secondary']) {
    const window = record(limits[key]);
    if (window.window_minutes !== 10080 || typeof window.used_percent !== 'number' || typeof window.resets_at !== 'number') continue;
    readings.push(validateBudgetReading({ pool, bucket: 'weeklyPct', remaining: 100 - window.used_percent,
      resetAt: new Date(window.resets_at * 1000).toISOString(), timestamp, source }));
  }
  const credits = record(limits.credits);
  if (credits.unlimited !== true && (typeof credits.balance === 'number' ||
      typeof credits.balance === 'string' && /^\d+(?:\.\d+)?$/.test(credits.balance))) {
    readings.push(validateBudgetReading({ pool, bucket: 'credits', remaining: Number(credits.balance), resetAt: null, timestamp, source }));
  }
  return readings;
}
