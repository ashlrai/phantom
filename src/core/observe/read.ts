/**
 * Gather local observe inputs. Roster, usage sensors, and desktop sessions
 * are the landed readers. A source that cannot be read stays unknown.
 */
import { lstat, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { desktopSessions, type DesktopSessionsResult } from '../desktop/desktop-sessions.js';
import { collectAgentRoster, type AgentRoster, type RosterSession, type RosterSourceId } from '../fleet/agent-roster.js';
import type { BusWorkClaimsInspection } from '../fleet/bus-work-claims.js';
import { loadResourceLiveFeed } from '../usage/resource-live/feed.js';
import { presentUsageSensors, readingIsFresh, USAGE_SENSOR_STALE_MS, type UsageSensorReading } from '../usage/sensor-reading.js';
import { readResourceLedger } from '../fleet/runs-resource-ledger.js';
import { readClaudeApiGrantViews } from '../resources/claude-api-grant.js';
import { loadConfigReadOnly } from '../config.js';
import { resolveAccountsRoot } from '../verse/seats.js';
import { sessionFromRoster, type ObserveInput } from './assemble.js';
import type { ObserveSnapshot, SessionDetail } from './types.js';

const DESKTOP_SOURCE: Partial<Record<string, RosterSourceId>> = {
  devin: 'devin-desktop',
  cursor: 'cursor',
  grok: 'grok',
};

const MAX_BYTES = 256 * 1024;

export function humanStepsPath(): string {
  return join(homedir(), '.ashlr-runs', 'export', 'human-steps.json');
}

export function bottlenecksPath(): string {
  return join(homedir(), '.ashlr-runs', 'export', 'bottlenecks.json');
}

export async function readJsonFile(path: string): Promise<unknown | null> {
  if (!isAbsolute(path)) return null;
  try {
    const stat = await lstat(path);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size > MAX_BYTES) return null;
    return JSON.parse(await readFile(path, 'utf8')) as unknown;
  } catch {
    return null;
  }
}

/**
 * Visible Devin Desktop, Cursor, and Grok windows become roster rows.
 * An unreadable desktop operator leaves those probes unknown.
 */
export function mergeDesktopRoster(roster: AgentRoster, desktop: DesktopSessionsResult): AgentRoster {
  if (!desktop.ok) return roster;
  const added = new Map<RosterSourceId, RosterSession[]>();
  for (const session of desktop.sessions) {
    const source = session.rosterApp ? DESKTOP_SOURCE[session.rosterApp] : undefined;
    if (!source) continue;
    const title = session.sessionTitle ?? (session.windowTitle.length > 0 ? session.windowTitle : null);
    const sessionId = `${source}:${title ?? session.app}`.slice(0, 128);
    const list = added.get(source) ?? [];
    list.push({
      provider: source,
      sessionId,
      title,
      state: 'visible',
      ownership: null,
      claims: [],
      lastActivity: session.lastActivity,
      blockers: [],
    });
    added.set(source, list);
  }
  if (added.size === 0) return roster;
  const sources = roster.sources.map((source) => {
    const extra = added.get(source.source);
    if (!extra) return source;
    return { ...source, ok: true, availability: 'known' as const, error: null, sessions: [...source.sessions, ...extra] };
  });
  return {
    ...roster,
    sources,
    sessions: [...roster.sessions, ...sources.flatMap((source) => added.get(source.source) ?? [])],
  };
}

export interface ReadObserveOptions {
  nowMs?: number;
  humanStepsFile?: string | null;
  bottlenecksFile?: string | null;
  pullsFile?: string | null;
  pulls?: ObserveInput['pulls'];
  pullsComplete?: boolean;
  windowDays?: number;
  windowMs?: number;
  updatePhase?: ObserveInput['updatePhase'];
  readClaims?: () => BusWorkClaimsInspection;
  loadRoster?: () => Promise<unknown>;
  loadSensors?: () => Promise<unknown>;
  /** Skip the world-model cache. Tests and an explicit refresh use this. */
  force?: boolean;
}

export async function readObserveSnapshot(options: ReadObserveOptions = {}): Promise<ObserveSnapshot> {
  const { readWorldModel } = await import('../world/read.js');
  return (await readWorldModel(options)).views.observe;
}

