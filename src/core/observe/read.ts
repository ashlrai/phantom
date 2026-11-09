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
import { grokManualSensorReadings } from '../usage/grok-resource.js';
import { presentUsageSensors } from '../usage/sensor-reading.js';
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

export async function loadSensorReport(nowMs: number): Promise<unknown> {
  // Same projection as `phm usage sensors --json` with no snapshot file:
  // every lane is unmeasured until a reading is supplied, and headroom is null.
  // Grok carries the owner's manual reading and reset time.
  return presentUsageSensors(grokManualSensorReadings(nowMs), nowMs);
}

export async function readObserveSession(sessionId: string, options: ReadObserveOptions = {}): Promise<SessionDetail> {
  const nowMs = options.nowMs ?? Date.now();
  const roster = options.loadRoster ? await options.loadRoster().catch(() => undefined) : await loadMergedRoster();
  return sessionFromRoster(roster, sessionId, nowMs);
}
