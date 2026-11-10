/**
 * Scheduler defaults. The JSON file in config/ is the labelled source.
 * Callers override any field. postIssues cannot be turned on.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { UNKNOWN_BALANCE_SOFT_CAP_PER_DAY, type TierFloor } from '../../../resources/pool-spend.js';
import type { BillingClass } from '../../../routing/billing-class.js';
import {
  isSchedulerPoolId,
  SCHEDULER_POOL_IDS,
  type PoolHost,
  type SchedulerPoolId,
} from './types.js';

export interface PoolDefaults {
  billing: BillingClass;
  tier: TierFloor;
  host: PoolHost;
  concurrency: number;
  preferencePenalty: number;
  monetaryCost: number;
  unlimited: boolean;
  live: boolean;
  requiresDevinGate: boolean;
  requiresMeteredOptIn: boolean;
  softCapPerDay: number;
  remaining: number | null;
  usedToday: number;
  expiresAt: string | null;
  resetAt: string | null;
  headroomPercent: number | null;
  enabled: boolean;
}

export interface GrokUltraDefaults {
  id: 'grok-ultra-weekly';
  plan: string;
  sharedBy: readonly ['grok-bot', 'cursor'];
  separateCursorCloudPool: false;
  usedFraction: number;
  usedFractionAsOf: string;
  usedFractionAsOfLocal: string;
  quotaReadableFromApi: false;
  estimate: true;
  extraUsageCredits: boolean;
  resetAt: string;
  resetAtLocal: string;
  resetTimezone: string;
  resetEveryDays: number;
  orchestrationReserveFraction: number;
  cloudShadowPrice: number;
  jobFraction: number;
  label: string;
}

export interface SchedulerConfig {
  version: 1;
  source: string;
  sourceDate: string;
  diskFloorGb: number;
  batteryFloorPercent: number;
  canaryPercent: number;
  solverBudgetMs: number;
  paceTickMs: number;
  loseItWeight: number;
  latencyWeight: number;
  latencyReferenceMs: number;
  tokenWeight: number;
  tokenReference: number;
  promotionMinRows: number;
  /** Fixed off. A config file cannot enable GitHub posting. */
  postIssues: false;
  posthog: { enabled: boolean; host: string | null; apiKey: string | null };
  grokUltraWeekly: GrokUltraDefaults;
  pools: Readonly<Record<SchedulerPoolId, PoolDefaults>>;
}

export interface PoolOverride {
  billing?: BillingClass;
  tier?: TierFloor;
  host?: PoolHost;
  concurrency?: number;
  preferencePenalty?: number;
  monetaryCost?: number;
  unlimited?: boolean;
  live?: boolean;
  requiresDevinGate?: boolean;
  requiresMeteredOptIn?: boolean;
  softCapPerDay?: number;
  remaining?: number | null;
  usedToday?: number;
  expiresAt?: string | null;
  resetAt?: string | null;
  headroomPercent?: number | null;
  enabled?: boolean;
}

export interface SchedulerOverrides {
  diskFloorGb?: number;
  batteryFloorPercent?: number;
  canaryPercent?: number;
  solverBudgetMs?: number;
  paceTickMs?: number;
  loseItWeight?: number;
  latencyWeight?: number;
  latencyReferenceMs?: number;
  tokenWeight?: number;
  tokenReference?: number;
  promotionMinRows?: number;
  posthog?: { enabled?: boolean; host?: string | null; apiKey?: string | null };
  grokUltraWeekly?: Partial<Omit<GrokUltraDefaults, 'id' | 'separateCursorCloudPool' | 'quotaReadableFromApi' | 'estimate' | 'sharedBy'>>;
  pools?: Partial<Record<SchedulerPoolId, PoolOverride>>;
}

const BILLING: readonly BillingClass[] = ['subscription', 'metered', 'local', 'loopback'];
const TIERS: readonly TierFloor[] = ['local', 'cheap', 'workhorse', 'frontier'];

function pool(partial: Omit<PoolDefaults, 'unlimited' | 'live' | 'requiresDevinGate' | 'requiresMeteredOptIn' | 'softCapPerDay' | 'remaining' | 'usedToday' | 'expiresAt' | 'resetAt' | 'headroomPercent' | 'enabled'> & Partial<PoolDefaults>): PoolDefaults {
  return {
    unlimited: false,
    live: true,
    requiresDevinGate: false,
    requiresMeteredOptIn: false,
    softCapPerDay: UNKNOWN_BALANCE_SOFT_CAP_PER_DAY,
    remaining: null,
    usedToday: 0,
    expiresAt: null,
    resetAt: null,
    headroomPercent: null,
    enabled: true,
    ...partial,
  };
}

