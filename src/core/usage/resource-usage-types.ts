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
  { id: 'codex-cmp', label: 'codex-cmp' },
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
