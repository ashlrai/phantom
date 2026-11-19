/**
 * One app action in the Leader thread: what an agent (or a console button) did to an app on this Mac, and how
 * it ended, on a single line. A state mark, "Quit Slack", the outcome in words, the recorded reason, how long it
 * took and when. The row is a receipt, not a control: app buttons stay on the Host and Computers panes.
 */
import { formatRelative } from '../autonomy/format.js';
import { appActionStateWord, appActionTitle, appActionTone, appActionTook, type AppActionRow } from '../fleet-bus/app-action-envelope.js';
import styles from './app-action.module.css';

export function AppActionLine({ row, now, match, current }: { row: AppActionRow; now: number; match?: boolean; current?: boolean }) {
  const title = appActionTitle(row), state = appActionStateWord(row.state), took = appActionTook(row.tookMs);
  return <div role="group" className={styles.row} data-tone={appActionTone(row.state)} data-find-match={match || undefined}
    data-find-current={current || undefined} aria-label={`App action: ${title}, ${state}`}>
    <span className={styles.mark} aria-hidden="true" />
    <span className={styles.title}>{title}</span>
    <span className={styles.state}>{state}</span>
    {row.detail ? <span className={styles.detail} title={row.detail}>{row.detail}</span> : null}
    <span className={styles.when}>
      {took ? <span title="From accepted to result">{took}</span> : null}
      <time dateTime={row.at} title={new Date(row.at).toLocaleString()}>{formatRelative(row.at, now)}</time>
    </span>
  </div>;
}
