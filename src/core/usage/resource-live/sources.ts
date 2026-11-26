/**
 * Sources per allowance, tried in order until one returns a verified reading:
 *
 *   1. official: the provider's own API or CLI status, through readers the
 *      repo already owns.
 *   2. own-call: rate-limit data returned to calls Phantom already made.
 *   3. visible-window: the rendered text of a usage page in the dedicated
 *      usage browser, only when a session is supplied.
 *
 * Nothing here opens a credential, cookie, keychain, app database or TCC
 * store, and no path under ~/.codex* is ever read: a Codex pool home is used
 * only when it is explicit and passes codexPoolHomeAllowed. An allowance with
 * an empty list has no supported source yet and stays unverified.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { readLatestClaudeRateLimitEvent } from '../../fabric/claude-rate-limit-event.js';
import { readCodexUsage, type CodexUsageReading } from '../../fabric/readers/codex-usage.js';
import { readClaudeQuotaReading, usableClaudeWeekly, type ClaudeQuotaReadingV1 } from '../../fleet/claude-quota-reading.js';
import { readGrokUltraRunway } from '../../fleet/grok-ultra-store.js';
import type { GrokUltraRunway } from '../../fleet/grok-ultra-types.js';
import { readFableAdmission } from '../../routing/fable-admission.js';
import type { FablePlan } from '../../routing/fable-orchestrator.js';
import { readSite, type BrowserSession } from '../live/browser.js';
import { USAGE_SITES, type UsageSite } from '../live/sites.js';
import { usageResourceReaders, validUsageReading, type UsageResourceId, type UsageResourceReaderDeps } from '../resource-usage.js';
import { parseClaudeSensor } from '../sensor-refresh.js';
import { codexPoolHomeAllowed } from '../sensor-pull.js';
import type { DevinModelCatalog } from '../../devin/models.js';
import type { DevinWeeklyCapacity } from '../../devin/weekly-capacity.js';
import { NEEDS_SIGNIN, type ResourceLiveSource, type ResourceLiveSources } from './source-types.js';
import { RESOURCE_LIVE_STALE_MS, type ResourceLiveTier } from './types.js';
import { readPrivateJson, readResourceEvidenceFile } from './store.js';
import type { CapacitySnapshot } from '../../routing/budget-store.js';
import type { LiveSourcesConfig } from './config.js';
import { capacitySource } from './capacity-source.js';
import { anthropicCostSource } from '../../fabric/readers/anthropic-cost.js';
import { operatorPageSources, type OperatorUsagePageReader } from './operator-page.js';
import { publishCodexResetBank } from './banked-resets.js';

export interface ResourceLiveSourceOptions extends LiveSourcesConfig {
  readCapacity?: () => CapacitySnapshot | null;
  operatorPageReader?: OperatorUsagePageReader;
  runAnthropicCost?: () => Promise<string>;
  /** Runs dir holding metrics/claude-quota.json and queue/resources.json. */
  runsDir: string;
  operatorHome?: string;
  /** Explicit Codex pool homes. Refused when they are the operator home or under ~/.codex*. */
  codexCmpHome?: string;
  codexPersonalHome?: string;
  /** Accounts root of the Claude API grant store. Absent leaves the credit unverified. */
  accountsRoot?: string;
  /** Dedicated usage browser. Null or absent skips the visible-window tier. */
  browser?: BrowserSession | null;
  omlxUrl?: string;
  fetchImpl?: typeof fetch;
  /** Reader seams. Each defaults to the repo's real reader. */
  readClaudeQuota?: (runsDir: string) => Promise<ClaudeQuotaReadingV1 | null>;
  readClaudeEvent?: (nowMs: number) => unknown;
  readFable?: (nowMs: number) => FablePlan;
  readCodex?: (home: string) => Promise<Pick<CodexUsageReading, 'pctUsed' | 'resetAt' | 'fetchedAt' | 'windows' | 'resetBank'>>;
  readGrok?: (nowMs: number) => Promise<GrokUltraRunway>;
  resourceReaders?: UsageResourceReaderDeps;
  /** Devin weekly session-list measurement and the last published one. */
  readDevinWeekly?: (nowMs: number) => Promise<DevinWeeklyCapacity>;
  readDevinPublished?: (nowMs: number) => DevinWeeklyCapacity | null;
  /** Devin CLI model catalog (free-preview models). */
  readDevinModels?: () => Promise<DevinModelCatalog | null>;
}

const iso = (ms: number): string => new Date(ms).toISOString();

