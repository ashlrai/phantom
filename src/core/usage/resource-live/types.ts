/**
 * resource-live.v1: the wire contract of state/resource-live.json.
 *
 * This file imports nothing, so node readers, the world model and the web UI
 * can all share it. Keys are snake_case because the Eng Ops resource-pool
 * builder (Python) merges this sidecar into state/resource-pool.json.
 *
 * Every number comes from a verified observation. An allowance with no
 * verified reading carries nulls and `verified: false`. It is never zero.
 */

export const RESOURCE_LIVE_SCHEMA = 'resource-live.v1' as const;
export const RESOURCE_HISTORY_SCHEMA = 'resource-live.history.v1' as const;
export interface ResourceHistoryPoint {
  observed_at: string; used: number; left: number | null; limit: number;
  unit: ResourceLiveUnit | null; reset_at: string | null; source: string;
  source_tier: ResourceLiveTier | null; confidence: ResourceLiveReading['confidence'];
}
export interface ResourceHistoryFile {
  schema: typeof RESOURCE_HISTORY_SCHEMA;
  allowances: Partial<Record<ResourceLiveId, ResourceHistoryPoint[]>>;
}
export interface LaneHistory {
  points: Array<{ observedAt: string; used: number; left: number | null; limit: number;
    unit: ResourceLiveUnit | null; source: string; confidence: ResourceLiveReading['confidence']; gapBefore: boolean }>;
  burn: { perHour: number; from: string; to: string } | null;
  exhaustAt: string | null; resetAt: string | null;
}
/** A reading older than this is not current. Same bound usage.sensors.v1 uses. */
export const RESOURCE_LIVE_STALE_MS = 15 * 60_000;

/**
 * free: no allowance to protect, spend first.
 * expiring: an allowance that ends for good on `expires_at`, spend first.
 * included: a subscription window that refills on reset.
 * metered-included: pay-per-use beyond an included credit. Only the credit is spendable.
 * reserve: kept for last.
 */
export type ResourceLiveClass = 'free' | 'expiring' | 'included' | 'metered-included' | 'reserve';

/** Where a reading came from, in the order sources are tried. */
export type ResourceLiveTier = 'official' | 'own-call' | 'visible-window' | 'operator-entry';

export type ResourceLiveUnit = 'percent' | 'acu' | 'usd' | 'points' | 'models';

export interface ResourceLiveAllowance {
  id: string;
  label: string;
  /** Dispatch lane this allowance pays for. Null when no fleet lane spends it. */
  lane: string | null;
  class: ResourceLiveClass;
  /** usage.sensors.v1 lane the reading feeds. Null keeps it out of the sensor report. */
  sensor_lane: string | null;
  /** Fixed end of an expiring allowance. Null for everything else. */
  expires_at: string | null;
  custom?: ResourceLiveCustom;
}

export interface ResourceLiveCustom {
  provider: string;
  kind: 'subscription' | 'promo-credit' | 'metered' | 'local' | 'bot';
  source: 'official-endpoint' | 'cli-status' | 'agent-check';
  metered_opt_in: boolean;
  window_hours: number | null;
}

/**
 * Expiry instants are the end of the named day in America/New_York (UTC-5 in
 * late November): CMP runs through Nov 25 and Devin Flash through Nov 30, 2026.
 */
export const CODEX_CMP_EXPIRES_AT = '2026-11-26T05:00:00.000Z';
export const DEVIN_FLASH_EXPIRES_AT = '2026-12-01T05:00:00.000Z';

export const RESOURCE_LIVE_ALLOWANCES = [
  { id: 'claude-weekly', label: 'Claude Max · Code & desktop', lane: 'claude', class: 'included', sensor_lane: 'claude-max', expires_at: null },
  { id: 'claude-fable', label: 'Claude Fable share', lane: 'claude', class: 'included', sensor_lane: null, expires_at: null },
  { id: 'claude-api', label: 'Claude API included credit', lane: 'claude-api', class: 'metered-included', sensor_lane: 'claude-api', expires_at: null },
  { id: 'codex-personal', label: 'ChatGPT / Codex personal', lane: 'codex-personal', class: 'included', sensor_lane: 'codex-personal', expires_at: null },
  { id: 'codex-personal-5h', label: 'ChatGPT / Codex personal · 5-hour', lane: 'codex-personal', class: 'included', sensor_lane: null, expires_at: null },
  { id: 'codex-cmp', label: 'Codex CMP', lane: 'codex-cmp', class: 'expiring', sensor_lane: 'codex-cmp', expires_at: CODEX_CMP_EXPIRES_AT },
  { id: 'openai-api', label: 'OpenAI API promotional credit', lane: null, class: 'metered-included', sensor_lane: null, expires_at: null },
  { id: 'devin', label: 'Devin Cloud', lane: 'devin', class: 'included', sensor_lane: 'devin', expires_at: null },
  { id: 'devin-flash', label: 'Devin CLI · SWE-2 Flash', lane: 'devin-flash', class: 'expiring', sensor_lane: 'devin-swe-flash', expires_at: DEVIN_FLASH_EXPIRES_AT },
  { id: 'glm-lite', label: 'Z.ai GLM Coding Lite', lane: 'zai', class: 'included', sensor_lane: 'zai', expires_at: null },
  { id: 'gemini', label: 'Gemini', lane: 'gemini', class: 'included', sensor_lane: 'gemini', expires_at: null },
  { id: 'antigravity', label: 'Google AI Ultra · Antigravity', lane: 'agy', class: 'included', sensor_lane: 'agy', expires_at: null },
  { id: 'google-workspace', label: 'Google Workspace · Antigravity starter', lane: null, class: 'included', sensor_lane: null, expires_at: null },
  { id: 'dot', label: 'OpenAI Dot · iMessage', lane: 'dot', class: 'free', sensor_lane: 'dot', expires_at: null },
  { id: 'instinct', label: 'Instinct', lane: 'instinct', class: 'included', sensor_lane: 'instinct', expires_at: null },
  // Local capacity is a model count, not a usage window, so it stays out of the sensor report.
  { id: 'local', label: 'Local models', lane: 'codex-local', class: 'free', sensor_lane: null, expires_at: null },
  { id: 'lm-studio', label: 'LM Studio', lane: null, class: 'free', sensor_lane: null, expires_at: null },
  { id: 'ollama', label: 'Ollama', lane: null, class: 'free', sensor_lane: null, expires_at: null },
  // Grok is a weekly allowance kept in reserve. When it is spent the lane sits at zero until the
  // reset and other lanes keep running. Policy (Eng Ops, 2026-11-09): never buy extra Grok credits.
  { id: 'grok', label: 'Grok', lane: 'grok', class: 'reserve', sensor_lane: 'grok-ultra', expires_at: null },
  { id: 'cursor', label: 'Cursor', lane: 'cursor', class: 'reserve', sensor_lane: 'cursor-cloud', expires_at: null },
  { id: 'grok-bot', label: 'Grok Bot · desktop', lane: null, class: 'included', sensor_lane: null, expires_at: null },
] as const satisfies readonly ResourceLiveAllowance[];

