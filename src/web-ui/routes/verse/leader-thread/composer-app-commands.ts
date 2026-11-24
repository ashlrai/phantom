/**
 * routes/verse/leader-thread/composer-app-commands.ts: the Leader reply box's
 * app commands. `/apps` says, in one line, which of the Mac's known apps are
 * open and what Phantom last did to them; `/app <name>` opens one, or brings
 * it to the front when it is already running.
 *
 * Both use what the Mac host pane uses: `GET /api/verse/apps/mac` (`phm apps
 * --json`), `GET /api/verse/apps/actions` (`phm apps log --json`) and `POST
 * /api/verse/apps/control` (`phm apps open|focus`), so the allowlist, the
 * pause switches and the action log apply exactly as they do there. There is
 * no quit or restart from here, as there is none on the card. Nothing is
 * invented: a read that does not answer is "unknown" with the reason, and a
 * name that fits no app, or more than one, runs nothing.
 */
import type { AppActionsReport } from '../../../../core/apps-actions.js';
import type { AppsActionReport } from '../../../../core/apps-control.js';
import type { MacAppRow, MacAppsReport } from '../../../../core/apps-known.js';
import { getMutationToken, touchMutationHold } from '../../../data/auth-store.js';
import { ApiError, apiGet, apiPost, readFailureReason } from '../../../data/client.js';
import { APP_ACTIONS_API, actionLine, narrowAppActions, needsLook } from '../fleet-host/app-actions-model.js';

export const MAC_APPS_API = '/api/verse/apps/mac';
export const APP_CONTROL_API = '/api/verse/apps/control';
/** Log entries `/apps` asks for: enough to find the newest one that needs a look. */
export const APPS_LOG_LIMIT = 50;

export type AppCommandAction = 'open' | 'focus';

export interface AppCommandDeps {
  /** The known Mac apps; null when the answer is not that report. */
  apps: () => Promise<MacAppsReport | null>;
  /** The app action log, newest first; null when the answer is not that report. */
  actions: () => Promise<AppActionsReport | null>;
  act: (app: string, action: AppCommandAction) => Promise<AppsActionReport>;
}

const isRow = (value: unknown): value is MacAppRow => {
  const row = value as Partial<MacAppRow> | null;
  return !!row && typeof row.id === 'string' && typeof row.name === 'string'
    && (row.action === null || row.action === 'open' || row.action === 'focus');
};

/** The report when the body is one, else null (an older server, a proxy page). */
export function narrowMacApps(data: unknown): MacAppsReport | null {
  const report = data as Partial<MacAppsReport> | null;
  return report && report.schema === 'phm.apps/2' && Array.isArray(report.apps) && report.apps.every(isRow) ? report as MacAppsReport : null;
}

export const liveAppDeps: AppCommandDeps = {
  apps: async () => narrowMacApps(await apiGet<unknown>(MAC_APPS_API)),
  actions: async () => narrowAppActions(await apiGet<unknown>(`${APP_ACTIONS_API}?limit=${APPS_LOG_LIMIT}`)),
  act: async (app, action) => {
    const token = getMutationToken();
    if (!token) throw new Error('Unlock actions with the mutation token to open an app.');
    const report = await apiPost<AppsActionReport>(APP_CONTROL_API, { app, action }, token);
    touchMutationHold();
    return report;
  },
};

