import type { AppActionEntry, AppActionsReport } from '../../../../core/apps-actions.js';
import type { AppsActionReport } from '../../../../core/apps-control.js';
import type { MacAppRow, MacAppsReport } from '../../../../core/apps-known.js';

export const APPS_NOW = Date.parse('2026-11-20T12:00:00Z');

export function appRow(over: Partial<MacAppRow> = {}): MacAppRow {
  return { id: 'claude', name: 'Claude', role: 'Assistant', installed: true, running: true, frontmost: false, pid: 41, memoryMb: 512,
    path: '/Applications/Claude.app', bundleId: 'com.example.claude', quit: 'protected', action: 'focus', lastFocusedAt: null, lastFocus: 'unknown',
    reason: null, kind: 'agent-app', processName: 'Claude', lastAction: null, ...over };
}

/** Claude in front, Cursor closed, Safari running, Codex absent, Phantom itself with no action. */
export function macApps(over: Partial<MacAppsReport> = {}): MacAppsReport {
  return { schema: 'phm.apps/2', version: 2, probe: 'ok', reason: null, apps: [
    appRow({ id: 'phantom', name: 'Phantom', kind: 'phantom', action: null, memoryMb: 300 }),
    appRow({ id: 'cursor', name: 'Cursor', kind: 'ide', running: false, pid: null, memoryMb: null, action: 'open' }),
    appRow({ frontmost: true, memoryMb: 1536, action: null }),
    appRow({ id: 'codex', name: 'Codex', installed: false, running: false, pid: null, memoryMb: null, path: null, action: null }),
    appRow({ id: 'safari', name: 'Safari', kind: 'browser', quit: 'allowed', memoryMb: 800 }),
  ], ...over };
}

export function appAction(over: Partial<AppActionEntry> = {}): AppActionEntry {
  return { key: '7', at: '2026-11-20T11:57:00Z', action: 'open', app: 'Claude', outcome: 'done', detail: 'asked macOS to open Claude.', ...over };
}

export function appActions(over: Partial<AppActionsReport> = {}): AppActionsReport {
  return { schema: 'phm.apps.actions/1', version: 1, generatedAt: '2026-11-20T12:00:00Z', source: 'available',
    actions: [appAction(), appAction({ key: '5', at: '2026-11-20T11:00:00Z', action: 'quit', app: 'Cursor', outcome: 'refused', detail: 'not in apps-allow.json.' })],
    total: 14, counts: { done: 12, refused: 2 }, lookups: 3, skipped: 0, truncated: false, ...over };
}

export function appDone(over: Partial<AppsActionReport> = {}): AppsActionReport {
  return { schema: 'phm.apps.action/1', version: 1, ok: true, action: 'open', app: 'cursor', outcome: 'done', detail: 'asked macOS to open Cursor.', logged: true, ...over };
}
