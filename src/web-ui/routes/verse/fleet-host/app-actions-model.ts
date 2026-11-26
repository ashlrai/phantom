/**
 * The pure half of the Fleet Host "App actions" card: the log `phm apps log
 * --json` prints (phm.apps.actions/1), one plain sentence per action. Nothing
 * is filled in: an outcome this build does not know is shown as written, and
 * an action with no result on record says so.
 */
import { relativeTime } from '../../../lib/relative-time.js';
import type { AppActionEntry, AppActionsReport } from '../../../../core/apps-actions.js';

export const APP_ACTIONS_API = '/api/verse/apps/actions';

export type ActionTone = 'ok' | 'warn' | 'bad' | 'unknown';
export interface ActionLine { title: string; tone: ActionTone; when: string }

const isEntry = (value: unknown): value is AppActionEntry => {
  const entry = value as Partial<AppActionEntry> | null;
  return !!entry && typeof entry.key === 'string' && typeof entry.at === 'string' && typeof entry.action === 'string'
    && typeof entry.app === 'string' && typeof entry.outcome === 'string' && (entry.detail === null || typeof entry.detail === 'string');
};

/** The report when the body is one, else null (an older server, a proxy page). */
export function narrowAppActions(data: unknown): AppActionsReport | null {
  const report = data as Partial<AppActionsReport> | null;
  if (!report || report.schema !== 'phm.apps.actions/1' || !Array.isArray(report.actions) || !report.actions.every(isEntry)) return null;
  if ((report.total !== null && typeof report.total !== 'number') || !report.counts || typeof report.counts !== 'object') return null;
  return report as AppActionsReport;
}

const DID: Record<string, (app: string) => string> = {
  open: app => `Opened ${app}`, focus: app => `Brought ${app} to front`, quit: app => `Quit ${app}`, restart: app => `Restarted ${app}`,
};
const TO: Record<string, (app: string) => string> = {
  open: app => `open ${app}`, focus: app => `bring ${app} to front`, quit: app => `quit ${app}`, restart: app => `restart ${app}`,
};

/** Age of the action's recorded result. */
export function actionAgo(at: string, nowMs: number): string {
  return relativeTime(at, nowMs)?.text ?? 'time unknown';
}

/** Outcomes that are not a plain success: the ones worth a look. */
export function needsLook(entry: AppActionEntry): boolean {
  return entry.outcome !== 'done' && entry.outcome !== 'dry-run';
}

export function actionLine(entry: AppActionEntry, nowMs: number): ActionLine {
  const to = (TO[entry.action] ?? ((app: string) => `${entry.action} ${app}`))(entry.app);
  const when = actionAgo(entry.at, nowMs);
  switch (entry.outcome) {
    case 'done': return { title: (DID[entry.action] ?? (() => `Did ${to}`))(entry.app), tone: 'ok', when };
    case 'refused': return { title: `Refused to ${to}`, tone: 'warn', when };
    case 'failed': return { title: `Could not ${to}`, tone: 'bad', when };
    case 'needs-you': return { title: `Asked you before it would ${to}`, tone: 'warn', when };
    case 'needs_permission': return { title: `Needs a permission to ${to}`, tone: 'warn', when };
    case 'unknown': return { title: `Tried to ${to}; the result is unknown`, tone: 'unknown', when };
    case 'no-result': return { title: `Started to ${to}; no result is on record`, tone: 'unknown', when };
    case 'dry-run': return { title: `Dry run: ${to}`, tone: 'ok', when };
    default: return { title: `${to}: ${String(entry.outcome)}`, tone: 'unknown', when };
  }
}

const COUNTED: Array<[keyof AppActionsReport['counts'], string]> = [
  ['refused', 'refused'], ['failed', 'failed'], ['needs-you', 'waiting on you'], ['needs_permission', 'needing a permission'],
  ['unknown', 'with result unknown'], ['no-result', 'with no result on record'],
];

/** "12 actions on record · 2 refused · 1 waiting on you"; unknown when the feed could not be read. */
export function actionsHeadline(report: AppActionsReport): string {
  if (report.total === null) return 'App actions are unknown: the feed could not be read.';
  if (report.total === 0) return report.source === 'missing' ? 'Nothing has been logged to the feed yet.' : 'No app action is on record in the last 7 days.';
  return [`${report.total} ${report.total === 1 ? 'action' : 'actions'} on record`,
    ...COUNTED.flatMap(([name, words]) => (report.counts[name] ? [`${report.counts[name]} ${words}`] : []))].join(' · ');
}