const memoryWords = (mb: number | null): string =>
  mb === null ? '' : `, ${mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${mb} MB`}`;

/** "Claude in front, 1.2 GB", "Cursor running", "Safari not running"; unknown stays unknown. */
export function appWords(row: MacAppRow): string {
  if (row.installed === null) return `${row.name} state unknown`;
  if (!row.installed) return `${row.name} not installed`;
  if (row.running === null) return `${row.name} installed, running unknown`;
  if (!row.running) return `${row.name} not running`;
  return `${row.name} ${row.frontmost ? 'in front' : 'running'}${memoryWords(row.memoryMb)}`;
}

const sentence = (text: string): string => (/[.!?]$/.test(text) ? text : `${text}.`);

/** The apps half of `/apps`: running ones first as the report orders them, the ones not installed named last. */
export function appsStateLine(report: MacAppsReport): string {
  if (report.apps.length === 0) return 'No app is listed for this Mac.';
  const present = report.apps.filter(row => row.installed !== false);
  const absent = report.apps.filter(row => row.installed === false);
  const order = (row: MacAppRow): number => (row.running ? (row.frontmost ? 0 : 1) : row.running === false ? 2 : 3);
  const listed = [...present].sort((a, b) => order(a) - order(b)).map(appWords);
  return [
    listed.length > 0 ? `Apps on this Mac: ${listed.join(' · ')}.` : 'None of the known apps is installed on this Mac.',
    ...(absent.length > 0 && listed.length > 0 ? [`Not installed: ${absent.map(row => row.name).join(', ')}.`] : []),
    ...(report.reason ? [`Some state is unknown: ${sentence(report.reason)}`] : []),
  ].join(' ');
}

/** The log half of `/apps`: the newest action, then how many on record did not simply succeed. */
export function appsLogLine(report: AppActionsReport, nowMs: number): string {
  if (report.total === null) return 'What Phantom did to them is unknown: the action log could not be read.';
  const newest = report.actions[0];
  if (report.total === 0 || !newest) return report.source === 'missing' ? 'Phantom has not acted on an app yet.' : 'Phantom has not acted on an app in the last 7 days.';
  const last = actionLine(newest, nowMs);
  const look = Object.entries(report.counts).reduce((sum, [outcome, count]) => (outcome === 'done' || outcome === 'dry-run' ? sum : sum + (count ?? 0)), 0);
  const parts = [`Last action: ${last.title}${newest.detail && needsLook(newest) ? ` (${newest.detail.replace(/[.\s]+$/, '')})` : ''}, ${last.when}.`];
  if (look > 0) {
    const flagged = needsLook(newest) ? null : report.actions.find(needsLook);
    const named = flagged ? actionLine(flagged, nowMs) : null;
    parts.push(`${look} of ${report.total} on record did not go through${named ? `, newest: ${named.title}, ${named.when}` : ''}.`);
  }
  return parts.join(' ');
}

const readFailure = (subject: string, error: unknown): string =>
  error instanceof ApiError && error.status === 403 ? `${subject} can be read only on the Mac Phantom runs on.`
    : error instanceof ApiError && error.status === 404 ? `${subject} is unknown: this server does not serve it yet.`
      : `${subject} is unknown. ${readFailureReason(error)}`;

/** `/apps`: both reads at once; each half says so on its own when it does not answer. Never throws. */
export async function runAppsCommand(deps: AppCommandDeps, nowMs: number): Promise<string> {
  const [apps, actions] = await Promise.allSettled([deps.apps(), deps.actions()]);
  const state = apps.status === 'rejected' ? readFailure('App state', apps.reason)
    : apps.value ? appsStateLine(apps.value) : 'App state is unknown: this server did not return the app list.';
  const log = actions.status === 'rejected' ? readFailure('What Phantom did to them', actions.reason)
    : actions.value ? appsLogLine(actions.value, nowMs) : 'What Phantom did to them is unknown: this server did not return the action log.';
  const tail = apps.status === 'fulfilled' && apps.value?.apps.some(row => row.action !== null)
    ? ' /app <name> opens one or brings it to the front; /open fleet-host has the whole log.' : '';
  return `${state} ${log}${tail}`;
}

export type NamedApp = { kind: 'one'; row: MacAppRow } | { kind: 'several'; names: string[] } | { kind: 'none' };

/** The app a typed name means: its id or full name first, then the only app whose id or name starts with it. */
export function namedApp(report: MacAppsReport, typed: string): NamedApp {
  const needle = typed.trim().toLowerCase();
  if (!needle) return { kind: 'none' };
  const exact = report.apps.find(row => row.id === needle || row.name.toLowerCase() === needle);
  if (exact) return { kind: 'one', row: exact };
  const starts = report.apps.filter(row => row.id.startsWith(needle) || row.name.toLowerCase().startsWith(needle));
  if (starts.length === 1) return { kind: 'one', row: starts[0]! };
  return starts.length === 0 ? { kind: 'none' } : { kind: 'several', names: starts.map(row => row.name) };
}

const capital = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);

/** Why an action that was asked for did not happen, in the server's words: "Phantom refused: not in apps-allow.json." */
function notDone(row: MacAppRow, outcome: string, detail: string): string {
  if (outcome === 'refused') return `Phantom refused: ${sentence(detail)}`;
  if (outcome === 'unknown') return `What happened to ${row.name} is unknown: ${sentence(detail)}`;
  return capital(sentence(detail));
}

/** The server's action report inside a refusal (HTTP 400 or 422 carries one), else null. */
function refusalReport(error: unknown): Pick<AppsActionReport, 'outcome' | 'detail'> | null {
  const body = error instanceof ApiError ? error.body as Partial<AppsActionReport> | null : null;
  return body && typeof body === 'object' && typeof body.outcome === 'string' && typeof body.detail === 'string'
    ? { outcome: body.outcome, detail: body.detail } : null;
}

/**
 * `/app <name>`: the one action the Mac host card offers for that app. Returns
 * [the line the conversation shows, the outcome word for the inbox note];
 * throws the sentence to show when nothing was done, so no note is posted.
 */
export async function runAppCommand(typed: string, deps: AppCommandDeps): Promise<[string, string]> {
  let report: MacAppsReport | null;
  try { report = await deps.apps(); } catch (error) { throw new Error(`${readFailure('App state', error)} Nothing was opened.`); }
  if (!report) throw new Error('App state is unknown: this server did not return the app list. Nothing was opened.');
  const named = namedApp(report, typed);
  if (named.kind === 'several') throw new Error(`"${typed}" fits ${named.names.join(', ')}. Type more of the name.`);
  if (named.kind === 'none') {
    const known = report.apps.filter(row => row.action !== null).map(row => row.name);
    throw new Error(`No app Phantom knows is named "${typed}".${known.length > 0 ? ` It can open ${known.join(', ')}.` : ' /apps lists them.'}`);
  }
  const { row } = named;
  if (row.installed === false) throw new Error(`${row.name} is not installed on this Mac.`);
  if (row.action === null) throw new Error(`Phantom offers no open or bring-to-front for ${row.name} (${appWords(row)}).`);
  let result: AppsActionReport;
  try { result = await deps.act(row.id, row.action); }
  catch (error) {
    const refusal = refusalReport(error);
    if (refusal) throw new Error(notDone(row, refusal.outcome, refusal.detail));
    if (error instanceof ApiError && error.status === 403) throw new Error('Apps can be opened only on the Mac Phantom runs on.');
    if (error instanceof ApiError && error.status === 404) throw new Error('This server cannot open apps (it runs without dispatch).');
    throw error;
  }
  // The server's own sentence, as the card shows it: "Claude: asked macOS to open Claude."
  if (result.outcome === 'done') return [`${row.name}: ${sentence(result.detail)}`, 'done'];
  if (result.outcome === 'needs-you') return [`${row.name} was not ${row.action === 'open' ? 'opened' : 'brought to the front'} yet: ${sentence(result.detail)}`, 'sent to needs-you'];
  throw new Error(notDone(row, result.outcome, result.detail));
}
