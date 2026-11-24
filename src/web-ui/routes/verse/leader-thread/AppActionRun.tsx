/**
 * App actions inside the Leader conversation: one group per run of actions
 * (see thread-app-actions.ts), each action a sentence with its outcome, the
 * time it was logged and the log's own detail. Read-only: nothing here acts
 * on an app; "Mac host" opens the pane that can.
 */
import { useCallback, useState } from 'react';
import type { AppActionsReport } from '../../../../core/apps-actions.js';
import { ApiError } from '../../../data/client.js';
import { useQuery, useRefetch } from '../../../data/hooks.js';
import { formatRelative } from '../autonomy/format.js';
import { appActionsQuery } from '../fleet-host/AppActionsCard.js';
import { actionLine } from '../fleet-host/app-actions-model.js';
import { clockTime } from '../leader/thread-model.js';
import { usePollWhileVisible } from '../shell/section-visibility.js';
import leaderStyles from '../leader/leader.module.css';
import own from './app-action-run.module.css';
import { foldedEntries, loadAppActionsShown, runCountWords, runLookCount, saveAppActionsShown, type AppRun } from './thread-app-actions.js';

const POLL_MS = 30_000;

function shownStorage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

export interface ThreadAppActions {
  /** Whether app actions are drawn in the conversation (Mason's choice, kept across reloads). */
  show: boolean;
  setShow: (show: boolean) => void;
  /** The log, or null while it is hidden, unread or failed. */
  report: AppActionsReport | null;
  /** The log exists on this server and could not be read: say so, never show an empty log. */
  unknown: boolean;
}

/**
 * The app action log for the Leader pane. It shares the Mac host card's cache
 * entry and is read every 30 seconds while the pane is on screen and the rows
 * are shown. A server without the route (404) or a caller it does not serve
 * (403, a phone) simply has no rows; any other failure is reported as unknown.
 */
export function useThreadAppActions(visible: boolean): ThreadAppActions {
  const [show, setShown] = useState(() => loadAppActionsShown(shownStorage()));
  const active = visible && show;
  const read = useQuery(appActionsQuery, { enabled: active, freshMs: POLL_MS });
  const refetch = useRefetch(appActionsQuery);
  usePollWhileVisible(refetch, POLL_MS, { enabled: active, refreshOnShow: false });
  const setShow = useCallback((next: boolean) => {
    saveAppActionsShown(shownStorage(), next);
    setShown(next);
  }, []);
  const report = show ? read.data ?? null : null;
  const absent = read.error instanceof ApiError && (read.error.status === 404 || read.error.status === 403);
  const unknown = show && (report ? report.total === null : read.status === 'error' && !absent);
  return { show, setShow, report, unknown };
}

export function AppActionRunView({ run, now, match, current, onOpenHost }: {
  run: AppRun; now: number; match?: boolean; current?: boolean; onOpenHost: () => void;
}) {
  const [open, setOpen] = useState(false);
  // A Find match may sit in a folded action, so a matched run lists everything.
  const shown = foldedEntries(run, open || !!match);
  const folded = run.entries.length - foldedEntries(run, false).length;
  const look = runLookCount(run);
  return <section className={leaderStyles.group} aria-label="App actions" data-app-run={run.key}
    data-find-match={match || undefined} data-find-current={current || undefined}>
    <header className={leaderStyles.groupHead}>
      <span className={leaderStyles.who}>Mac apps</span>
      <span className={leaderStyles.channel}>{runCountWords(run.entries.length)}</span>
      {look > 0 ? <span className={own.look}>{look} {look === 1 ? 'needs' : 'need'} a look</span> : null}
      <time className={leaderStyles.time} dateTime={run.lastAt} title={new Date(run.lastAt).toLocaleString()}>{formatRelative(run.lastAt, now)}</time>
      <button type="button" className={own.door} onClick={onOpenHost} title="Open the Mac host pane, where apps are listed and opened">Mac host</button>
    </header>
    <div className={leaderStyles.groupBody}>
      {folded > 0 && !match ? <button type="button" className={own.more} aria-expanded={open} onClick={() => setOpen(value => !value)}>
        {open ? 'Show the newest only' : `Show ${folded} earlier`}
      </button> : null}
      <ol className={own.list} aria-label="App actions, oldest first">
        {shown.map(entry => {
          const line = actionLine(entry, now);
          return <li key={entry.key} className={own.row} data-tone={line.tone}>
            <span className={own.dot} aria-hidden="true" />
            <span className={own.what}>{line.title}</span>
            <time className={own.when} dateTime={entry.at} title={new Date(entry.at).toLocaleString()}>{clockTime(entry.at)}</time>
            {entry.detail ? <span className={own.detail}>{entry.detail}</span> : null}
          </li>;
        })}
      </ol>
    </div>
  </section>;
}
