/**
 * resource-usage.ts — RQ-NIGHT-USAGE-1: ONE usage row per operator resource,
 * behind ONE reader interface, feeding the Verse "Every resource" panel on
 * desktop and mobile.
 *
 * The repo already owns several usage signals — Codex session logs, the Devin
 * org-cycle reader, the Grok Ultra runway store, the Claude Code OAuth usage
 * endpoint and the recorded Claude API promotion (gift) store — but nothing
 * named them uniformly. This module is that naming:
 *
 *   UsageResourceReader — one function per resource returning the same
 *     reading shape: used / limit / unit / resets-at / source / as-of,
 *     or null when the reader ran but has nothing to report.
 *
 *   usageResourceReaders() — the registry mapping each of the twelve
 *     resources to a reader or null. A resource with no reader is an
 *     explicit "no reader yet" row — adding one is a small follow-up that
 *     touches this file only.
 *
 *   readUsageResources() — the aggregate the HTTP route calls: every
 *     resource, every row, never throwing, never naming provider internals,
 *     never carrying a credential. Readers are validated at the boundary:
 *     a reader that returns a secret-shaped or malformed value does not
 *     reach the wire.
 *
 * SAFETY INVARIANTS (same bar as the readers themselves):
 *  - Readers return only numbers, ISO instants and fixed source labels —
 *    no free-form provider text, no error bodies, no account identity.
 *  - A reader failure is a state ('unavailable'), never a throw and never
 *    an echoed message — provider errors can carry private detail.
 *  - No reading is ever fabricated: unknown usage is null, not 0%.
 */

import { collectCodexSessionUsages, type CodexSessionUsage } from '../fleet/codex-session-usage.js';
import { readDevinUsage, type DevinUsageResult } from '../fabric/readers/devin-usage.js';
import { readGrokUltraRunway } from '../fleet/grok-ultra-store.js';
import type { GrokUltraRunway } from '../fleet/grok-ultra-types.js';
import { fetchClaudeUsageApi, type ClaudeApiUsageResult } from '../fabric/usage-api.js';
import { readClaudeApiGrantViews } from '../resources/claude-api-grant.js';
import type { ClaudeApiGrantReadView } from '../resources/claude-api-grant-types.js';
import {
  USAGE_RESOURCES,
  type UsageResourceId,
  type UsageResourceReader,
  type UsageResourceReading,
  type UsageResourceRow,
  type UsageResourceRowReason,
  type UsageResourceRowState,
  type UsageResourcesSnapshot,
  type UsageResourceUnit,
} from './resource-usage-types.js';

export {
  USAGE_RESOURCES,
  type UsageResourceId,
  type UsageResourceReader,
  type UsageResourceReading,
  type UsageResourceRow,
  type UsageResourceRowReason,
  type UsageResourceRowState,
  type UsageResourcesSnapshot,
  type UsageResourceUnit,
};

// ---------------------------------------------------------------------------
// Reading validation — the boundary a reader's return must cross
// ---------------------------------------------------------------------------

const UNITS: readonly UsageResourceUnit[] = ['percent', 'acu', 'usd', 'points'];
const SOURCE_MAX = 128;

function finiteAmount(value: unknown): value is number | null {
  return value === null || (typeof value === 'number' && Number.isFinite(value) && value >= 0);
}

function isoInstant(value: unknown): value is string | null {
  return value === null ||
    (typeof value === 'string' && Number.isFinite(Date.parse(value)));
}

function sourceLabel(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > SOURCE_MAX) return false;
  for (const ch of value) {
    const code = ch.charCodeAt(0);
    if (code < 32 || code >= 127) return false;
  }
  return true;
}

