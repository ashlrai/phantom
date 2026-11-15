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

/** Included Devin allowance. This does not read or change the ACU cap. */
export function parseDevinIncluded(
  lane: 'devin-swe-flash' | 'devin-weekly',
  payload: unknown,
  nowMs: number,
): UsageSensorReading | null {
  if (!Number.isFinite(nowMs) || payload === null || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const row = payload as Record<string, unknown>;
  if (!finite(row['used']) || !finite(row['limit']) || typeof row['resetAt'] !== 'string') return null;
  const resetMs = Date.parse(row['resetAt']);
  if (!Number.isFinite(resetMs) || resetMs <= nowMs) return null;
  const unit = row['unit'] === 'acu' || row['unit'] === 'percent' ? row['unit'] : null;
  if (!unit) return null;
  return {
    ...stamp(lane, 'devin-included-allowance', row['used'], row['limit'], unit, new Date(resetMs).toISOString(), nowMs),
  };
}

/** Official status object `{ pctUsed, resetAt }` for Dot, Cursor cloud, or Grok Bot. */
export function parseOfficialPercent(lane: 'dot' | 'cursor-cloud' | 'grok-bot', payload: unknown, nowMs: number): UsageSensorReading | null {
  const parsed = parseGrokSensor(payload, nowMs);
  if (!parsed) return null;
  const source = lane === 'dot' ? 'dot-status' : lane === 'cursor-cloud' ? 'cursor-status' : 'grok-status';
  return { ...parsed, lane, source };
}

/** Local throughput. There is no allowance, so limit and headroom stay empty. */
export function parseLocalThroughput(payload: unknown, nowMs: number): UsageSensorReading | null {
  if (!Number.isFinite(nowMs) || payload === null || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const completed = (payload as Record<string, unknown>)['completed'];
  if (!finite(completed)) return null;
  const observedAt = new Date(nowMs).toISOString();
  return {
    lane: 'local', observedAt, source: 'local-throughput',
    staleAfter: new Date(nowMs + USAGE_SENSOR_STALE_MS).toISOString(),
    used: completed, limit: null, unit: null, resetAt: null,
  };
}

/** Claude API balance. A balance is not spend approval. */
export function parseClaudeApiBalance(payload: unknown, nowMs: number): UsageSensorReading | null {
  if (!Number.isFinite(nowMs) || payload === null || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const row = payload as Record<string, unknown>;
  if (!finite(row['spent']) || !finite(row['balance'])) return null;
  return stamp('claude-api', 'claude-api-balance', row['spent'], row['spent'] + row['balance'], 'acu', null, nowMs);
}

export interface UsageSensorRefreshInput {
  nowMs: number;
  devin?: { daily: unknown; limit: unknown } | null;
  devinSweFlash?: unknown;
  devinWeekly?: unknown;
  codexCmp?: unknown;
  codexPersonal?: unknown;
  dot?: unknown;
  claude?: unknown;
  claudeApi?: unknown;
  cursorCloud?: unknown;
  grok?: unknown;
  grokBot?: unknown;
  local?: unknown;
}

function chosen(lane: UsageSensorLane, reading: UsageSensorReading | null, nowMs: number): UsageSensorReading {
  return reading ?? unmeasuredSensor(lane, nowMs);
}

/** Build one reading per lane from official payloads already in hand. */
export function refreshUsageSensors(input: UsageSensorRefreshInput): UsageSensorReading[] {
  const nowMs = input.nowMs;
  const produced = new Map<UsageSensorReading['lane'], UsageSensorReading>([
    ['devin', chosen('devin', input.devin ? parseDevinDailyAcu(input.devin.daily, input.devin.limit, nowMs) : null, nowMs)],
    ['devin-swe-flash', chosen('devin-swe-flash', input.devinSweFlash === undefined ? null : parseDevinIncluded('devin-swe-flash', input.devinSweFlash, nowMs), nowMs)],
    ['devin-weekly', chosen('devin-weekly', input.devinWeekly === undefined ? null : parseDevinIncluded('devin-weekly', input.devinWeekly, nowMs), nowMs)],
    ['codex-cmp', chosen('codex-cmp', input.codexCmp === undefined ? null : parseCodexSensor('codex-cmp', input.codexCmp, nowMs), nowMs)],
    ['codex-personal', chosen('codex-personal', input.codexPersonal === undefined ? null : parseCodexSensor('codex-personal', input.codexPersonal, nowMs), nowMs)],
    ['dot', chosen('dot', input.dot === undefined ? null : parseOfficialPercent('dot', input.dot, nowMs), nowMs)],
    ['claude-max', chosen('claude-max', input.claude === undefined ? null : parseClaudeSensor(input.claude, nowMs), nowMs)],
    ['claude-api', chosen('claude-api', input.claudeApi === undefined ? null : parseClaudeApiBalance(input.claudeApi, nowMs), nowMs)],
    ['cursor-cloud', chosen('cursor-cloud', input.cursorCloud === undefined ? null : parseOfficialPercent('cursor-cloud', input.cursorCloud, nowMs), nowMs)],
    ['grok-ultra', chosen('grok-ultra', input.grok === undefined ? null : parseGrokSensor(input.grok, nowMs), nowMs)],
    ['grok-bot', chosen('grok-bot', input.grokBot === undefined ? null : parseOfficialPercent('grok-bot', input.grokBot, nowMs), nowMs)],
    ['local', chosen('local', input.local === undefined ? null : parseLocalThroughput(input.local, nowMs), nowMs)],
    ['terra', chosen('terra', null, nowMs)],
  ]);
  return [...produced.values()];
}
