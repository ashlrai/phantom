/**
 * App actions: every open, focus, quit and restart Phantom ran or refused on
 * this Mac, newest first, as `phm apps log` prints them. Read-only: the card
 * has no button that acts on an app. "Needs a look" keeps only the actions
 * that were refused, failed, are waiting on Mason or have no known result.
 */
import { useMemo, useState } from 'react';
import { apiGet } from '../../../data/client.js';
import { useQuery, useRefetch } from '../../../data/hooks.js';
import { useDocumentVisible, usePollWhileVisible, useSectionVisible } from '../shell/section-visibility.js';
import { APP_ACTIONS_API, actionLine, actionsHeadline, narrowAppActions, needsLook } from './app-actions-model.js';
import own from './app-actions.module.css';
import styles from './fleet-host.module.css';

const POLL_MS = 30_000;

export const appActionsQuery = { key: 'app-actions', fetch: async (signal?: AbortSignal) => {
  const report = narrowAppActions(await apiGet<unknown>(APP_ACTIONS_API, signal));
  if (!report) throw new Error('Invalid app actions response');
  return report;
} };

export function AppActionsCard({ visible }: { visible: boolean }) {
  const sectionVisible = useSectionVisible();
  const documentVisible = useDocumentVisible();
  const active = visible && sectionVisible && documentVisible;
  const read = useQuery(appActionsQuery, { enabled: active, freshMs: POLL_MS });
  const refetch = useRefetch(appActionsQuery);
  usePollWhileVisible(refetch, POLL_MS, { enabled: visible, refreshOnShow: false });
  const [onlyLook, setOnlyLook] = useState(false);
  const report = read.data ?? null;
  const look = useMemo(() => report?.actions.filter(needsLook) ?? [], [report]);
  const shown = onlyLook ? look : report?.actions ?? [];
  // Ages are counted from the server's own clock, the one that stamped each line.
  const nowMs = report ? Date.parse(report.generatedAt) : 0;

  return <section className={styles.section} aria-label="App actions" aria-busy={(!report && read.status !== 'error') || undefined}>
    <h3 className={styles.title}>App actions</h3>
    {!report ? <p className={styles.muted} role="status">{read.status === 'error'
      ? 'App actions are unknown: the log did not answer. It is read again every 30 seconds.' : 'Reading app actions…'}</p> : <>
      <div className={own.head}>
        <p className={own.headline} role="status" data-unknown={report.total === null || undefined}>{actionsHeadline(report)}</p>
        {report.actions.length > 0 ? <div className={own.filter} role="group" aria-label="Which actions to list">
          <button type="button" aria-pressed={!onlyLook} onClick={() => setOnlyLook(false)}>All {report.actions.length}</button>
          <button type="button" aria-pressed={onlyLook} onClick={() => setOnlyLook(true)}>Needs a look {look.length}</button>
        </div> : null}
      </div>
      {read.status === 'error' ? <p className={styles.muted} role="status">Refresh failed; this list may be stale.</p> : null}
      {shown.length > 0 ? <ol className={own.list} aria-label={onlyLook ? 'App actions that need a look' : 'App actions, newest first'}>
        {shown.map((entry) => {
          const line = actionLine(entry, nowMs);
          return <li key={entry.key} className={own.row} data-tone={line.tone}>
            <span className={own.dot} aria-hidden="true" />
            <span className={own.what}>{line.title}</span>
            <time className={own.when} dateTime={entry.at} title={new Date(entry.at).toLocaleString()}>{line.when}</time>
            {entry.detail ? <span className={own.detail}>{entry.detail}</span> : null}
          </li>;
        })}
      </ol> : null}
      {onlyLook && look.length === 0 && report.actions.length > 0
        ? <p className={styles.muted}>Nothing in this list needs a look: every action listed finished.</p> : null}
      {report.truncated ? <p className={styles.muted}>Showing the newest {report.actions.length} of {report.total}. <code>phm apps log --limit 200</code> lists more.</p> : null}
      {report.lookups ? <p className={styles.muted}>{report.lookups} lookups (list, status) are on record and not listed.</p> : null}
      {report.skipped > 0 ? <p className={styles.muted}>{report.skipped} feed {report.skipped === 1 ? 'line' : 'lines'} could not be read and may hide an action.</p> : null}
    </>}
  </section>;
}
