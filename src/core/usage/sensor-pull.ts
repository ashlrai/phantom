/**
 * Live refresh through official surfaces only.
 * Devin uses the official organization consumption API.
 * Codex uses the App Server rate-limit read on an explicit pool home.
 * Claude uses the sanitized CLI rate-limit status, or an official usage payload.
 * Grok accepts an official status object from the caller.
 * Operator credential directories are refused before any reader runs.
 */
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { readLatestClaudeRateLimitEvent } from '../fabric/claude-rate-limit-event.js';
import { readCodexUsage, type CodexUsageReading } from '../fabric/readers/codex-usage.js';
import { readDevinUsage, type DevinUsageResult } from '../fabric/readers/devin-usage.js';
import { parseClaudeSensor, parseCodexSensor, parseGrokSensor } from './sensor-refresh.js';
import {
  USAGE_SENSOR_LANES,
  USAGE_SENSOR_STALE_MS,
  unmeasuredSensor,
  readingIsFresh,
  usageSensorReadingSchema,
  type UsageSensorLane,
  type UsageSensorReading,
} from './sensor-reading.js';

export function codexPoolHomeAllowed(home: string, operatorHome: string): boolean {
  if (!isAbsolute(home) || home === operatorHome) return false;
  for (const name of ['.codex', '.codex-2']) {
    const dir = join(operatorHome, name);
    if (home === dir || home.startsWith(`${dir}/`)) return false;
  }
  return true;
}

/** Refresh only an existing stale personal reading; failures preserve stale evidence. */
export async function refreshStalePersonalUsage(
  readings: UsageSensorReading[], options: UsageSensorPullOptions = {},
): Promise<UsageSensorReading[]> {
  const nowMs = options.nowMs ?? Date.now();
  const latest = readings.filter(row => row.lane === 'codex-personal')
    .sort((a, b) => Date.parse(b.observedAt) - Date.parse(a.observedAt))[0];
  if (!latest || readingIsFresh({ ...latest, nowMs })) return readings;
  const refreshed = await codexLane('codex-personal', options.codexPersonalHome,
    options.operatorHome ?? homedir(), nowMs, options.readCodex ?? (home => readCodexUsage({ home })));
  return refreshed ? [...readings, refreshed] : readings;
}

function fromDevin(result: DevinUsageResult, nowMs: number): UsageSensorReading | null {
  if ('status' in result) return null;
  const observed = Date.parse(result.fetchedAt);
  if (!Number.isFinite(observed) || observed > nowMs) return null;
  const parsed = usageSensorReadingSchema.safeParse({
    lane: 'devin',
    observedAt: new Date(observed).toISOString(),
    source: 'devin-api-v3-org-cycle',
    staleAfter: new Date(observed + USAGE_SENSOR_STALE_MS).toISOString(),
    used: result.acuUsed,
    limit: result.acuLimit,
    unit: 'acu',
    resetAt: result.resetAt,
  });
  return parsed.success ? parsed.data : null;
}

function codexStatusPayload(status: Pick<CodexUsageReading, 'pctUsed' | 'resetAt'>): unknown {
  if (status.pctUsed === null || status.resetAt === null) return null;
  const resetsAt = Math.floor(Date.parse(status.resetAt) / 1000);
  if (!Number.isSafeInteger(resetsAt)) return null;
  return { rateLimits: { limitId: 'codex', primary: { usedPercent: status.pctUsed, resetsAt } } };
}

async function codexLane(
  lane: 'codex-cmp' | 'codex-personal',
  home: string | undefined,
  operatorHome: string,
  nowMs: number,
  readCodex: (home: string) => Promise<Pick<CodexUsageReading, 'pctUsed' | 'resetAt'>>,
): Promise<UsageSensorReading | null> {
  if (!home || !codexPoolHomeAllowed(home, operatorHome)) return null;
  try { return parseCodexSensor(lane, codexStatusPayload(await readCodex(home)), nowMs); }
  catch { return null; }
}

export interface UsageSensorPullOptions {
  nowMs?: number;
  operatorHome?: string;
  codexCmpHome?: string;
  codexPersonalHome?: string;
  readDevin?: () => Promise<DevinUsageResult>;
  readCodex?: (home: string) => Promise<Pick<CodexUsageReading, 'pctUsed' | 'resetAt'>>;
  readClaude?: () => unknown;
  readGrok?: () => unknown;
}

function row(lane: UsageSensorLane, reading: UsageSensorReading | null, nowMs: number): UsageSensorReading {
  return reading ?? unmeasuredSensor(lane, nowMs);
}

/** Pull one reading per lane. A refused or failed surface stays unmeasured. */
export async function pullOfficialUsageSensors(options: UsageSensorPullOptions = {}): Promise<UsageSensorReading[]> {
  const nowMs = options.nowMs ?? Date.now();
  const operatorHome = options.operatorHome ?? homedir();
  const readDevin = options.readDevin ?? readDevinUsage;
  const readCodex = options.readCodex ?? ((home: string) => readCodexUsage({ home }));
  const readClaude = options.readClaude ?? (() => readLatestClaudeRateLimitEvent({ nowMs }));
  const readGrok = options.readGrok ?? (() => null);

  let devin: UsageSensorReading | null = null;
  try { devin = fromDevin(await readDevin(), nowMs); } catch { devin = null; }
  const [codexCmp, codexPersonal] = await Promise.all([
    codexLane('codex-cmp', options.codexCmpHome, operatorHome, nowMs, readCodex),
    codexLane('codex-personal', options.codexPersonalHome, operatorHome, nowMs, readCodex),
  ]);
  let claude: UsageSensorReading | null = null;
  let grok: UsageSensorReading | null = null;
  try { claude = parseClaudeSensor(readClaude(), nowMs); } catch { claude = null; }
  try { grok = parseGrokSensor(readGrok(), nowMs); } catch { grok = null; }

  const readings = [
    row('devin', devin, nowMs),
    row('codex-cmp', codexCmp, nowMs),
    row('codex-personal', codexPersonal, nowMs),
    row('claude-max', claude, nowMs),
    row('grok-ultra', grok, nowMs),
    row('terra', null, nowMs),
  ];
  return USAGE_SENSOR_LANES.map(lane => readings.find(item => item.lane === lane) ?? unmeasuredSensor(lane, nowMs));
}
