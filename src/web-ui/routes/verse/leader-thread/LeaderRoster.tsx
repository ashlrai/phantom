/**
 * "Working now": every running agent session, one line each, above the Leader
 * conversation. A line shows who it is, when it last spoke and the last thing
 * it said. Choosing a line aims the next message at it by putting `@RQ-...` in
 * the Leader reply box (the same hand-off the Feed's "Ask Leader" uses), so
 * nothing is sent until Mason sends it. Thread reads that session as a
 * conversation without leaving the pane; Log opens that job's Worker log.
 *
 * Keys, with a line focused: ↑/↓ or J/K move, Enter aims, T opens the
 * conversation, L opens the log.
 * The strip folds to its one-line count and remembers that.
 */
import { useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { ProviderBadge } from '../../../components/primitives/ProviderBadge.js';
import { useQuery, useRefetch } from '../../../data/hooks.js';
import { liveSessionsQuery, SESSIONS_POLL_MS } from '../fleet-sessions/sessions-model.js';
import { usePollWhileVisible } from '../shell/section-visibility.js';
import { setLeaderDraft } from './leader-draft-store.js';
import { aimText, rosterHeadline, rosterRows, stepRow, type RosterRow } from './leader-roster-model.js';
import styles from './leader-roster.module.css';

export const ROSTER_OPEN_KEY = 'phantom.leader.roster.open.v1';

/** localStorage can be denied (private mode); the strip then just starts open each time. */
function readOpen(): boolean {
  try { return window.localStorage.getItem(ROSTER_OPEN_KEY) !== '0'; } catch { return true; }
}
function writeOpen(open: boolean): void {
  try { window.localStorage.setItem(ROSTER_OPEN_KEY, open ? '1' : '0'); } catch { /* Storage can be unavailable. */ }
}

function Row({ row, aimed, reading, onAim, onOpenLog, onOpenThread }: {
  row: RosterRow; aimed: boolean; reading: boolean; onAim: (id: string) => void; onOpenLog: (job: string) => void; onOpenThread?: (session: string) => void;
}) {
  const line = <>
    {row.lane !== 'unknown' ? <ProviderBadge of={row.lane} iconOnly size={14} /> : null}
    <strong>{row.id}</strong>
    {row.kind === 'subagent' ? <span className={styles.kind}>helper</span> : null}
    <span className={styles.when} data-state={row.state}>{row.when}</span>
    <span className={styles.said} data-unknown={row.said === null || undefined}>{row.said ?? 'Last message unknown'}</span>
  </>;
  return <li className={styles.item} data-state={row.state} data-aimed={aimed || undefined} data-reading={reading || undefined}>
    {row.aimable
      ? <button type="button" className={styles.row} data-roster-row={row.id} data-job={row.job ?? undefined} data-session={row.session}
        aria-label={`Aim your next message at ${row.id}, ${row.when}`} title="Put this job in the reply box" onClick={() => onAim(row.id)}>{line}</button>
      : <span className={styles.row} data-roster-row={row.id} data-job={row.job ?? undefined} data-session={row.session} tabIndex={0}
        title="Only RQ- jobs can be named in a message">{line}</span>}
    {onOpenThread ? <button type="button" className={styles.side} data-roster-thread={row.session} aria-current={reading || undefined} aria-label={`Read ${row.id} as a conversation`}
      title="What it was told, said and did, with a reply box (T)" onClick={() => onOpenThread(row.session)}>Thread</button> : null}
    {row.prUrl ? <a className={styles.side} href={row.prUrl} target="_blank" rel="noopener noreferrer">PR</a> : null}
    {row.job !== null ? <button type="button" className={styles.side} aria-label={`Open the log for ${row.id}`} onClick={() => onOpenLog(row.job!)}>Log</button> : null}
  </li>;
}

export function LeaderRoster({ visible, onOpenLog, onOpenSessions, onOpenThread, openSession = null }: {
  visible: boolean;
  /** The session whose conversation is open beside the strip; its line is marked. */
  openSession?: string | null;
  onOpenLog: (job: string) => void;
  /** When given, every line offers its session as a conversation (by session id). */
  onOpenThread?: (session: string) => void;
  onOpenSessions: () => void;
}) {
  const read = useQuery(liveSessionsQuery, { enabled: visible, freshMs: SESSIONS_POLL_MS });
  const refetch = useRefetch(liveSessionsQuery);
  usePollWhileVisible(refetch, SESSIONS_POLL_MS, { enabled: visible });
  const [open, setOpen] = useState(readOpen);
  const [aimed, setAimed] = useState<string | null>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const rows = useMemo(() => (read.data ? rosterRows(read.data) : []), [read.data]);

  function aim(id: string) {
    setLeaderDraft(aimText(id));
    setAimed(id);
  }
  function onKeyDown(event: KeyboardEvent<HTMLUListElement>) {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const focused = (event.target as HTMLElement).closest<HTMLElement>('[data-roster-row]');
    if (!focused) return;
    const lines = [...(listRef.current?.querySelectorAll<HTMLElement>('[data-roster-row]') ?? [])];
    const delta = event.key === 'ArrowDown' || event.key === 'j' ? 1 : event.key === 'ArrowUp' || event.key === 'k' ? -1 : 0;
    if (delta !== 0) {
      event.preventDefault();
      lines[stepRow(lines.length, lines.indexOf(focused), delta)]?.focus();
    } else if (event.key === 'l' && focused.dataset.job) {
      event.preventDefault();
      onOpenLog(focused.dataset.job);
    } else if (event.key === 't' && onOpenThread && focused.dataset.session) {
      event.preventDefault();
      onOpenThread(focused.dataset.session);
    }
  }

  const reading = read.data === undefined && !read.error;
  const list = read.data ?? null;
  // "Unavailable" is its own fact: it must not read as "nobody is working".
  const headline = reading ? 'Reading sessions…' : list === null ? 'Sessions unavailable right now; it retries every few seconds' : rosterHeadline(rows, list);
  return <section className={styles.roster} aria-label="Working now" data-open={open ? 'true' : 'false'}>
    <header className={styles.head}>
      <button type="button" className={styles.toggle} aria-expanded={open} onClick={() => setOpen(value => { writeOpen(!value); return !value; })}>
        <span className={styles.pulse} data-live={rows.length > 0 || undefined} aria-hidden="true" />
        Working now
      </button>
      <span className={styles.headline} role="status" aria-busy={reading || undefined} data-tone={!reading && list === null ? 'unknown' : undefined}>{headline}</span>
      <button type="button" className={styles.side} onClick={onOpenSessions}>All sessions</button>
    </header>
    {open && list !== null && rows.length > 0
      ? <ul ref={listRef} className={styles.list} aria-label="Running agent sessions" onKeyDown={onKeyDown}>
        {rows.map(row => <Row key={row.id} row={row} aimed={aimed === row.id} reading={openSession === row.session} onAim={aim} onOpenLog={onOpenLog} onOpenThread={onOpenThread} />)}
      </ul> : null}
    {open && list !== null && read.error ? <p className={styles.note} role="status" data-tone="unknown">Refresh failed; this list may be stale.</p> : null}
    {open && list !== null && list.gaps.length > 0
      ? <p className={styles.note} data-tone="unknown">Unknown: {list.gaps[0]}{list.gaps.length > 1 ? ` (and ${list.gaps.length - 1} more in All sessions)` : ''}</p> : null}
    <p className={styles.aimed} role="status" aria-live="polite">{aimed !== null ? `@${aimed} is in the reply box. Nothing is sent until you send it.` : ''}</p>
  </section>;
}