/** Exactly the contract fields, allowlisted; anything else fails closed. */
export function validUsageReading(value: unknown): value is UsageResourceReading {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return Object.keys(row).every((key) =>
    ['used', 'limit', 'unit', 'resetsAt', 'source', 'asOf'].includes(key)) &&
    finiteAmount(row['used']) && finiteAmount(row['limit']) &&
    typeof row['unit'] === 'string' && UNITS.includes(row['unit'] as UsageResourceUnit) &&
    isoInstant(row['resetsAt']) && isoInstant(row['asOf']) && typeof row['asOf'] === 'string' &&
    sourceLabel(row['source']);
}

// ---------------------------------------------------------------------------
// Reader context — the dependencies adapters close over (test seams)
// ---------------------------------------------------------------------------

export interface UsageResourceReaderDeps {
  /** Codex credential-home env/home overrides; default process env + homedir. */
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  /** Accounts root for the Claude API promotion (gift) store. */
  accountsRoot?: string;
  now?: () => number;
  /** Reader seams — default to the repo's real readers. */
  collectCodex?: typeof collectCodexSessionUsages;
  readDevin?: () => Promise<DevinUsageResult>;
  readUltra?: () => Promise<GrokUltraRunway>;
  readClaude?: () => Promise<ClaudeApiUsageResult | null>;
  readGrants?: (root: string) => Promise<ClaudeApiGrantReadView>;
}

// ---------------------------------------------------------------------------
// Adapters — one per existing reader, each returning null when the
// underlying read produced nothing (unknown is never a number)
// ---------------------------------------------------------------------------

/** The most-saturated of an account's windows governs; ties take the later reset. */
function codexWindow(usage: CodexSessionUsage): { pct: number; resetsAt: string | null } | null {
  const windows = [usage.primary, usage.secondary]
    .filter((w): w is NonNullable<typeof w> => w !== null && Number.isFinite(w.usedPercent))
    .map((w) => ({
      pct: Math.max(0, Math.min(100, w.usedPercent)),
      resetsAt: w.resetsAt !== null ? new Date(w.resetsAt * 1000).toISOString() : null,
    }));
  const fullest = windows.sort((a, b) => b.pct - a.pct || Date.parse(b.resetsAt ?? '0') - Date.parse(a.resetsAt ?? '0'))[0];
  return fullest ?? null;
}

/** Both codex rows read the same scan; collect it lazily, once per aggregate. */
function codexUsages(deps: UsageResourceReaderDeps): () => CodexSessionUsage[] {
  const collect = deps.collectCodex ?? collectCodexSessionUsages;
  let cached: CodexSessionUsage[] | null = null;
  return () => cached ??= collect({ env: deps.env ?? process.env, homeDir: deps.homeDir });
}

function codexReader(accountId: 'codex-cmp' | 'codex-personal', deps: UsageResourceReaderDeps,
  usages: () => CodexSessionUsage[]): UsageResourceReader {
  return () => {
    const usage = usages().find((u) => u.accountId === accountId) ?? null;
    if (!usage) return null;
    const window = codexWindow(usage);
    const asOf = usage.observedAt !== null && Number.isFinite(Date.parse(usage.observedAt))
      ? new Date(Date.parse(usage.observedAt)).toISOString()
      : new Date((deps.now ?? Date.now)()).toISOString();
    if (!window) {
      // The account exists but no window was measured — a real answer of unknown.
      return { used: null, limit: 100, unit: 'percent', resetsAt: null, source: 'codex-session-logs', asOf };
    }
    return { used: window.pct, limit: 100, unit: 'percent', resetsAt: window.resetsAt, source: 'codex-session-logs', asOf };
  };
}

function devinReader(deps: UsageResourceReaderDeps): UsageResourceReader {
  return async () => {
    const read = deps.readDevin ?? readDevinUsage;
    const result = await read();
    if ('status' in result) return null;
    return {
      used: result.acuUsed,
      limit: result.acuLimit,
      unit: 'acu',
      resetsAt: result.resetAt,
      source: result.source,
      asOf: result.fetchedAt,
    };
  };
}