/** In-code copy of config/router-scheduler.json, used when the file is absent. */
export function embeddedSchedulerConfig(): SchedulerConfig {
  return {
    version: 1,
    source: 'Mason, Oct 25 2026 11:26 PM ET',
    sourceDate: '2026-10-26T03:26:00.000Z',
    diskFloorGb: 20,
    batteryFloorPercent: 30,
    canaryPercent: 10,
    solverBudgetMs: 100,
    paceTickMs: 86_400_000,
    loseItWeight: 0.5,
    latencyWeight: 0.1,
    latencyReferenceMs: 600_000,
    tokenWeight: 0.05,
    tokenReference: 100_000,
    promotionMinRows: 20,
    postIssues: false,
    posthog: { enabled: false, host: null, apiKey: null },
    grokUltraWeekly: {
      id: 'grok-ultra-weekly',
      plan: 'Grok Ultra',
      sharedBy: ['grok-bot', 'cursor'],
      separateCursorCloudPool: false,
      usedFraction: 0.36,
      usedFractionAsOf: '2026-10-26T03:26:00.000Z',
      usedFractionAsOfLocal: '2026-10-25T23:26:00-04:00',
      quotaReadableFromApi: false,
      estimate: true,
      extraUsageCredits: false,
      resetAt: '2026-11-02T01:21:00.000Z',
      resetAtLocal: '2026-11-01T20:21:00-05:00',
      resetTimezone: 'America/New_York',
      resetEveryDays: 7,
      orchestrationReserveFraction: 0.15,
      cloudShadowPrice: 0.75,
      jobFraction: 0.01,
      label: 'estimate from Mason, Oct 25 2026 11:26 PM ET; not an API reading',
    },
    pools: {
      'codex-primary': pool({ billing: 'subscription', tier: 'frontier', host: 'mac', concurrency: 1, preferencePenalty: 0, monetaryCost: 0 }),
      'codex-secondary': pool({ billing: 'subscription', tier: 'frontier', host: 'mac', concurrency: 1, preferencePenalty: 0.02, monetaryCost: 0 }),
      claude: pool({ billing: 'subscription', tier: 'frontier', host: 'mac', concurrency: 1, preferencePenalty: 0.04, monetaryCost: 0, live: true }),
      devin: pool({ billing: 'metered', tier: 'frontier', host: 'remote', concurrency: 1, preferencePenalty: 0.06, monetaryCost: 0, requiresDevinGate: true }),
      'grok-build': pool({ billing: 'metered', tier: 'workhorse', host: 'mac', concurrency: 1, preferencePenalty: 0.08, monetaryCost: 0, requiresMeteredOptIn: true }),
      local: pool({ billing: 'loopback', tier: 'cheap', host: 'mac', concurrency: 1, preferencePenalty: 0.1, monetaryCost: 0, unlimited: true }),
      'grok-ultra-weekly': pool({ billing: 'metered', tier: 'frontier', host: 'remote', concurrency: 1, preferencePenalty: 0, monetaryCost: 0 }),
      metered: pool({ billing: 'metered', tier: 'frontier', host: 'remote', concurrency: 1, preferencePenalty: 0.2, monetaryCost: 1, requiresMeteredOptIn: true }),
    },
  };
}

export function defaultSchedulerConfigPath(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '../../../../../config/router-scheduler.json');
}

function fail(message: string): never {
  throw new Error(`router scheduler config: ${message}`);
}

function numberIn(value: unknown, name: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) fail(`${name} is out of range`);
  return value;
}

function optionalNumber(value: unknown, name: string): number | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value)) fail(`${name} is not a number`);
  return value;
}

function optionalString(value: unknown, name: string): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== 'string' || value.trim() === '') fail(`${name} is empty`);
  return value;
}

function billingOf(value: unknown): BillingClass {
  if (typeof value !== 'string' || !(BILLING as readonly string[]).includes(value)) fail('billing class');
  return value as BillingClass;
}

function tierOf(value: unknown): TierFloor {
  if (typeof value !== 'string' || !(TIERS as readonly string[]).includes(value)) fail('tier');
  return value as TierFloor;
}