export async function loadMergedRoster(): Promise<AgentRoster | undefined> {
  try {
    const roster = await collectAgentRoster();
    try {
      return mergeDesktopRoster(roster, await desktopSessions());
    } catch {
      return roster;
    }
  } catch {
    return undefined;
  }
}

async function localResourceReadings(nowMs: number, live: UsageSensorReading[]): Promise<UsageSensorReading[]> {
  const needs = (lane: UsageSensorReading['lane']) => !live.some(row => row.lane === lane &&
    readingIsFresh({ ...row, nowMs }) && (row.resetAt === null || Date.parse(row.resetAt) > nowMs));
  const add = (lane: UsageSensorReading['lane'], source: UsageSensorReading['source'],
    observedAt: string | null, resetAt: string | null, used: number | null): UsageSensorReading[] => {
    if (observedAt === null || used === null || !Number.isFinite(used) || used < 0 || used > 100 ||
        !readingIsFresh({ observedAt, nowMs }) || (resetAt !== null && Date.parse(resetAt) <= nowMs)) return [];
    const at = Date.parse(observedAt);
    return [{ lane, source, used, limit: 100, unit: 'percent', observedAt: new Date(at).toISOString(),
      staleAfter: new Date(at + USAGE_SENSOR_STALE_MS).toISOString(), resetAt: resetAt && new Date(Date.parse(resetAt)).toISOString() }];
  };
  const [ledger, grants] = await Promise.all([
    needs('claude-max') || needs('codex-personal') ? readResourceLedger({ now: () => nowMs }).catch(() => null) : null,
    needs('claude-api') ? Promise.resolve().then(() => readClaudeApiGrantViews(resolveAccountsRoot(loadConfigReadOnly()), nowMs)).catch(() => null) : null,
  ]);
  const fallback: UsageSensorReading[] = [];
  for (const row of ledger?.lanes ?? []) {
    const lane = row.lane === 'claude' ? 'claude-max' : row.lane;
    if ((lane !== 'claude-max' && lane !== 'codex-personal') || !needs(lane)) continue;
    const quota = row.quotaEvidence?.measuredQuota ?? row.quotaEvidence?.statusQuota;
    if (quota?.window !== 'weekly') continue;
    const source = row.observation?.source === 'claude-native-usage' ? 'claude-usage'
      : row.observation?.source === 'codex-personal-sessions' ? 'codex-session-log' : 'dispatcher-budget';
    fallback.push(...add(lane, source, quota.observedAt, quota.resetAt, quota.usedPct));
  }
  if (grants?.state === 'healthy') {
    const latest = grants.rows.filter(row => row.state === 'recorded')
      .sort((a, b) => Date.parse(b.capturedAt ?? '') - Date.parse(a.capturedAt ?? ''))[0];
    if (latest?.totalUsdMicros && latest.remainingUsdMicros !== null) {
      const total = Number(latest.totalUsdMicros), remaining = Number(latest.remainingUsdMicros);
      if (total > 0 && latest.admissionCutoff) fallback.push(...add('claude-api', 'claude-api-grant-store',
        latest.capturedAt, latest.admissionCutoff, (total - remaining) / total * 100));
    }
  }
  return fallback;
}

export async function loadSensorReport(nowMs: number): Promise<unknown> {
  const live = await loadResourceLiveFeed(nowMs);
  const local = await localResourceReadings(nowMs, live.readings);
  const report = presentUsageSensors([...live.readings.filter(row => !local.some(reading => reading.lane === row.lane)), ...local], nowMs);
  const pace = new Map(live.pace.map((row) => [row.lane, row]));
  // Pacing keys ride on the lane rows, where the world model reads them.
  return { ...report, history: live.history, lanes: report.lanes.map((lane) => (lane.status === 'fresh' && pace.has(lane.lane) ? { ...lane, ...pace.get(lane.lane) } : lane)) };
}

export async function readObserveSession(sessionId: string, options: ReadObserveOptions = {}): Promise<SessionDetail> {
  const nowMs = options.nowMs ?? Date.now();
  const roster = options.loadRoster ? await options.loadRoster().catch(() => undefined) : await loadMergedRoster();
  return sessionFromRoster(roster, sessionId, nowMs);
}
