/**
 * Gather local observe inputs. Roster, usage sensors, and desktop sessions
 * are the landed readers. A source that cannot be read stays unknown.
 */
import { lstat, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { desktopSessions, type DesktopSessionsResult } from '../desktop/desktop-sessions.js';
import { collectAgentRoster, type AgentRoster, type RosterSession, type RosterSourceId } from '../fleet/agent-roster.js';
import { inspectBusWorkClaims, type BusWorkClaimsInspection } from '../fleet/bus-work-claims.js';
import { presentUsageSensors } from '../usage/sensor-reading.js';
import { assembleObserve, sessionFromRoster, type ObserveInput } from './assemble.js';
import { parsePullExport } from './pulls.js';
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
}

export async function readObserveSnapshot(options: ReadObserveOptions = {}): Promise<ObserveSnapshot> {
  const nowMs = options.nowMs ?? Date.now();
  const [humanSteps, bottlenecks, pullFile, roster, sensors] = await Promise.all([
    readJsonFile(options.humanStepsFile ?? humanStepsPath()),
    readJsonFile(options.bottlenecksFile ?? bottlenecksPath()),
    options.pullsFile ? readJsonFile(options.pullsFile) : Promise.resolve(null),
    options.loadRoster ? options.loadRoster().catch(() => undefined) : loadRoster(),
    options.loadSensors ? options.loadSensors().catch(() => undefined) : loadSensors(nowMs),
  ]);
  const parsedPulls = pullFile === null ? null : parsePullExport(pullFile);
  let claims: BusWorkClaimsInspection | null = null;
  try {
    claims = (options.readClaims ?? (() => inspectBusWorkClaims()))();
  } catch {
    claims = { source: 'unavailable', claims: [] };
  }
  return assembleObserve({
    nowMs,
    windowMs: options.windowMs,
    windowDays: options.windowDays,
    roster,
    sensors,
    claims,
    humanSteps: humanSteps ?? undefined,
    bottlenecks: bottlenecks ?? undefined,
    pulls: options.pulls ?? parsedPulls?.pulls,
    pullsComplete: options.pullsComplete ?? parsedPulls?.complete,
    pullsReason: options.pulls || parsedPulls ? null : 'No pull export was provided',
    updatePhase: options.updatePhase,
  });
}

async function loadRoster(): Promise<AgentRoster | undefined> {
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

async function loadSensors(nowMs: number): Promise<unknown> {
  // Same projection as `phm usage sensors --json` with no snapshot file:
  // every lane is unmeasured until a reading is supplied, and headroom is null.
  return presentUsageSensors([], nowMs);
}

export async function readObserveSession(sessionId: string, options: ReadObserveOptions = {}): Promise<SessionDetail> {
  const nowMs = options.nowMs ?? Date.now();
  const roster = options.loadRoster ? await options.loadRoster().catch(() => undefined) : await loadRoster();
  return sessionFromRoster(roster, sessionId, nowMs);
}