function applyPool(base: PoolDefaults, raw: unknown): PoolDefaults {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return base;
  const row = raw as Record<string, unknown>;
  const next: PoolDefaults = { ...base };
  if (row['billing'] !== undefined) next.billing = billingOf(row['billing']);
  if (row['tier'] !== undefined) next.tier = tierOf(row['tier']);
  if (row['host'] !== undefined) {
    if (row['host'] !== 'mac' && row['host'] !== 'remote') fail('host');
    next.host = row['host'];
  }
  if (row['concurrency'] !== undefined) next.concurrency = numberIn(row['concurrency'], 'concurrency', 0, 10_000);
  if (row['preferencePenalty'] !== undefined) next.preferencePenalty = numberIn(row['preferencePenalty'], 'preferencePenalty', 0, 1_000);
  if (row['monetaryCost'] !== undefined) next.monetaryCost = numberIn(row['monetaryCost'], 'monetaryCost', 0, 1_000_000);
  if (typeof row['unlimited'] === 'boolean') next.unlimited = row['unlimited'];
  if (typeof row['live'] === 'boolean') next.live = row['live'];
  if (typeof row['requiresDevinGate'] === 'boolean') next.requiresDevinGate = row['requiresDevinGate'];
  if (typeof row['requiresMeteredOptIn'] === 'boolean') next.requiresMeteredOptIn = row['requiresMeteredOptIn'];
  if (row['softCapPerDay'] !== undefined) next.softCapPerDay = numberIn(row['softCapPerDay'], 'softCapPerDay', 0, 1_000_000);
  const remaining = optionalNumber(row['remaining'], 'remaining');
  if (remaining !== undefined) next.remaining = remaining;
  if (row['usedToday'] !== undefined) next.usedToday = numberIn(row['usedToday'], 'usedToday', 0, 1_000_000);
  const expiresAt = optionalString(row['expiresAt'], 'expiresAt');
  if (expiresAt !== undefined) next.expiresAt = expiresAt;
  const resetAt = optionalString(row['resetAt'], 'resetAt');
  if (resetAt !== undefined) next.resetAt = resetAt;
  const headroom = optionalNumber(row['headroomPercent'], 'headroomPercent');
  if (headroom !== undefined) next.headroomPercent = headroom;
  if (typeof row['enabled'] === 'boolean') next.enabled = row['enabled'];
  return next;
}

function applyUltra(base: GrokUltraDefaults, raw: unknown): GrokUltraDefaults {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return base;
  const row = raw as Record<string, unknown>;
  const next: GrokUltraDefaults = { ...base, separateCursorCloudPool: false, quotaReadableFromApi: false, estimate: true, sharedBy: ['grok-bot', 'cursor'] };
  if (typeof row['plan'] === 'string' && row['plan'].trim() !== '') next.plan = row['plan'];
  if (row['usedFraction'] !== undefined) next.usedFraction = numberIn(row['usedFraction'], 'usedFraction', 0, 1);
  if (typeof row['usedFractionAsOf'] === 'string') next.usedFractionAsOf = row['usedFractionAsOf'];
  if (typeof row['usedFractionAsOfLocal'] === 'string') next.usedFractionAsOfLocal = row['usedFractionAsOfLocal'];
  if (typeof row['extraUsageCredits'] === 'boolean') next.extraUsageCredits = row['extraUsageCredits'];
  if (typeof row['resetAt'] === 'string') next.resetAt = row['resetAt'];
  if (typeof row['resetAtLocal'] === 'string') next.resetAtLocal = row['resetAtLocal'];
  if (typeof row['resetTimezone'] === 'string') next.resetTimezone = row['resetTimezone'];
  if (row['resetEveryDays'] !== undefined) next.resetEveryDays = numberIn(row['resetEveryDays'], 'resetEveryDays', 1, 366);
  if (row['orchestrationReserveFraction'] !== undefined) {
    next.orchestrationReserveFraction = numberIn(row['orchestrationReserveFraction'], 'orchestrationReserveFraction', 0, 1);
  }
  if (row['cloudShadowPrice'] !== undefined) next.cloudShadowPrice = numberIn(row['cloudShadowPrice'], 'cloudShadowPrice', 0, 1_000_000);
  if (row['jobFraction'] !== undefined) next.jobFraction = numberIn(row['jobFraction'], 'jobFraction', 0, 1);
  if (typeof row['label'] === 'string' && row['label'].trim() !== '') next.label = row['label'];
  return next;
}