export type BuiltInResourceLiveId = (typeof RESOURCE_LIVE_ALLOWANCES)[number]['id'];
export type ResourceLiveId = BuiltInResourceLiveId | `custom:${string}`;

/** Fixed labels for why an allowance has no verified reading. Never provider text. */
export type ResourceLiveReason =
  | 'no-supported-source'
  | 'source-returned-nothing'
  | 'source-error'
  | 'source-timeout'
  | 'invalid-reading'
  | 'needs-signin'
  | 'window-reset';

export interface ResourceLiveReading {
  account_id?: string;
  model?: string;
  window_start?: string;
  id: ResourceLiveId;
  label: string;
  lane: string | null;
  class: ResourceLiveClass;
  custom?: ResourceLiveCustom;
  verified: boolean;
  confidence: 'high' | 'medium' | 'low' | null;
  used: number | null;
  limit: number | null;
  unit: ResourceLiveUnit | null;
  used_pct: number | null;
  remaining: number | null;
  reset_at: string | null;
  expires_at: string | null;
  source: string | null;
  source_tier: ResourceLiveTier | null;
  observed_at: string | null;
  stale_after: string | null;
  reason: ResourceLiveReason | null;
}

export type BurnDownAction = 'burn' | 'steady' | 'hold' | 'reserve';
export type BurnDownPace = 'behind' | 'on-pace' | 'ahead' | 'unknown';

export interface BurnDownRow {
  id: ResourceLiveId;
  lane: string | null;
  /** 0 free and expiring, 1 included, 2 included credit on a metered lane, 3 reserve. */
  tier: 0 | 1 | 2 | 3;
  /** 1 is spent first. */
  rank: number;
  action: BurnDownAction;
  reason: string;
  remaining: number | null;
  unit: ResourceLiveUnit | null;
  /** Reset or expiry, whichever ends the allowance first. */
  deadline_at: string | null;
  hours_to_deadline: number | null;
  /** remaining / hours_to_deadline, in `unit` per hour. */
  target_rate_per_hour: number | null;
  /** Measured from readings in the same window. Null until two samples agree. */
  observed_rate_per_hour: number | null;
  pace: BurnDownPace;
  /** Allowance left at the deadline at the observed rate. Null when the rate is unknown. */
  projected_unused: number | null;
}

export interface BurnDownPlan {
  generated_at: string;
  /** Lanes in spend order, each once. Lanes whose every allowance is held are absent. */
  lane_order: string[];
  allowances: BurnDownRow[];
  banked_resets?: { observed_at: string | null; count: number | null; grants: BankedResetGrant[] | null; proposal: BankedResetProposal | null };
}

export interface BankedResetGrant {
  count: number;
  kind: 'full' | '5h' | 'weekly';
  expires_at: string;
  source: 'chatgpt-settings-usage';
}

export interface BankedResetProposal {
  action: 'use-reset-now';
  requires_explicit_request: true;
  grant: BankedResetGrant;
  window: '5h' | 'weekly';
  usage_source: string;
  used_pct: number;
  reset_at: string;
  projected_exhaustion_at: string;
  queued_jobs: number;
}

export type ResetDraftKind = 'fable' | 'weekly';

export interface ResetDraft {
  kind: ResetDraftKind;
  used_pct: number;
  weekly_reset_at: string;
  hours_to_weekly_reset: number;
  source: string;
  observed_at: string;
}

export interface ResetRuleState {
  /** Last draft per kind. The window key stops a repeat for the same window. */
  fable: { drafted_at: string; window: string } | null;
  weekly: { drafted_at: string; window: string } | null;
  last_decision_file: string | null;
}

export interface PollState {
  last_polled_at: string;
  next_poll_at: string;
  interval_s: number;
  /** Whether the lane was active when the interval was chosen. */
  active: boolean;
  fingerprint: string | null;
}

export interface HistorySample {
  observed_at: string;
  used: number;
  reset_at: string | null;
}

export interface ResourceLiveSidecar {
  schema: typeof RESOURCE_LIVE_SCHEMA;
  generated_at: string;
  writer: 'phm usage resource-live';
  readings: ResourceLiveReading[];
  burn_down: BurnDownPlan;
  reset_rule: ResetRuleState;
  poll: Partial<Record<ResourceLiveId, PollState>>;
  history: Partial<Record<ResourceLiveId, HistorySample[]>>;
  next_poll_at: string;
}
