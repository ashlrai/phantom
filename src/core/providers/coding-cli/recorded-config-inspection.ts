/**
 * Offline inspection of one caller-supplied router scheduler config, recovered from
 * PR #5952 (3d6c8fb7c7f7d52655fb3e0f13ef239686f7b886): scheduler/defaults.ts
 * parseSchedulerConfig, its numberIn/optionalNumber/optionalString/applyPool/applyUltra
 * checks, and the bounds in config/router-scheduler.json. Pure: JSON in, projection out.
 * No file, HOME, env, network, state, dispatch, or live-routing access.
 *
 * Differences from the source: absent fields stay unknown (no embedded defaults, including
 * the unknown-balance soft cap); wrong types and postIssues:true or version other than 1
 * are errors with a path (the source silently ignored or forced them); unknown and
 * credential-shaped fields are counted, never echoed; posthog reduces to booleans;
 * source/sourceDate are supplied attribution; orchestrationReserveFraction is recorded
 * obsolete policy with automaticReserveApplied:false (the source applied it as a reserve).
 * Pool enums are copied, not imported, so the absent scheduler tree is not a dependency.
 */

export const RECORDED_CONFIG_PROVENANCE = Object.freeze({
  source: 'historical-offline',
  sourcePr: 5952,
  sourceSha: '3d6c8fb7c7f7d52655fb3e0f13ef239686f7b886',
  basis: 'recorded-config-file',
} as const);

export class RecordedConfigError extends Error {
  constructor(readonly path: string, detail: string) {
    super(`recorded scheduler config: ${path} ${detail}`);
    this.name = 'RecordedConfigError';
  }
}

export const RECORDED_POOL_IDS = [
  'codex-primary', 'codex-secondary', 'claude', 'devin', 'grok-build', 'local', 'grok-ultra-weekly', 'metered',
] as const;
export type RecordedPoolId = (typeof RECORDED_POOL_IDS)[number];
export type RecordedScalarKey =
  | 'diskFloorGb' | 'batteryFloorPercent' | 'canaryPercent' | 'solverBudgetMs' | 'paceTickMs' | 'loseItWeight'
  | 'latencyWeight' | 'latencyReferenceMs' | 'tokenWeight' | 'tokenReference' | 'promotionMinRows';
export type RecordedValue = number | boolean | string | null;

/** Inclusive [min, max] bounds, identical to the source parser. */
const SCALARS: Record<RecordedScalarKey, readonly [number, number]> = {
  diskFloorGb: [0, 100_000], batteryFloorPercent: [0, 100], canaryPercent: [0, 100], solverBudgetMs: [1, 60_000],
  paceTickMs: [1, 366 * 86_400_000], loseItWeight: [0, 1_000], latencyWeight: [0, 1_000],
  latencyReferenceMs: [1, 86_400_000], tokenWeight: [0, 1_000], tokenReference: [1, 100_000_000],
  promotionMinRows: [1, 1_000_000],
};
const TOP_LEVEL = new Set(['version', 'source', 'sourceDate', 'postIssues', 'posthog', 'grokUltraWeekly', 'pools', ...Object.keys(SCALARS)]);
const BILLING = ['subscription', 'metered', 'local', 'loopback'] as const;
const TIERS = ['local', 'cheap', 'workhorse', 'frontier'] as const;
const HOSTS = ['mac', 'remote'] as const;

type Obj = Record<string, unknown>;
type Reader = (value: unknown, path: string) => RecordedValue;

const isObject = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
function fail(path: string, detail: string): never {
  throw new RecordedConfigError(path, detail);
}
function num(v: unknown, path: string, min: number, max: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) fail(path, 'must be a finite number');
  if (v < min || v > max) fail(path, `must be between ${min} and ${max}`);
  return v;
}
const anyNum: Reader = (v, p) => num(v, p, -Infinity, Infinity);
const str: Reader = (v, p) => (typeof v === 'string' && v.trim() !== '' ? v : fail(p, 'must be a non-empty string'));
const bool: Reader = (v, p) => (typeof v === 'boolean' ? v : fail(p, 'must be a boolean'));
const nullable = (read: Reader): Reader => (v, p) => (v === null ? null : read(v, p));
function choice(options: readonly string[]): Reader {
  return (v, p) => (typeof v === 'string' && options.includes(v) ? v : fail(p, `must be one of ${options.join(', ')}`));
}