function claudeWeekly(o: ResourceLiveSourceOptions): ResourceLiveSource[] {
  return [
    { tier: 'official', read: async (nowMs) => {
      const weekly = usableClaudeWeekly(await (o.readClaudeQuota ?? readClaudeQuotaReading)(o.runsDir), nowMs);
      if (!weekly) return null;
      return { used: weekly.weekly.usedPct, limit: 100, unit: 'percent', reset_at: weekly.weekly.resetAt,
        source: 'claude-usage', observed_at: weekly.observedAt, ...(weekly.accountId ? { account_id: weekly.accountId } : {}) };
    } },
    capacitySource('claude-weekly', o.codexSeatMap, o.readCapacity),
    { tier: 'own-call', read: (nowMs) => {
      const row = parseClaudeSensor((o.readClaudeEvent ?? (now => readLatestClaudeRateLimitEvent({ nowMs: now })))(nowMs), nowMs);
      if (!row || row.used === null) return null;
      return { used: row.used, limit: 100, unit: 'percent', reset_at: row.resetAt, source: 'claude-rate-limit-event', observed_at: row.observedAt };
    } },
  ];
}

/** Fable's share is points of the overall weekly allowance: used and limit are both in those points. */
function claudeFable(o: ResourceLiveSourceOptions): ResourceLiveSource[] {
  return [{ tier: 'official', read: (nowMs) => {
    const plan = (o.readFable ?? (now => readFableAdmission({ role: 'leader' }, now)))(nowMs);
    if (plan.fableOverallWeeklyUsedPercent === null || plan.observedAtMs === null || !(plan.sharePercent > 0)) return null;
    return { used: plan.fableOverallWeeklyUsedPercent, limit: plan.sharePercent, unit: 'percent', reset_at: null,
      source: 'fable-weekly-sensor', observed_at: iso(plan.observedAtMs) };
  } }];
}

function codex(o: ResourceLiveSourceOptions, home: string | undefined): ResourceLiveSource[] {
  return [{ tier: 'official', read: async () => {
    if (!home || !codexPoolHomeAllowed(home, o.operatorHome ?? homedir())) return null;
    const reading = await (o.readCodex ?? (dir => readCodexUsage({ home: dir })))(home);
    if (reading.pctUsed === null) return null;
    return { used: reading.pctUsed, limit: 100, unit: 'percent', reset_at: reading.resetAt, source: 'codex-app-server', observed_at: reading.fetchedAt };
  } }];
}

function codexPersonal(o: ResourceLiveSourceOptions): Record<'5h' | 'weekly', ResourceLiveSource> {
  let last: { at: number; reading: ReturnType<NonNullable<ResourceLiveSourceOptions['readCodex']>> } | undefined;
  const source = (kind: '5h' | 'weekly'): ResourceLiveSource => ({ tier: 'official', read: async now => {
    const home = o.codexPersonalHome;
    if (!home || !codexPoolHomeAllowed(home, o.operatorHome ?? homedir())) return null;
    if (last?.at !== now) {
      const reading = (o.readCodex ?? (dir => readCodexUsage({ home: dir, includeResetBank: true })))(home).then(async row => {
        const fetched = Date.parse(row.fetchedAt);
        if (row.resetBank && Number.isFinite(fetched) && now - fetched < RESOURCE_LIVE_STALE_MS) {
          await publishCodexResetBank(o.runsDir, iso(Math.min(now, fetched)), row.resetBank).catch(() => {});
        }
        return row;
      });
      last = { at: now, reading };
    }
    const reading = await last.reading;
    const window = reading.windows?.[kind];
    const fetched = Date.parse(reading.fetchedAt);
    return window && Number.isFinite(fetched) ? { used: window.pctUsed, limit: 100, unit: 'percent', reset_at: window.resetAt,
      source: `codex-app-server-${kind}`, observed_at: iso(Math.min(now, fetched)) } : null;
  } });
  return { '5h': source('5h'), weekly: source('weekly') };
}

const weeklyBudget = z.object({
  'codex-personal': z.object({
    weekly_used_pct: z.number().min(0).max(100),
    reset_at: z.iso.datetime({ offset: true }),
    as_of: z.iso.datetime({ offset: true }),
    source: z.enum(['reader-1 codex app-server rateLimits', 'codex-app-server-rate-limits-weekly']),
    estimated: z.literal(false).optional(),
  }),
});

function codexBudgetWeekly(runsDir: string): ResourceLiveSource {
  return { tier: 'official', read: async now => {
    const parsed = weeklyBudget.safeParse(await readPrivateJson(join(runsDir, 'queue', 'budget-overrides.json'), 1024 * 1024));
    if (!parsed.success) return null;
    const row = parsed.data['codex-personal'];
    const observed = Date.parse(row.as_of);
    const reset = Date.parse(row.reset_at);
    if (observed > now || now - observed >= RESOURCE_LIVE_STALE_MS || reset <= now || reset - observed > 7 * 86_400_000) return null;
    return { used: row.weekly_used_pct, limit: 100, unit: 'percent', reset_at: iso(reset),
      source: 'codex-budget-overrides-weekly', observed_at: iso(observed) };
  } };
}

