/**
 * "Ended in the last hour", under the Working now list: the sessions that
 * stopped running, with how each ended, so a session that leaves the list
 * above does not just disappear. Failed ones are always listed; the finished
 * ones fold behind the count line, and that choice is remembered.
 *
 * A row opens that session as a conversation in the pane (its brief, what it
 * said and did, its pull request). Its job is over, so it cannot be aimed at.
 * Keys, with a row focused: ↑/↓ or J/K move, Enter or T opens the
 * conversation, L opens the log.
 *
 * Drawn from the list the strip already read: no request of its own.
 */
import { useRef, useState, type KeyboardEvent } from 'react';
import { ProviderBadge } from '../../../components/primitives/ProviderBadge.js';
import { ENDED_WINDOW, endedCounts, endedShown, outcomeWords, type EndedRow } from './leader-ended-model.js';
import { stepRow } from './leader-roster-model.js';
import styles from './leader-ended.module.css';
import rosterStyles from './leader-roster.module.css';

export const ENDED_OPEN_KEY = 'phantom.leader.roster.ended.open.v1';

/** localStorage can be denied (private mode); the finished rows then start folded each time. */
function readOpen(): boolean {
  try { return window.localStorage.getItem(ENDED_OPEN_KEY) === '1'; } catch { return false; }
}
function writeOpen(open: boolean): void {
  try { window.localStorage.setItem(ENDED_OPEN_KEY, open ? '1' : '0'); } catch { /* Storage can be unavailable. */ }
}

function Row({ row, reading, onOpenLog, onOpenThread }: { row: EndedRow; reading: boolean; onOpenLog: (job: string) => void; onOpenThread?: (session: string) => void }) {
  const words = outcomeWords(row);
  const line = <>
    <span className={styles.mark} data-state={row.state} aria-hidden="true" />
    {row.lane !== 'unknown' ? <ProviderBadge of={row.lane} iconOnly size={14} /> : null}
    <strong>{row.id}</strong>
    {row.kind === 'subagent' ? <span className={rosterStyles.kind}>helper</span> : null}
    <span className={styles.when} data-state={row.state}>{row.when}</span>
    {words !== null ? <span className={rosterStyles.said} data-unknown={row.outcome === null || undefined}>{words}</span> : null}
  </>;
  return <li className={rosterStyles.item} data-state={row.state} data-reading={reading || undefined}>
    {onOpenThread
      ? <button type="button" className={rosterStyles.row} data-ended-row={row.id} data-job={row.job ?? undefined} data-roster-thread={row.session}
        aria-current={reading || undefined} aria-label={`Open the conversation with ${row.id}, ${row.when}`}
        title="What it was told, said and did (Enter or T)" onClick={() => onOpenThread(row.session)}>{line}</button>
      : <span className={rosterStyles.row} data-ended-row={row.id} data-job={row.job ?? undefined} tabIndex={0}>{line}</span>}
    {row.job !== null ? <button type="button" className={rosterStyles.side} aria-label={`Open the log for ${row.id}`} onClick={() => onOpenLog(row.job!)}>Log</button> : null}
  </li>;
}

export function LeaderEnded({ rows, openSession, onOpenLog, onOpenThread }: {
  /** Every ended session the list holds, failed first (leader-ended-model.ts). */
  rows: readonly EndedRow[];
  /** The session whose conversation is open beside the strip; its row is marked. */
  openSession: string | null;
  onOpenLog: (job: string) => void;
  onOpenThread?: (session: string) => void;
}) {
  const [open, setOpen] = useState(readOpen);
  const listRef = useRef<HTMLUListElement>(null);
  if (rows.length === 0) return null;
  const shown = endedShown(rows, open), folded = rows.length - shown.length;

  function onKeyDown(event: KeyboardEvent<HTMLUListElement>) {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const focused = (event.target as HTMLElement).closest<HTMLElement>('[data-ended-row]');
    if (!focused) return;
    const lines = [...(listRef.current?.querySelectorAll<HTMLElement>('[data-ended-row]') ?? [])];
    const delta = event.key === 'ArrowDown' || event.key === 'j' ? 1 : event.key === 'ArrowUp' || event.key === 'k' ? -1 : 0;
    if (delta !== 0) {
      event.preventDefault();
      lines[stepRow(lines.length, lines.indexOf(focused), delta)]?.focus();
    } else if (event.key === 'l' && focused.dataset.job) {
      event.preventDefault();
      onOpenLog(focused.dataset.job);
    } else if (event.key === 't' && onOpenThread && focused.dataset.rosterThread) {
      event.preventDefault();
      onOpenThread(focused.dataset.rosterThread);
    }
  }

  return <div className={styles.ended} data-ended>
    <p className={styles.head}>
      <button type="button" className={styles.toggle} aria-expanded={open} onClick={() => setOpen(value => { writeOpen(!value); return !value; })}>
        <span className={styles.chevron} aria-hidden="true">›</span>
        Ended in {ENDED_WINDOW}
      </button>
      <span className={styles.counts} role="status">{endedCounts(rows)}{folded > 0 ? ` · ${folded} finished not listed` : ''}</span>
    </p>
    {shown.length > 0
      ? <ul ref={listRef} className={styles.list} aria-label={open ? `Sessions that ended in ${ENDED_WINDOW}` : `Sessions that failed in ${ENDED_WINDOW}`} onKeyDown={onKeyDown}>
        {shown.map(row => <Row key={row.session} row={row} reading={openSession === row.session} onOpenLog={onOpenLog} onOpenThread={onOpenThread} />)}
      </ul> : null}
  </div>;
}