export function parseSchedulerConfig(text: string, overrides?: SchedulerOverrides): SchedulerConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
  } catch {
    fail('file is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) fail('root is not an object');
  const row = raw as Record<string, unknown>;
  const base = embeddedSchedulerConfig();
  const pools = { ...base.pools };
  const rawPools = row['pools'];
  if (rawPools !== undefined) {
    if (typeof rawPools !== 'object' || rawPools === null || Array.isArray(rawPools)) fail('pools');
    for (const key of Object.keys(rawPools)) {
      if (!isSchedulerPoolId(key)) fail(`unknown pool ${key}`);
      pools[key] = applyPool(pools[key], (rawPools as Record<string, unknown>)[key]);
    }
  }
  const config: SchedulerConfig = {
    ...base,
    pools,
    grokUltraWeekly: applyUltra(base.grokUltraWeekly, row['grokUltraWeekly']),
    postIssues: false,
  };
  if (typeof row['source'] === 'string' && row['source'].trim() !== '') config.source = row['source'];
  if (typeof row['sourceDate'] === 'string') config.sourceDate = row['sourceDate'];
  if (row['diskFloorGb'] !== undefined) config.diskFloorGb = numberIn(row['diskFloorGb'], 'diskFloorGb', 0, 100_000);
  if (row['batteryFloorPercent'] !== undefined) config.batteryFloorPercent = numberIn(row['batteryFloorPercent'], 'batteryFloorPercent', 0, 100);
  if (row['canaryPercent'] !== undefined) config.canaryPercent = numberIn(row['canaryPercent'], 'canaryPercent', 0, 100);
  if (row['solverBudgetMs'] !== undefined) config.solverBudgetMs = numberIn(row['solverBudgetMs'], 'solverBudgetMs', 1, 60_000);
  if (row['paceTickMs'] !== undefined) config.paceTickMs = numberIn(row['paceTickMs'], 'paceTickMs', 1, 366 * 86_400_000);
  if (row['loseItWeight'] !== undefined) config.loseItWeight = numberIn(row['loseItWeight'], 'loseItWeight', 0, 1_000);
  if (row['latencyWeight'] !== undefined) config.latencyWeight = numberIn(row['latencyWeight'], 'latencyWeight', 0, 1_000);
  if (row['latencyReferenceMs'] !== undefined) config.latencyReferenceMs = numberIn(row['latencyReferenceMs'], 'latencyReferenceMs', 1, 86_400_000);
  if (row['tokenWeight'] !== undefined) config.tokenWeight = numberIn(row['tokenWeight'], 'tokenWeight', 0, 1_000);
  if (row['tokenReference'] !== undefined) config.tokenReference = numberIn(row['tokenReference'], 'tokenReference', 1, 100_000_000);
  if (row['promotionMinRows'] !== undefined) config.promotionMinRows = numberIn(row['promotionMinRows'], 'promotionMinRows', 1, 1_000_000);
  if (row['posthog'] !== undefined && typeof row['posthog'] === 'object' && row['posthog'] !== null) {
    const posthog = row['posthog'] as Record<string, unknown>;
    config.posthog = {
      enabled: posthog['enabled'] === true,
      host: typeof posthog['host'] === 'string' ? posthog['host'] : null,
      apiKey: typeof posthog['apiKey'] === 'string' ? posthog['apiKey'] : null,
    };
  }
  return applyOverrides(config, overrides);
}

export function applyOverrides(config: SchedulerConfig, overrides?: SchedulerOverrides): SchedulerConfig {
  if (!overrides) return { ...config, postIssues: false };
  const pools = { ...config.pools };
  for (const id of SCHEDULER_POOL_IDS) {
    const patch = overrides.pools?.[id];
    if (patch) pools[id] = { ...pools[id], ...patch };
  }
  const ultraPatch = overrides.grokUltraWeekly;
  const ultra: GrokUltraDefaults = {
    ...config.grokUltraWeekly,
    ...ultraPatch,
    id: 'grok-ultra-weekly',
    separateCursorCloudPool: false,
    quotaReadableFromApi: false,
    estimate: true,
    sharedBy: ['grok-bot', 'cursor'],
  };
  const posthog = overrides.posthog;
  return {
    ...config,
    diskFloorGb: overrides.diskFloorGb ?? config.diskFloorGb,
    batteryFloorPercent: overrides.batteryFloorPercent ?? config.batteryFloorPercent,
    canaryPercent: overrides.canaryPercent ?? config.canaryPercent,
    solverBudgetMs: overrides.solverBudgetMs ?? config.solverBudgetMs,
    paceTickMs: overrides.paceTickMs ?? config.paceTickMs,
    loseItWeight: overrides.loseItWeight ?? config.loseItWeight,
    latencyWeight: overrides.latencyWeight ?? config.latencyWeight,
    latencyReferenceMs: overrides.latencyReferenceMs ?? config.latencyReferenceMs,
    tokenWeight: overrides.tokenWeight ?? config.tokenWeight,
    tokenReference: overrides.tokenReference ?? config.tokenReference,
    promotionMinRows: overrides.promotionMinRows ?? config.promotionMinRows,
    pools,
    grokUltraWeekly: ultra,
    posthog: {
      enabled: posthog?.enabled ?? config.posthog.enabled,
      host: posthog && 'host' in posthog ? posthog.host ?? null : config.posthog.host,
      apiKey: posthog && 'apiKey' in posthog ? posthog.apiKey ?? null : config.posthog.apiKey,
    },
    postIssues: false,
  };
}

export function loadSchedulerConfig(options?: { path?: string; overrides?: SchedulerOverrides }): SchedulerConfig {
  const path = options?.path ?? defaultSchedulerConfigPath();
  try {
    return parseSchedulerConfig(readFileSync(path, 'utf8'), options?.overrides);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('router scheduler config:')) throw error;
    return applyOverrides(embeddedSchedulerConfig(), options?.overrides);
  }
}