/** A row of the "Every resource" registry, which already validates and normalizes these readers. */
function registry(o: ResourceLiveSourceOptions, id: UsageResourceId, tier: ResourceLiveTier): ResourceLiveSource {
  return { tier, read: async () => {
    const reader = usageResourceReaders({ ...o.resourceReaders, accountsRoot: o.accountsRoot,
      env: { ...(o.resourceReaders?.env ?? {}), ASHLR_RUNS_DIR: o.runsDir } })[id];
    const reading = reader ? await reader() : null;
    if (!reading || !validUsageReading(reading)) return null;
    return { used: reading.used, limit: reading.limit, unit: reading.unit,
      reset_at: id === 'claude-api-gift' ? null : reading.resetsAt,
      ...(id === 'claude-api-gift' && reading.resetsAt ? { expires_at: reading.resetsAt } : {}),
      source: reading.source, observed_at: reading.asOf };
  } };
}

function grok(o: ResourceLiveSourceOptions): ResourceLiveSource[] {
  return [{ tier: 'official', read: async (nowMs) => {
    const runway = await (o.readGrok ?? (now => readGrokUltraRunway(undefined, now)))(nowMs);
    const latest = runway.latest;
    if (runway.state !== 'current' || !latest) return null;
    const manual = latest.source === 'manual';
    return { used: Math.max(0, latest.totalPoints - latest.remainingPoints), limit: latest.totalPoints, unit: 'points',
      reset_at: runway.targetAt, source: manual ? 'grok-ultra-manual' : 'grok-ultra-app', observed_at: latest.timestamp,
      tier: manual ? 'operator-entry' : 'official' };
  } }];
}

/** Loopback only. Local models have no allowance: the reading is how many models are served. */
function local(o: ResourceLiveSourceOptions): ResourceLiveSource[] {
  return [{ tier: 'official', read: async (nowMs) => {
    const response = await (o.fetchImpl ?? fetch)(o.omlxUrl ?? 'http://127.0.0.1:8123/v1/models', { signal: AbortSignal.timeout(3000) });
    if (!response.ok) return null;
    const body = await response.json() as { data?: unknown };
    const count = Array.isArray(body.data) ? body.data.length : 0;
    if (count === 0) return null;
    return { used: null, limit: count, unit: 'models', reset_at: null, source: 'omlx-loopback-models', observed_at: iso(nowMs) };
  } }];
}

function loopbackModels(o: ResourceLiveSourceOptions, runtime: 'lm-studio' | 'ollama'): ResourceLiveSource[] {
  const path = runtime === 'lm-studio' ? 'http://127.0.0.1:1234/v1/models' : 'http://127.0.0.1:11434/api/tags';
  return [{ tier: 'official', read: async nowMs => {
    const response = await (o.fetchImpl ?? fetch)(path, { redirect: 'error', signal: AbortSignal.timeout(3000) });
    if (!response.ok) return null;
    const body = await response.json() as { data?: unknown; models?: unknown } | null;
    const models = runtime === 'lm-studio' ? body?.data : body?.models;
    return Array.isArray(models) ? { used: null, limit: models.length, unit: 'models', reset_at: null,
      source: `${runtime}-loopback-models`, observed_at: iso(nowMs) } : null;
  } }];
}

const evidenceSchema = z.object({
  used: z.number().finite().nonnegative(),
  limit: z.number().finite().positive(),
  observed_at: z.string().datetime(),
  reset_at: z.string().datetime().nullable(),
  window_start: z.string().datetime().optional(),
  expires_at: z.string().datetime().optional(),
}).strict();

type EvidenceId = 'antigravity' | 'google-workspace' | 'dot' | 'cursor' | 'grok-bot' | 'claude-api' | 'openai-api';
function agentCheck(load: () => Promise<unknown>, id: EvidenceId): ResourceLiveSource {
  const credit = id === 'claude-api' || id === 'openai-api';
  return { tier: 'operator-entry', read: async nowMs => {
    const file = await load() as Record<string, unknown> | null;
    if (file?.schema !== 'resource-evidence.v1' || typeof file.readings !== 'object' || file.readings === null) return null;
    const parsed = evidenceSchema.safeParse((file.readings as Record<string, unknown>)[id]);
    if (!parsed.success) return null;
    const row = parsed.data;
    const observed = Date.parse(row.observed_at);
    const start = row.window_start ? Date.parse(row.window_start) : null;
    if (observed > nowMs || nowMs - observed >= RESOURCE_LIVE_STALE_MS || row.used > row.limit
      || (start !== null && (start > observed || row.reset_at === null || start >= Date.parse(row.reset_at)))
      || (!credit && row.limit !== 100) || (credit && (!row.expires_at || Date.parse(row.expires_at) <= nowMs))) return null;
    return { ...row, unit: credit ? 'usd' : 'percent', source: `${id}-agent-check` };
  } };
}