function ultraReader(deps: UsageResourceReaderDeps): UsageResourceReader {
  return async () => {
    const read = deps.readUltra ?? readGrokUltraRunway;
    const runway = await read();
    const latest = runway.latest;
    if (!latest) return null;
    const used = latest.totalPoints - latest.remainingPoints;
    return {
      used: used >= 0 ? used : 0,
      limit: latest.totalPoints,
      unit: 'points',
      resetsAt: runway.targetAt,
      source: latest.source === 'manual' ? 'grok-ultra-manual' : 'grok-ultra-app',
      asOf: latest.timestamp,
    };
  };
}

/** The OAuth usage endpoint's most-saturated subscription window governs. */
function claudeMaxReader(deps: UsageResourceReaderDeps): UsageResourceReader {
  return async () => {
    const read = deps.readClaude ?? fetchClaudeUsageApi;
    const usage = await read();
    if (!usage) return null;
    const windows = [
      { pct: usage.fiveHourPct, reset: usage.fiveHourResetAt },
      { pct: usage.weeklyPct, reset: usage.weeklyResetAt },
    ].filter((w): w is { pct: number; reset: number | null } => w.pct !== null);
    const fullest = windows.sort((a, b) => b.pct - a.pct || (b.reset ?? 0) - (a.reset ?? 0))[0];
    if (!fullest) return null;
    const at = new Date((deps.now ?? Date.now)()).toISOString();
    return {
      used: Math.max(0, fullest.pct),
      limit: 100,
      unit: 'percent',
      resetsAt: fullest.reset !== null ? new Date(fullest.reset * 1000).toISOString() : null,
      source: 'claude-oauth-usage',
      asOf: at,
    };
  };
}

/** API promotional (gift) balance: the newest recorded observation's remaining / total. */
function claudeApiGiftReader(deps: UsageResourceReaderDeps): UsageResourceReader {
  return async () => {
    const root = deps.accountsRoot;
    if (!root) return null;
    const read = deps.readGrants ?? readClaudeApiGrantViews;
    const view = await read(root);
    if (view.state !== 'healthy') return null;
    const recorded = view.rows.filter((row) => row.state === 'recorded');
    const latest = recorded.sort((a, b) =>
      Date.parse(b.capturedAt ?? '0') - Date.parse(a.capturedAt ?? '0'))[0];
    if (!latest || !latest.capturedAt) return null;
    const micros = (value: string | null): number | null =>
      value === null ? null : Number(BigInt(value)) / 1_000_000;
    const remaining = micros(latest.remainingUsdMicros);
    const total = micros(latest.totalUsdMicros);
    if (remaining === null && total === null) return null;
    return {
      used: remaining !== null && total !== null ? Math.max(0, total - remaining) : null,
      limit: total,
      unit: 'usd',
      resetsAt: latest.admissionCutoff,
      source: 'claude-api-grant-store',
      asOf: latest.capturedAt,
    };
  };
}

/** Monthly usage-credit consumption reported by the OAuth usage endpoint. */
function claudeApiMonthlyReader(deps: UsageResourceReaderDeps): UsageResourceReader {
  return async () => {
    const read = deps.readClaude ?? fetchClaudeUsageApi;
    const usage = await read();
    const extra = usage?.extraUsage;
    if (!usage || !extra) return null;
    if (!Number.isFinite(extra.usedCredits) || !Number.isFinite(extra.monthlyLimit)) return null;
    return {
      used: Math.max(0, extra.usedCredits),
      limit: Math.max(0, extra.monthlyLimit),
      unit: 'usd',
      resetsAt: null, // The endpoint does not name the cycle boundary — never invent one.
      source: 'claude-oauth-usage',
      asOf: new Date((deps.now ?? Date.now)()).toISOString(),
    };
  };
}

// ---------------------------------------------------------------------------
// The registry — null is the honest "no reader yet" marker
// ---------------------------------------------------------------------------

/**
 * Every resource mapped to its reader, or null when nothing in the repo
 * reads it yet. A follow-up reader changes this file only.
 */