const POOL_READERS: Record<string, Reader> = {
  billing: choice(BILLING),
  tier: choice(TIERS),
  host: choice(HOSTS),
  concurrency: (v, p) => num(v, p, 0, 10_000),
  preferencePenalty: (v, p) => num(v, p, 0, 1_000),
  monetaryCost: (v, p) => num(v, p, 0, 1_000_000),
  softCapPerDay: (v, p) => num(v, p, 0, 1_000_000),
  usedToday: (v, p) => num(v, p, 0, 1_000_000),
  unlimited: bool,
  live: bool,
  requiresDevinGate: bool,
  requiresMeteredOptIn: bool,
  enabled: bool,
  remaining: nullable(anyNum),
  headroomPercent: nullable(anyNum),
  expiresAt: nullable(str),
  resetAt: nullable(str),
};

/** Grok Ultra allowlist. plan, label, sharedBy and fixed flags are not projected. */
const ULTRA_READERS: Record<string, Reader> = {
  usedFraction: (v, p) => num(v, p, 0, 1),
  resetEveryDays: (v, p) => num(v, p, 1, 366),
  orchestrationReserveFraction: (v, p) => num(v, p, 0, 1),
  cloudShadowPrice: (v, p) => num(v, p, 0, 1_000_000),
  jobFraction: (v, p) => num(v, p, 0, 1),
  usedFractionAsOf: str,
  usedFractionAsOfLocal: str,
  resetAt: str,
  resetAtLocal: str,
  resetTimezone: str,
  extraUsageCredits: bool,
};

export interface RecordedPool {
  /** Only fields present in the input. Null is supplied, not unknown. */
  supplied: Record<string, RecordedValue>;
  unsuppliedFields: string[];
  /** Unknown and credential-shaped keys dropped from this entry. Names and values are never returned. */
  omittedFieldCount: number;
}

export interface RecordedConfigInspection {
  state: 'recorded-input-only';
  currentAvailability: 'not-current-availability';
  policy: 'no-policy-applied';
  provenance: typeof RECORDED_CONFIG_PROVENANCE & { suppliedSource: string | null; suppliedSourceDate: string | null };
  /** Always false. The config cannot enable GitHub posting. */
  postIssues: false;
  scalars: Partial<Record<RecordedScalarKey, number>>;
  unsuppliedScalars: RecordedScalarKey[];
  posthog: { suppliedEnabled: boolean | null; hostConfigured: boolean | null; apiKeyConfigured: boolean | null } | null;
  grokUltraWeekly: { supplied: Record<string, RecordedValue>; unsuppliedFields: string[]; omittedFieldCount: number } | null;
  /** Recorded obsolete reserve, present only when supplied. It never reserves capacity. */
  obsoleteReserve: { orchestrationReserveFraction: number; status: 'recorded-obsolete'; automaticReserveApplied: false } | null;
  pools: Partial<Record<RecordedPoolId, RecordedPool>>;
  unsuppliedPools: RecordedPoolId[];
  omittedTopLevelCount: number;
}

/** Projects the allowlisted keys that are present. Absent keys stay unknown. */
function project(readers: Record<string, Reader>, raw: Obj, path: string, skip: readonly string[] = []) {
  const supplied: Record<string, RecordedValue> = {};
  for (const [key, read] of Object.entries(readers)) {
    if (key in raw) supplied[key] = read(raw[key], `${path}.${key}`);
  }
  const unsuppliedFields = Object.keys(readers).filter((key) => !(key in supplied));
  const omittedFieldCount = Object.keys(raw).filter((key) => !skip.includes(key)).length - Object.keys(supplied).length;
  return { supplied, unsuppliedFields, omittedFieldCount };
}

