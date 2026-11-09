/**
 * Turn official usage payloads into sensor readings. This module only parses
 * values the caller already fetched. It does not open files, homes or
 * credential stores.
 */
import { parseDevinDailyConsumption } from '../devin/client.js';
import { parseCodexUsage } from '../fabric/readers/codex-usage.js';
import { parseClaudeUsage } from '../fabric/status-readings.js';
import { parseClaudeNativeUsage, parseClaudeNativeUsageStream } from '../resources/claude-account-usage.js';
import {
  USAGE_SENSOR_STALE_MS,
  unmeasuredSensor,
  type UsageSensorLane,
  type UsageSensorReading,
  type UsageSensorSource,
  type UsageSensorUnit,
} from './sensor-reading.js';

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function stamp(
  lane: UsageSensorLane,
  source: UsageSensorSource,
  used: number,
  limit: number,
  unit: UsageSensorUnit,
  resetAt: string | null,
  nowMs: number,
): UsageSensorReading {
  const observedAt = new Date(nowMs).toISOString();
  return {
    lane,
    observedAt,
    source,
    staleAfter: new Date(nowMs + USAGE_SENSOR_STALE_MS).toISOString(),
    used,
    limit,
    unit,
    resetAt,
  };
}

function orgAcuLimit(value: unknown): number | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (row['scope'] !== 'org' || !finite(row['cycle_acu_limit'])) return null;
  return row['cycle_acu_limit'];
}

/** Official org ACU limit object, or a one-item list of that object. */
export function parseDevinAcuLimit(value: unknown): number | null {
  if (Array.isArray(value)) return value.length === 1 ? orgAcuLimit(value[0]) : null;
  return orgAcuLimit(value);
}

/**
 * Official `GET /v3/organizations/{org}/consumption/daily` plus the org
 * `cycle_acu_limit`. A missing Devin product bucket is unknown, not zero.
 */
export function parseDevinDailyAcu(daily: unknown, limit: unknown, nowMs: number): UsageSensorReading | null {
  if (!Number.isFinite(nowMs)) return null;
  const report = parseDevinDailyConsumption(daily);
  const cap = parseDevinAcuLimit(limit);
  if (!report || cap === null) return null;
  let used = 0;
  for (const day of report.days) {
    if (day.products.devin === null) return null;
    used += day.products.devin;
  }
  if (!Number.isFinite(used) || used > report.totalAcus) return null;
  if (report.totalAcus > 0 && report.days.length === 0) return null;
  return stamp('devin', 'devin-api-v3-daily', used, cap, 'acu', null, nowMs);
}

/** Official Codex App Server `account/rateLimits/read` result. The fullest window binds. */
export function parseCodexSensor(
  lane: 'codex-cmp' | 'codex-personal',
  payload: unknown,
  nowMs: number,
): UsageSensorReading | null {
  if (!Number.isFinite(nowMs)) return null;
  const parsed = parseCodexUsage(payload, nowMs);
  if (parsed.pctUsed === null) return null;
  return stamp(lane, 'codex-app-server', parsed.pctUsed, 100, 'percent', parsed.resetAt, nowMs);
}

function claudeWindow(payload: string, nowMs: number): { used: number; resetAt: string | null } | null {
  const observedAt = new Date(nowMs).toISOString();
  const stream = payload.includes('usage_report')
    ? parseClaudeNativeUsageStream(payload, observedAt)
    : null;
  const windows = stream?.windows ?? parseClaudeNativeUsage(payload);
  if (!windows) return null;
  const window = windows.find(row => row.id === 'seven_day') ?? windows.find(row => row.id === 'five_hour');
  if (!window || typeof window.usedPercent !== 'number') return null;
  return { used: window.usedPercent, resetAt: window.resetsAt };
}

/** Official Claude usage JSON, stream JSONL, or a sanitized rate_limit_event. */
export function parseClaudeSensor(payload: unknown, nowMs: number): UsageSensorReading | null {
  if (!Number.isFinite(nowMs)) return null;
  if (typeof payload === 'string') {
    const window = claudeWindow(payload, nowMs);
    return window ? stamp('claude-max', 'claude-usage', window.used, 100, 'percent', window.resetAt, nowMs) : null;
  }
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const row = payload as Record<string, unknown>;
  if (typeof row['utilization'] !== 'number') return null;
  const parsed = parseClaudeUsage(payload, nowMs);
  if (parsed.pctUsed === null) return null;
  const captured = typeof row['capturedAt'] === 'string' ? Date.parse(row['capturedAt']) : NaN;
  const observedMs = Number.isFinite(captured) && captured <= nowMs ? captured : nowMs;
  const observedAt = new Date(observedMs).toISOString();
  return {
    lane: 'claude-max',
    observedAt,
    source: 'claude-rate-limit-event',
    staleAfter: new Date(observedMs + USAGE_SENSOR_STALE_MS).toISOString(),
    used: parsed.pctUsed,
    limit: 100,
    unit: 'percent',
    resetAt: parsed.resetAt,
  };
}

/** Official status object `{ pctUsed, resetAt }`. Page text and cookies are not accepted. */
export function parseGrokSensor(payload: unknown, nowMs: number): UsageSensorReading | null {
  if (!Number.isFinite(nowMs) || payload === null || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const row = payload as Record<string, unknown>;
  if (!finite(row['pctUsed']) || row['pctUsed'] > 100 || typeof row['resetAt'] !== 'string') return null;
  const resetMs = Date.parse(row['resetAt']);
  if (!Number.isFinite(resetMs) || resetMs <= nowMs) return null;
  return stamp('grok-ultra', 'grok-status', row['pctUsed'], 100, 'percent', new Date(resetMs).toISOString(), nowMs);
}

export interface UsageSensorRefreshInput {
  nowMs: number;
  devin?: { daily: unknown; limit: unknown } | null;
  codexCmp?: unknown;
  codexPersonal?: unknown;
  claude?: unknown;
  grok?: unknown;
}

function chosen(lane: UsageSensorLane, reading: UsageSensorReading | null, nowMs: number): UsageSensorReading {
  return reading ?? unmeasuredSensor(lane, nowMs);
}

/** Build one reading per lane from official payloads already in hand. */
export function refreshUsageSensors(input: UsageSensorRefreshInput): UsageSensorReading[] {
  const nowMs = input.nowMs;
  return [
    chosen('devin', input.devin ? parseDevinDailyAcu(input.devin.daily, input.devin.limit, nowMs) : null, nowMs),
    chosen('codex-cmp', input.codexCmp === undefined ? null : parseCodexSensor('codex-cmp', input.codexCmp, nowMs), nowMs),
    chosen('codex-personal', input.codexPersonal === undefined ? null : parseCodexSensor('codex-personal', input.codexPersonal, nowMs), nowMs),
    chosen('claude-max', input.claude === undefined ? null : parseClaudeSensor(input.claude, nowMs), nowMs),
    chosen('grok-ultra', input.grok === undefined ? null : parseGrokSensor(input.grok, nowMs), nowMs),
    chosen('terra', null, nowMs),
  ];
}