export function usageResourceReaders(
  deps: UsageResourceReaderDeps = {},
): Record<UsageResourceId, UsageResourceReader | null> {
  const codex = codexUsages(deps);
  return {
    ultra: ultraReader(deps),
    'claude-max': claudeMaxReader(deps),
    'claude-api-gift': claudeApiGiftReader(deps),
    'claude-api-monthly': claudeApiMonthlyReader(deps),
    'codex-cmp': codexReader('codex-cmp', deps, codex),
    'codex-personal': codexReader('codex-personal', deps, codex),
    devin: devinReader(deps),
    zai: null,
    agy: null,
    'gemini-workspace': null,
    local: null,
    stacksync: null,
  };
}

// ---------------------------------------------------------------------------
// Aggregate — every row, never throwing
// ---------------------------------------------------------------------------

const DEFAULT_DEADLINE_MS = 12_000;

type ReaderOutcome =
  | { kind: 'reading'; value: UsageResourceReading | null }
  | { kind: 'timeout' }
  | { kind: 'error' };

function emptyRow(id: UsageResourceId, label: string, state: UsageResourceRowState,
  reason: UsageResourceRowReason = null): UsageResourceRow {
  return { id, label, state, used: null, limit: null, unit: null, resetsAt: null, source: null, asOf: null, reason };
}

async function runReader(reader: UsageResourceReader, deadlineMs: number): Promise<ReaderOutcome> {
  const work = Promise.resolve()
    .then(() => reader())
    .then((value): ReaderOutcome => ({ kind: 'reading', value }))
    .catch((): ReaderOutcome => ({ kind: 'error' }));
  const timeout = new Promise<ReaderOutcome>((resolve) => {
    // A pending deadline must not hold a short-lived process open.
    setTimeout(() => resolve({ kind: 'timeout' }), deadlineMs).unref();
  });
  // Promise.race keeps handlers on the loser, so a late rejection is handled.
  return Promise.race([work, timeout]);
}

export interface UsageResourcesOptions extends UsageResourceReaderDeps {
  /** Per-reader deadline before a row reports 'unavailable'. Default 12 s. */
  deadlineMs?: number;
  /** Row-level overrides for tests; merged over the registry. */
  readers?: Partial<Record<UsageResourceId, UsageResourceReader | null>>;
}

/**
 * Read every resource concurrently. A reader that is still running when the
 * deadline lands is 'unavailable' — its own cache still completes, so the
 * next poll usually has it. Throws are 'unavailable' rows, malformed returns
 * 'unavailable' too: nothing a reader produces reaches the wire unchecked.
 */
export async function readUsageResources(options: UsageResourcesOptions = {}): Promise<UsageResourcesSnapshot> {
  const now = options.now ?? Date.now;
  const deadlineMs = options.deadlineMs ?? DEFAULT_DEADLINE_MS;
  const readers = { ...usageResourceReaders(options), ...options.readers };
  const rows = await Promise.all(USAGE_RESOURCES.map(async ({ id, label }): Promise<UsageResourceRow> => {
    const reader = readers[id];
    if (!reader) return emptyRow(id, label, 'no-reader');
    const outcome = await runReader(reader, deadlineMs);
    if (outcome.kind === 'timeout') return emptyRow(id, label, 'unavailable', 'reader-timeout');
    if (outcome.kind === 'error') return emptyRow(id, label, 'unavailable', 'reader-error');
    if (outcome.value === null) return emptyRow(id, label, 'no-reading');
    if (!validUsageReading(outcome.value)) return emptyRow(id, label, 'unavailable', 'invalid-reading');
    return {
      id, label, state: 'ok',
      used: outcome.value.used, limit: outcome.value.limit, unit: outcome.value.unit,
      resetsAt: outcome.value.resetsAt, source: outcome.value.source, asOf: outcome.value.asOf,
      reason: null,
    };
  }));
  return { v: 1, generatedAt: new Date(now()).toISOString(), resources: rows };
}