/** Inspect a parsed JSON value. Throws RecordedConfigError with the first failing path. Never mutates. */
export function inspectRecordedSchedulerConfig(raw: unknown): RecordedConfigInspection {
  if (!isObject(raw)) fail('$', 'root must be an object');
  if ('version' in raw && raw['version'] !== 1) fail('version', 'must be 1');
  if ('postIssues' in raw && raw['postIssues'] !== false) fail('postIssues', 'must be false when supplied');

  const scalars: Partial<Record<RecordedScalarKey, number>> = {};
  for (const key of Object.keys(SCALARS) as RecordedScalarKey[]) {
    if (key in raw) scalars[key] = num(raw[key], key, ...SCALARS[key]);
  }

  let posthog: RecordedConfigInspection['posthog'] = null;
  if ('posthog' in raw) {
    const ph = raw['posthog'];
    if (!isObject(ph)) fail('posthog', 'must be an object');
    const host = ph['host'];
    const apiKey = ph['apiKey'];
    if (host != null) str(host, 'posthog.host');
    if (apiKey != null) str(apiKey, 'posthog.apiKey');
    posthog = {
      suppliedEnabled: 'enabled' in ph ? bool(ph['enabled'], 'posthog.enabled') as boolean : null,
      hostConfigured: host === undefined ? null : host !== null,
      apiKeyConfigured: apiKey === undefined ? null : apiKey !== null,
    };
  }

  let grokUltraWeekly: RecordedConfigInspection['grokUltraWeekly'] = null;
  if ('grokUltraWeekly' in raw) {
    const ultra = raw['grokUltraWeekly'];
    if (!isObject(ultra)) fail('grokUltraWeekly', 'must be an object');
    if ('id' in ultra && ultra['id'] !== 'grok-ultra-weekly') fail('grokUltraWeekly.id', 'must be "grok-ultra-weekly"');
    grokUltraWeekly = project(ULTRA_READERS, ultra, 'grokUltraWeekly', ['id']);
  }
  const reserve = grokUltraWeekly?.supplied['orchestrationReserveFraction'];

  const pools: Partial<Record<RecordedPoolId, RecordedPool>> = {};
  if ('pools' in raw) {
    const rawPools = raw['pools'];
    if (!isObject(rawPools)) fail('pools', 'must be an object');
    for (const id of Object.keys(rawPools)) {
      if (!(RECORDED_POOL_IDS as readonly string[]).includes(id)) fail(`pools.${id}`, 'is not a known pool id');
      const entry = rawPools[id];
      if (!isObject(entry)) fail(`pools.${id}`, 'must be an object');
      pools[id as RecordedPoolId] = project(POOL_READERS, entry, `pools.${id}`);
    }
  }

  return {
    state: 'recorded-input-only',
    currentAvailability: 'not-current-availability',
    policy: 'no-policy-applied',
    provenance: {
      ...RECORDED_CONFIG_PROVENANCE,
      suppliedSource: 'source' in raw ? str(raw['source'], 'source') as string : null,
      suppliedSourceDate: 'sourceDate' in raw ? str(raw['sourceDate'], 'sourceDate') as string : null,
    },
    postIssues: false,
    scalars,
    unsuppliedScalars: (Object.keys(SCALARS) as RecordedScalarKey[]).filter((key) => !(key in scalars)),
    posthog,
    grokUltraWeekly,
    obsoleteReserve: typeof reserve === 'number'
      ? { orchestrationReserveFraction: reserve, status: 'recorded-obsolete', automaticReserveApplied: false }
      : null,
    pools,
    unsuppliedPools: RECORDED_POOL_IDS.filter((id) => !(id in pools)),
    omittedTopLevelCount: Object.keys(raw).filter((key) => !TOP_LEVEL.has(key)).length,
  };
}

/** Parse JSON text, then inspect it. Malformed JSON is a RecordedConfigError at path `$`. */
export function parseRecordedSchedulerConfig(text: string): RecordedConfigInspection {
  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
  } catch {
    fail('$', 'is not valid JSON');
  }
  return inspectRecordedSchedulerConfig(raw);
}
