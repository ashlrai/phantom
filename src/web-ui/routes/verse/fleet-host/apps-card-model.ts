export type AppAction = 'launch' | 'focus' | 'restart';
export interface FleetApp { app: string; running: boolean | null; checkedAt: string }
export interface FleetAppsResponse { v: 1; generatedAt: string; available: boolean; apps: FleetApp[] }
export interface AppActionResult { app: string; action: AppAction; code: string; at: string }
export interface AppRow extends FleetApp { state: 'running' | 'not running' | 'unknown' }

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
export function narrowFleetApps(raw: unknown): FleetAppsResponse | null {
  if (!object(raw) || raw.v !== 1 || typeof raw.generatedAt !== 'string' || typeof raw.available !== 'boolean' || !Array.isArray(raw.apps)) return null;
  if (!raw.apps.every((row: unknown) => object(row) && typeof row.app === 'string' && row.app.trim().length > 0
    && (row.running === null || typeof row.running === 'boolean') && typeof row.checkedAt === 'string')) return null;
  if (new Set(raw.apps.map((row) => row.app)).size !== raw.apps.length) return null;
  return raw as unknown as FleetAppsResponse;
}
export function appRows(resp: FleetAppsResponse): AppRow[] {
  return resp.apps.map((row): AppRow => ({ ...row, state: row.running === null ? 'unknown' : row.running ? 'running' : 'not running' }))
    .sort((a, b) => Number(b.running === true) - Number(a.running === true) || a.app.localeCompare(b.app));
}
export function appActionsFor(row: FleetApp): AppAction[] {
  return row.running === true ? ['focus', 'restart'] : ['launch'];
}
export function appActionConfirmLabel(app: string, action: AppAction, armed: boolean): string {
  const label = action[0].toUpperCase() + action.slice(1);
  return armed ? `${label} ${app}? click again` : label;
}
export function appActionOutcomeText(result: AppActionResult): string {
  return `${result.app}: ${result.action} — ${result.code}`;
}
