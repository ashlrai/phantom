/**
 * routes/verse/leader-thread/thread-app-actions.ts: the Mac's app actions as
 * rows of the Leader conversation. The app action log (`phm apps log --json`,
 * GET /api/verse/apps/actions) already says what Phantom opened, focused, quit
 * or restarted and how each attempt ended; this module places those entries
 * between the conversation's lines by time. Actions with nothing said between
 * them form one run, so a burst reads as one row group, not a wall. Pure:
 * nothing is filled in, an action with an unreadable time is left out, and
 * only actions inside the span of the conversation on screen are placed.
 */
import type { AppActionEntry, AppActionsReport } from '../../../../core/apps-actions.js';
import { actionLine, needsLook } from '../fleet-host/app-actions-model.js';
import type { ConversationItem } from './thread-bus-replies.js';

/** Consecutive app actions with no conversation line between them, oldest first. */
export interface AppRun {
  key: string;
  /** When the run's first action was logged. */
  atMs: number;
  /** When its newest action was logged. */
  lastAt: string;
  entries: AppActionEntry[];
}

export type AppRunItem = { type: 'app'; run: AppRun };
export type WovenItem = ConversationItem | AppRunItem;

/** A run longer than this shows its newest APP_RUN_FOLD - 1 actions until opened. */
export const APP_RUN_FOLD = 4;
export const APP_ACTIONS_SHOWN_KEY = 'phantom.leaderAppActions.v1';

type StorageLike = Pick<Storage, 'getItem' | 'setItem'> | null | undefined;

const itemAt = (item: ConversationItem): number => (item.type === 'line' ? item.line.at : Date.parse(item.row.at));
const sameDay = (a: number, b: number): boolean => new Date(a).toDateString() === new Date(b).toDateString();

/**
 * The report's actions that belong in the conversation shown: dated, and no
 * older than its oldest dated item (loading earlier messages brings earlier
 * actions with them). Oldest first; entries logged in the same millisecond
 * keep the feed's order. A conversation with no dated item takes none.
 */
export function conversationActions(report: AppActionsReport | null | undefined, items: readonly ConversationItem[]): AppActionEntry[] {
  if (!report) return [];
  let since = Number.POSITIVE_INFINITY;
  for (const item of items) {
    const at = itemAt(item);
    if (Number.isFinite(at) && at < since) since = at;
  }
  if (!Number.isFinite(since)) return [];
  return [...report.actions].reverse()
    .filter(entry => { const at = Date.parse(entry.at); return Number.isFinite(at) && at >= since; })
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}

/**
 * Place the actions between the conversation's items by time. The existing
 * order is kept as it is, undated lines stay last, and a run ends at the next
 * conversation item or at midnight, so each run sits under its own day.
 */
export function weaveAppActions(items: readonly ConversationItem[], actions: readonly AppActionEntry[]): WovenItem[] {
  const out: WovenItem[] = [];
  let next = 0;
  let run: AppRun | null = null;
  const take = (entry: AppActionEntry) => {
    const at = Date.parse(entry.at);
    if (!run || !sameDay(run.atMs, at)) {
      run = { key: `app-${entry.key}`, atMs: at, lastAt: entry.at, entries: [] };
      out.push({ type: 'app', run });
    }
    run.entries.push(entry);
    run.lastAt = entry.at;
  };
  for (const item of items) {
    const at = itemAt(item);
    while (next < actions.length && (!Number.isFinite(at) || Date.parse(actions[next]!.at) < at)) take(actions[next++]!);
    out.push(item);
    run = null;
  }
  while (next < actions.length) take(actions[next++]!);
  return out;
}

/** The actions a run lists: all of them when open or short, else the newest few. */
export function foldedEntries(run: AppRun, open: boolean): AppActionEntry[] {
  return open || run.entries.length <= APP_RUN_FOLD ? run.entries : run.entries.slice(-(APP_RUN_FOLD - 1));
}

/** How many of a run's actions did not simply finish. */
export function runLookCount(run: AppRun): number {
  return run.entries.filter(needsLook).length;
}

/** "1 app action" / "6 app actions". */
export function runCountWords(count: number): string {
  return `${count} app ${count === 1 ? 'action' : 'actions'}`;
}

/** What Find searches in a run: each action's sentence, its app and its logged detail. */
export function runFindFields(run: AppRun): string[] {
  return run.entries.flatMap(entry => [actionLine(entry, 0).title, entry.app, ...(entry.detail ? [entry.detail] : [])]);
}

/** Shown unless Mason turned them off; unreadable storage means shown. */
export function loadAppActionsShown(storage: StorageLike): boolean {
  try {
    return storage?.getItem(APP_ACTIONS_SHOWN_KEY) !== 'hidden';
  } catch {
    return true;
  }
}

export function saveAppActionsShown(storage: StorageLike, shown: boolean): void {
  try {
    storage?.setItem(APP_ACTIONS_SHOWN_KEY, shown ? 'shown' : 'hidden');
  } catch {
    /* best-effort: the choice then lasts for this visit only */
  }
}
