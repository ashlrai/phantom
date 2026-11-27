/**
 * resource-usage-types.ts — the wire contract for the "Every resource" usage
 * panel (RQ-NIGHT-USAGE-1). Pure types plus the fixed resource roster: this
 * file imports NOTHING, so both the node readers (resource-usage.ts) and the
 * browser model (web-ui usage-resources-model.ts) can share it.
 */

/** The twelve resources, in panel order. */
export const USAGE_RESOURCES = [
  { id: 'ultra', label: 'Ultra (Cursor + Grok pool)' },
  { id: 'claude-max', label: 'Claude Max' },
  { id: 'claude-api-gift', label: 'claude-api gift' },
  { id: 'claude-api-monthly', label: 'claude-api monthly' },
  { id: 'codex-personal', label: 'codex-personal' },
  { id: 'devin', label: 'Devin' },
  { id: 'zai', label: 'zai' },
  { id: 'agy', label: 'agy' },
  { id: 'gemini-workspace', label: 'Gemini (Workspace)' },
  { id: 'local', label: 'local' },
  { id: 'stacksync', label: 'Stacksync' },
] as const;

export type UsageResourceId = (typeof USAGE_RESOURCES)[number]['id'];

/** The unit `used` and `limit` are expressed in. */
export type UsageResourceUnit = 'percent' | 'acu' | 'usd' | 'points';

/**
 * One reading of one resource. Numbers only; `source` is a fixed label the
 * reader owns ('codex-session-logs'), never provider text. `resetsAt` and
 * `asOf` are ISO-8601 instants or null. A null `used` is a real answer
 * ("the window is unmeasured"), distinct from no reading at all.
 */
export interface UsageResourceReading {
  used: number | null;
  limit: number | null;
  unit: UsageResourceUnit;
  resetsAt: string | null;
  source: string;
  asOf: string;
}

/** What a follow-up implements: read one resource, return its reading or null. */
export type UsageResourceReader = () =>
  | Promise<UsageResourceReading | null>
  | UsageResourceReading
  | null;

export type UsageResourceRowState = 'ok' | 'no-reading' | 'no-reader' | 'unavailable';
export type UsageResourceRowReason = 'reader-timeout' | 'reader-error' | 'invalid-reading' | null;

export interface UsageResourceRow {
  id: UsageResourceId;
  label: string;
  state: UsageResourceRowState;
  used: number | null;
  limit: number | null;
  unit: UsageResourceUnit | null;
  resetsAt: string | null;
  source: string | null;
  asOf: string | null;
  reason: UsageResourceRowReason;
}

export interface UsageResourcesSnapshot {
  v: 1;
  generatedAt: string;
  resources: UsageResourceRow[];
}

// ---------------------------------------------------------------------------
// Shared pure helpers (zero imports; safe for node, browser, and Tier-1 closure)
// ---------------------------------------------------------------------------

/** Narrow an unknown value to a plain non-array JSON object record. */
export function isUsageRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Return `value` as a plain record, or an empty object for primitives, null, or arrays. */
export function asUsageRecord(value: unknown): Record<string, unknown> {
  return isUsageRecord(value) ? value : {};
}

/** Narrow an unknown value to a finite number. */
export function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** Narrow an unknown value to a finite non-negative number. */
export function isNonNegativeNumber(value: unknown): value is number {
  return isFiniteNumber(value) && value >= 0;
}

/** Return `value` when it is a finite non-negative number, otherwise null. */
export function asNonNegativeNumber(value: unknown): number | null {
  return isNonNegativeNumber(value) ? value : null;
}

/** Round `value` to `places` decimal places using standard half-up rounding. */
export function roundTo(value: number, places: number): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

/** Format a non-negative minute count as "3d 4h", "5h 12m", or "40m". */
export function formatDurationMinutes(minutes: number): string {
  const d = Math.floor(minutes / 1440);
  const h = Math.floor((minutes % 1440) / 60);
  const m = minutes % 60;
  return d > 0 ? `${d}d ${h}h` : h > 0 ? `${h}h ${m}m` : `${m}m`;
}

/** True when `value` parses as a finite Date and round-trips identically via `toISOString()`. */
export function isCanonicalIsoTimestamp(value: string): boolean {
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value;
}

/** Max valid ECMAScript Date epoch in seconds (`8.64e15 ms / 1000`). */
const MAX_EPOCH_SECONDS = 8.64e12;

/** Parse an ISO timestamp string or epoch-seconds number into epoch ms, or NaN. */
export function parseEpochOrIsoMs(value: unknown): number {
  if (typeof value === 'string') return Date.parse(value);
  if (isFiniteNumber(value) && Math.abs(value) <= MAX_EPOCH_SECONDS) return value * 1000;
  return NaN;
}

export interface ParsedDispatchStatus {
  status: Record<string, unknown>;
  budget: Record<string, unknown>;
  tickMs: number;
  asOf: string | null;
  fresh: boolean;
}

/** Parse the common `dispatchd.status.v1` envelope and evaluate tick freshness. */
export function parseDispatchStatus(
  raw: unknown,
  now: number,
  maxAgeMs = 120_000,
): ParsedDispatchStatus {
  const status = asUsageRecord(raw);
  const tickMs = typeof status['last_tick'] === 'string' ? Date.parse(status['last_tick']) : NaN;
  const fresh = status['schema'] === 'dispatchd.status.v1'
    && Number.isFinite(tickMs) && now >= tickMs && now - tickMs <= maxAgeMs;
  const budget = asUsageRecord(status['budget']);
  const asOf = Number.isFinite(tickMs) ? new Date(tickMs).toISOString() : null;
  return { status, budget, tickMs, asOf, fresh };
}

/** True when `path` contains a `.codex*` path segment (forbidden for usage readers/profiles). */
export function isCodexHomePath(path: string): boolean {
  return /(?:^|\/)\.codex[^/]*(?:\/|$)/.test(path);
}

export type DeadlineOutcome<T> =
  | { kind: 'value'; value: T }
  | { kind: 'timeout' }
  | { kind: 'error' };

/**
 * Race `task` against `deadlineMs`, converting sync throws and async rejections
 * into `{ kind: 'error' }` and unref'ing the timer so it never pins the event loop.
 */
export async function raceWithDeadline<T>(
  task: () => Promise<T> | T,
  deadlineMs: number,
): Promise<DeadlineOutcome<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const work = Promise.resolve()
    .then(() => task())
    .then((value): DeadlineOutcome<T> => ({ kind: 'value', value }))
    .catch((): DeadlineOutcome<T> => ({ kind: 'error' }));
  const timeout = new Promise<DeadlineOutcome<T>>((resolve) => {
    timer = setTimeout(() => resolve({ kind: 'timeout' }), deadlineMs);
    if (typeof timer === 'object' && timer !== null && 'unref' in timer) {
      (timer as { unref(): void }).unref();
    }
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
