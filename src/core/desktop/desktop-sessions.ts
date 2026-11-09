/**
 * Roster hook for the unified agent roster.
 *
 * `src/core/fleet/agent-roster.ts` is owned by another change. Import this
 * from there:
 *
 *   import { desktopSessions } from '../desktop/desktop-sessions.js';
 *
 * The result is one row per visible window: app, window title, session title,
 * last activity. lastActivity stays null when the AX tree has no activity
 * timestamp. An optional `sessionExports` reader supplies an official CLI,
 * API or export when one exists. Devin Desktop's local chats have no export,
 * so those rows come from the window list.
 */
import { scrubSecrets } from '../util/scrub.js';
import { runDesktopOperator, type OperatorDeps } from './operator.js';
import { forbiddenStoreText, operatorDenyReason, rosterAppId, type OperatorRosterApp } from './operator-policy.js';

export interface DesktopSession {
  app: string;
  bundleId: string | null;
  windowTitle: string;
  sessionTitle: string | null;
  lastActivity: string | null;
  rosterApp: OperatorRosterApp['id'] | null;
}

export interface DesktopSessionExport {
  app: string;
  bundleId?: string | null;
  windowTitle: string;
  sessionTitle?: string | null;
  lastActivity?: string | null;
}

export interface DesktopSessionsDeps extends OperatorDeps {
  /** Official session lists. Rows that name a closed app or a forbidden store are dropped. */
  sessionExports?: () => Promise<readonly DesktopSessionExport[]>;
}

export type DesktopSessionsResult =
  | { ok: true; sessions: DesktopSession[] }
  | { ok: false; code: string; error: string; sessions: DesktopSession[] };

function clean(value: string | null | undefined): string | null {
  if (!value) return null;
  const text = scrubSecrets(value).slice(0, 300);
  return text.length > 0 ? text : null;
}

function rowFromExport(entry: DesktopSessionExport): DesktopSession | null {
  if (forbiddenStoreText(entry.app) || forbiddenStoreText(entry.windowTitle) || forbiddenStoreText(entry.sessionTitle)) return null;
  const bundleId = entry.bundleId ?? null;
  if (operatorDenyReason({ name: entry.app, bundleId, windowTitle: entry.windowTitle, verb: 'windows' })) return null;
  const windowTitle = clean(entry.windowTitle) ?? '';
  return {
    app: clean(entry.app) ?? entry.app.slice(0, 120),
    bundleId,
    windowTitle,
    sessionTitle: clean(entry.sessionTitle) ?? (windowTitle.length > 0 ? windowTitle : null),
    lastActivity: clean(entry.lastActivity),
    rosterApp: rosterAppId(entry.app, bundleId),
  };
}

function keyOf(session: Pick<DesktopSession, 'app' | 'windowTitle'>): string {
  return `${session.app.trim().toLowerCase()}\n${session.windowTitle.trim().toLowerCase()}`;
}

export async function desktopSessions(deps: DesktopSessionsDeps = {}): Promise<DesktopSessionsResult> {
  const exported: DesktopSession[] = [];
  if (deps.sessionExports) {
    try {
      for (const entry of await deps.sessionExports()) {
        const row = rowFromExport(entry);
        if (row) exported.push(row);
      }
    } catch {
      // A broken export leaves the AX window list as the session source.
    }
  }
  const live = await runDesktopOperator({ verb: 'windows' }, deps);
  if (!live.ok) {
    return exported.length > 0
      ? { ok: true, sessions: exported }
      : { ok: false, code: live.code, error: live.error, sessions: [] };
  }
  const windows = Array.isArray(live.data['windows']) ? live.data['windows'] as Array<Record<string, unknown>> : [];
  const seen = new Set(exported.map((session) => keyOf(session)));
  const sessions = [...exported];
  for (const window of windows) {
    if (typeof window['app'] !== 'string' || typeof window['title'] !== 'string') continue;
    const bundleId = typeof window['bundleId'] === 'string' ? window['bundleId'] : null;
    const windowTitle = clean(window['title']) ?? '';
    const session: DesktopSession = {
      app: clean(window['app']) ?? window['app'].slice(0, 120),
      bundleId,
      windowTitle,
      sessionTitle: windowTitle.length > 0 ? windowTitle : null,
      lastActivity: null,
      rosterApp: rosterAppId(window['app'], bundleId),
    };
    const key = keyOf(session);
    if (seen.has(key)) continue;
    seen.add(key);
    sessions.push(session);
  }
  return { ok: true, sessions };
}