function visible(o: ResourceLiveSourceOptions, siteId: UsageSite['id']): ResourceLiveSource[] {
  const site = USAGE_SITES.find(row => row.id === siteId);
  const session = o.browser;
  if (!site || !session) return [];
  return [{ tier: 'visible-window', read: async (nowMs) => {
    const reading = await readSite(site, session, nowMs);
    if (reading.status === 'needs-signin') return NEEDS_SIGNIN;
    if (reading.status !== 'ok') return null;
    return { used: reading.used, limit: reading.limit, unit: reading.unit, reset_at: reading.resetAt, source: 'browser-visible', observed_at: reading.observedAt };
  } }];
}

const weekly = () => import('../../devin/weekly-capacity.js');

function devinWeekly(o: ResourceLiveSourceOptions): ResourceLiveSource[] {
  return [
    { tier: 'official', read: async (nowMs) => {
      const m = await weekly();
      return m.devinWeeklyObservation(await (o.readDevinWeekly ?? ((now) => m.readDevinWeeklyCapacity({ nowMs: now })))(nowMs));
    } },
    // The last `phm capacity publish` measurement: shown as stale evidence once it ages out.
    { tier: 'official', read: async (nowMs) => {
      const m = await weekly();
      const last = (o.readDevinPublished ?? m.readPublishedDevinWeekly)(nowMs);
      return last && last.reset_at !== null && Date.parse(last.reset_at) > nowMs ? m.devinWeeklyObservation(last) : null;
    } },
  ];
}

function devinPreview(o: ResourceLiveSourceOptions): ResourceLiveSource[] {
  return [{ tier: 'official', read: async (nowMs) => {
    const m = await weekly();
    const catalog = o.readDevinModels ? await o.readDevinModels() : await (await import('../../devin/models.js')).getDevinModelCatalog({ cliPath: null });
    return m.devinPreviewObservation(catalog, nowMs);
  } }];
}

export function defaultResourceLiveSources(o: ResourceLiveSourceOptions): ResourceLiveSources {
  const personal = codexPersonal(o);
  const operator = (provider: 'claude' | 'codex-personal' | 'codex-cmp') => operatorPageSources(o.operatorPageFallback, provider, o.operatorPageReader);
  const evidence = (id: EvidenceId) => agentCheck(() => readResourceEvidenceFile(o.runsDir), id);
  const anthropic = o.anthropicCost ? [anthropicCostSource(o.anthropicCost, o.runAnthropicCost)] : [];
  return {
    'claude-weekly': [...claudeWeekly(o), ...visible(o, 'claude'), ...operator('claude')],
    'claude-fable': claudeFable(o),
    'claude-api': [...(o.anthropicCost?.expiresAt ? anthropic : []),
      ...(o.accountsRoot ? [registry(o, 'claude-api-gift', 'operator-entry')] : []), evidence('claude-api'),
      ...(!o.anthropicCost?.expiresAt ? anthropic : [])],
    'codex-personal': [personal.weekly, codexBudgetWeekly(o.runsDir), capacitySource('codex-personal', o.codexSeatMap, o.readCapacity),
      ...visible(o, 'chatgpt-codex'), ...operator('codex-personal')],
    'codex-personal-5h': [personal['5h']],
    'codex-cmp': [...codex(o, o.codexCmpHome), capacitySource('codex-cmp', o.codexSeatMap, o.readCapacity), ...operator('codex-cmp')],
    'openai-api': [evidence('openai-api')],
    devin: [registry(o, 'devin', 'official'), ...devinWeekly(o), ...visible(o, 'devin')],
    // Zero-cost SWE-2 Lightning/Flash previews the CLI lists as free, until they expire.
    'devin-flash': devinPreview(o),
    // The lane's own quota window, published by the dispatcher from its own calls.
    'glm-lite': [registry(o, 'zai', 'own-call'), ...visible(o, 'zai')],
    gemini: visible(o, 'gemini'),
    antigravity: [evidence('antigravity')],
    'google-workspace': [evidence('google-workspace')],
    dot: [evidence('dot')],
    instinct: [],
    local: local(o),
    'lm-studio': loopbackModels(o, 'lm-studio'),
    ollama: loopbackModels(o, 'ollama'),
    grok: grok(o),
    cursor: [evidence('cursor')],
    'grok-bot': [evidence('grok-bot')],
  };
}
