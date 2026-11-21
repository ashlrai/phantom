/**
 * The list beside an open conversation in the Conversations pane: every
 * session as one row (who, state, a pause or request that stands for its job,
 * when it last spoke, its newest line, the size of its job's diff and its newest
 * recorded step with how long ago (WallVitals.tsx), how
 * many messages arrived since Mason last looked), so moving from one
 * conversation to the next never means going back to the wall. Drawn from the
 * wall's own read; hidden by the stylesheet when the pane is too narrow for
 * two columns. Up, Down, Home and End move between rows, Enter opens, Esc
 * returns to the wall. Words in the wall's find box narrow this list too (the
 * open conversation always keeps its row), and a button above the rows opens
 * the next conversation that holds new messages.
 */
import { useEffect, useRef, type KeyboardEvent } from 'react';
import { sessionAge } from '../../../../core/fleet/live-sessions.js';
import { ProviderBadge } from '../../../components/primitives/ProviderBadge.js';
import { findEntries, STATE_WORD, wallHeadline, type SessionWallRead, type WallEntry } from './session-wall-model.js';
import { nextUnseen, unseenCount, unseenSessions } from './wall-seen.js';
import { RailVitalsLine } from './WallVitals.js';
import { cardVitals } from './wall-vitals.js';
import { steerMark } from './wall-steer.js';
import styles from './session-wall.module.css';
import steerStyles from './wall-steer.module.css';

/** A row's one line of conversation: the newest thing said, or the newest record when nothing was said. */
export function railPreview(entry: WallEntry): string {
  const newest = [...entry.messages].reverse();
  const line = newest.find(message => message.side !== 'record') ?? newest[0];
  if (!line) return 'Nothing recorded yet';
  const text = line.text.replace(/\s+/g, ' ').trim();
  return text ? `${line.label}: ${text}` : line.label;
}

/** The rows beside an open conversation: the sessions holding the find words, and the open one whether it holds them or not. */
export function railEntries(read: SessionWallRead | null, find: string, openId: string): readonly WallEntry[] {
  if (!read) return [];
  const found = findEntries(read.entries, find);
  if (found.length === read.entries.length) return read.entries;
  const keep = new Set(found);
  return read.entries.filter(entry => keep.has(entry) || entry.session.id === openId);
}

/** The session after (`by` 1) or before (`by` -1) the open one, in the order of the rows shown; null at either end. */
export function railStep(read: SessionWallRead | null, openId: string, by: 1 | -1, find = ''): string | null {
  const entries = railEntries(read, find, openId);
  if (entries.length === 0) return null;
  const at = entries.findIndex(entry => entry.session.id === openId);
  // An open conversation that is not in the list (it left, or the read holds only the first sessions) steps onto the list's near end.
  const to = at < 0 ? (by === 1 ? 0 : entries.length - 1) : at + by;
  return entries[to]?.session.id ?? null;
}

/** What the button that opens the next conversation with new messages says. */
export function newLabel(count: number): string {
  return `${count} conversation${count === 1 ? ' has' : 's have'} new messages`;
}

export interface SessionRailProps {
  /** The wall's last read; null until it answers. */
  read: SessionWallRead | null;
  /** The wall's read failed and there is no earlier one to show. */
  failed: boolean;
  openId: string;
  onPick: (id: string) => void;
  onClose: () => void;
  /** Words from the wall's find box; rows that do not hold them are left out. */
  find?: string;
  /** Clears the find words, bringing every session back. */
  onShowAll?: () => void;
}

export function SessionRail({ read, failed, openId, onPick, onClose, find = '', onShowAll }: SessionRailProps) {
  const nav = useRef<HTMLElement>(null);
  const rows = () => [...(nav.current?.querySelectorAll<HTMLButtonElement>('button[data-rail]') ?? [])];
  // The open conversation's row stays in view as J and K walk down a long list.
  useEffect(() => { rows().find(row => row.dataset.rail === openId)?.scrollIntoView?.({ block: 'nearest' }); }, [openId]);

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.key === 'Escape') { event.preventDefault(); onClose(); return; }
    const all = rows(), at = all.indexOf(document.activeElement as HTMLButtonElement);
    const to = event.key === 'ArrowDown' ? Math.min(at + 1, all.length - 1) : event.key === 'ArrowUp' ? Math.max(at - 1, 0)
      : event.key === 'Home' ? 0 : event.key === 'End' ? all.length - 1 : -1;
    if (to < 0 || !all[to]) return;
    event.preventDefault();
    all[to].focus();
  };

  const listed = railEntries(read, find, openId);
  const left = read ? read.entries.length - listed.length : 0;
  const next = nextUnseen(listed, openId), fresh = unseenSessions(listed, openId);
  return <nav ref={nav} className={styles.rail} aria-label="Every session" onKeyDown={onKeyDown}>
    <p className={styles.railHead}>{read ? wallHeadline(read) : failed ? 'The session list could not be read.' : 'Reading every session…'}</p>
    {left > 0 && <p className={styles.railNarrow} role="status">
      <span>{listed.length} of {read!.entries.length} listed: holding “{find.trim()}”, or open.</span>
      {onShowAll && <button type="button" className={styles.railAll} onClick={onShowAll}>Show all</button>}
    </p>}
    {next !== null && <button type="button" className={styles.next} data-next-new={next} onClick={() => onPick(next)} title="Open the next conversation with new messages (N)">
      {newLabel(fresh)} <kbd>N</kbd>
    </button>}
    {read && <ul className={styles.railList}>
      {listed.map(entry => {
        const { session } = entry, unread = unseenCount(entry, openId), mark = steerMark(entry);
        return <li key={session.id}>
          <button type="button" className={styles.row} data-rail={session.id} data-state={session.state}
            aria-current={session.id === openId ? 'true' : undefined} onClick={() => onPick(session.id)}>
            <span className={styles.rowTop}>
              {session.kind === 'worker' && session.lane !== 'unknown' && <ProviderBadge of={session.lane} iconOnly size={12} />}
              <strong className={styles.id}>{session.id}</strong>
              {unread > 0 && <span className={styles.fresh}>{unread} new</span>}
              <span className={styles.muted}>{session.lastMessageAgeSeconds === null ? 'unknown' : sessionAge(session.lastMessageAgeSeconds)}</span>
            </span>
            <span className={styles.rowLine}><span className={styles.rowState} data-state={session.state}>{STATE_WORD[session.state]}</span> {mark && <><span className={steerStyles.rowMark} data-tone={mark.tone}>{mark.text}</span> </>}{railPreview(entry)}</span>
            <RailVitalsLine vitals={cardVitals(entry, read.generatedAt)} />
          </button>
        </li>;
      })}
    </ul>}
    {read && <p className={styles.railFoot}>J and K move to the next and previous conversation, N to the next with new messages.</p>}
  </nav>;
}
