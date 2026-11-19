/**
 * src/core/apps-actions.ts: what Phantom did to the apps on this Mac, in order.
 *
 * runAppsControl writes two feed lines for every app operation: the intent,
 * then the result (refusals included). This reads those lines back as one
 * entry per open, focus, quit or restart. It adds no source and guesses
 * nothing: an intent with no result line stays `no-result`, an unreadable
 * feed is `unavailable` with no count, and list/status lookups are counted
 * but not listed. The feed keeps a line for seven days.
 */
import type { AppAction, AppsOutcome } from './apps-control.js';
import { scanBusInbox, type BusInboxScan } from './fleet/bus-inbox.js';

export const APP_ACTIONS_DEFAULT_LIMIT = 50;
export const APP_ACTIONS_MAX_LIMIT = 200;

/** The operations that act on an app. `status` and `list` only read. */
const ACTING: readonly AppAction[] = ['open', 'focus', 'quit', 'restart'];
const OUTCOMES: readonly AppsOutcome[] = ['done', 'refused', 'failed', 'needs-you', 'needs_permission', 'unknown', 'dry-run'];

export type AppActionOutcome = AppsOutcome | 'no-result';

export interface AppActionEntry {
  /** The feed cursor of the line this entry was last read from; unique in one report. */
  key: string;
  /** When the result was logged, or the intent when no result followed. */
  at: string;
  action: AppAction;
  app: string;
  /** `no-result`: the intent is on record and no result line followed it. */
  outcome: AppActionOutcome;
  detail: string | null;
}

export interface AppActionsReport {
  schema: 'phm.apps.actions/1';
  /** Bumps only on a breaking change; new fields are additive. */
  version: 1;
  generatedAt: string;
  /** `missing`: no feed exists yet, so nothing was ever logged. `unavailable`: it could not be read. */
  source: BusInboxScan['source'];
  /** Newest first, at most the asked-for limit. */
  actions: AppActionEntry[];
  /** Every action on record, listed or not; null when the feed could not be read. */
  total: number | null;
  /** Actions on record by outcome; empty when the feed could not be read. */
  counts: Partial<Record<AppActionOutcome, number>>;
  /** list and status lookups on record, which are not listed; null when the feed could not be read. */
  lookups: number | null;
  /** Feed rows that could not be parsed. */
  skipped: number;
  truncated: boolean;
}

export interface AppActionsDeps { scanActions?: () => BusInboxScan; now?: () => number }

const clampLimit = (limit: number | undefined): number =>
  Number.isInteger(limit) && limit! > 0 ? Math.min(limit!, APP_ACTIONS_MAX_LIMIT) : APP_ACTIONS_DEFAULT_LIMIT;

/** Pure: pairs each result with the intent written before it for the same action and app. */
export function buildAppActions(scan: BusInboxScan, options: { now?: number; limit?: number } = {}): AppActionsReport {
  const base = { schema: 'phm.apps.actions/1' as const, version: 1 as const, generatedAt: new Date(options.now ?? Date.now()).toISOString(),
    source: scan.source, skipped: scan.skipped };
  if (scan.source === 'unavailable') return { ...base, actions: [], total: null, counts: {}, lookups: null, truncated: false };
  const all: AppActionEntry[] = [];
  const open = new Map<string, AppActionEntry[]>();
  let lookups = 0;
  for (const row of [...scan.rows].sort((a, b) => a.cursor - b.cursor)) {
    const body = row.envelope.body;
    if (!body || typeof body !== 'object' || Array.isArray(body) || body.kind !== 'apps-control') continue;
    const { phase, action, app, outcome, detail } = body;
    if (typeof action !== 'string' || typeof app !== 'string') continue;
    if (action === 'list' || action === 'status') { if (phase === 'result') lookups += 1; continue; }
    const acting = ACTING.find(name => name === action);
    if (!acting) continue;
    const pair = `${acting}\n${app}`;
    const line = { key: String(row.cursor), at: new Date(row.receivedAt).toISOString() };
    if (phase === 'start') {
      const entry: AppActionEntry = { ...line, action: acting, app, outcome: 'no-result', detail: null };
      all.push(entry);
      open.set(pair, [...(open.get(pair) ?? []), entry]);
      continue;
    }
    const result = OUTCOMES.find(name => name === outcome);
    if (phase !== 'result' || !result) continue;
    // A result is written right after its own intent, so it closes the newest open one; an older
    // intent left open stays `no-result`. A result whose intent has aged out is still an action.
    let entry = open.get(pair)?.pop();
    if (!entry) { entry = { ...line, action: acting, app, outcome: result, detail: null }; all.push(entry); }
    Object.assign(entry, line, { outcome: result, detail: typeof detail === 'string' && detail ? detail : null });
  }
  const counts: AppActionsReport['counts'] = {};
  for (const entry of all) counts[entry.outcome] = (counts[entry.outcome] ?? 0) + 1;
  const limit = clampLimit(options.limit);
  const newest = all.sort((a, b) => b.at.localeCompare(a.at) || Number(b.key) - Number(a.key));
  return { ...base, actions: newest.slice(0, limit), total: all.length, counts, lookups, truncated: all.length > limit };
}

export function readAppActions(deps: AppActionsDeps = {}, limit?: number): AppActionsReport {
  return buildAppActions((deps.scanActions ?? scanBusInbox)(), { now: deps.now?.(), limit });
}

const WORDS: Record<AppActionOutcome, string> = {
  done: 'done', refused: 'refused', failed: 'failed', 'needs-you': 'sent to needs-you', needs_permission: 'needs a permission',
  unknown: 'result unknown', 'dry-run': 'dry run', 'no-result': 'no result on record',
};

/** The `phm apps log` text: a count line, then one line per action, newest first, times in UTC. */
export function formatAppActions(report: AppActionsReport): string {
  if (report.total === null) return 'App actions are unknown: the feed could not be read.';
  if (report.total === 0) return report.source === 'missing' ? 'No app action is on record: nothing has been logged to the feed yet.'
    : `No app action is on record in the last 7 days.${report.lookups ? ` ${report.lookups} lookups (list, status) are not listed.` : ''}`;
  const parts = Object.entries(report.counts).filter(([name]) => name !== 'done').map(([name, count]) => `${count} ${WORDS[name as AppActionOutcome]}`);
  return [
    `${report.total} app ${report.total === 1 ? 'action' : 'actions'} on record${parts.length ? ` (${parts.join(', ')})` : ''}.${report.truncated ? ` Showing the newest ${report.actions.length}.` : ''}${report.lookups ? ` ${report.lookups} lookups (list, status) are not listed.` : ''}`,
    ...report.actions.map(entry => `${entry.at.slice(0, 16).replace('T', ' ')}Z  ${entry.action} ${entry.app}: ${WORDS[entry.outcome]}${entry.detail ? `. ${entry.detail}` : ''}`),
  ].join('\n');
}
