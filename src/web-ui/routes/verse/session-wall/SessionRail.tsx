/**
 * The list beside an open conversation in the Conversations pane: every
 * session as one row (who, state, when it last spoke, its newest line, how
 * many messages arrived since Mason last looked), so moving from one
 * conversation to the next never means going back to the wall. Drawn from the
 * wall's own read; hidden by the stylesheet when the pane is too narrow for
 * two columns. Up, Down, Home and End move between rows, Enter opens, Esc
 * returns to the wall.
 */
import { useEffect, useRef, type KeyboardEvent } from 'react';
import { sessionAge } from '../../../../core/fleet/live-sessions.js';
import { ProviderBadge } from '../../../components/primitives/ProviderBadge.js';
import { STATE_WORD, wallHeadline, type SessionWallRead, type WallEntry } from './session-wall-model.js';
import { unseenCount } from './wall-seen.js';
import styles from './session-wall.module.css';

/** A row's one line of conversation: the newest thing said, or the newest record when nothing was said. */
export function railPreview(entry: WallEntry): string {
  const newest = [...entry.messages].reverse();
  const line = newest.find(message => message.side !== 'record') ?? newest[0];
  if (!line) return 'Nothing recorded yet';
  const text = line.text.replace(/\s+/g, ' ').trim();
  return text ? `${line.label}: ${text}` : line.label;
}

/** The session after (`by` 1) or before (`by` -1) the open one, in the read's order; null at either end. */
export function railStep(read: SessionWallRead | null, openId: string, by: 1 | -1): string | null {
  if (!read || read.entries.length === 0) return null;
  const at = read.entries.findIndex(entry => entry.session.id === openId);
  // An open conversation that is not in the list (it left, or the read holds only the first sessions) steps onto the list's near end.
  const to = at < 0 ? (by === 1 ? 0 : read.entries.length - 1) : at + by;
  return read.entries[to]?.session.id ?? null;
}

export interface SessionRailProps {
  /** The wall's last read; null until it answers. */
  read: SessionWallRead | null;
  /** The wall's read failed and there is no earlier one to show. */
  failed: boolean;
  openId: string;
  onPick: (id: string) => void;
  onClose: () => void;
}

export function SessionRail({ read, failed, openId, onPick, onClose }: SessionRailProps) {
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

  return <nav ref={nav} className={styles.rail} aria-label="Every session" onKeyDown={onKeyDown}>
    <p className={styles.railHead}>{read ? wallHeadline(read) : failed ? 'The session list could not be read.' : 'Reading every session…'}</p>
    {read && <ul className={styles.railList}>
      {read.entries.map(entry => {
        const { session } = entry, fresh = unseenCount(entry, openId);
        return <li key={session.id}>
          <button type="button" className={styles.row} data-rail={session.id} data-state={session.state}
            aria-current={session.id === openId ? 'true' : undefined} onClick={() => onPick(session.id)}>
            <span className={styles.rowTop}>
              {session.kind === 'worker' && session.lane !== 'unknown' && <ProviderBadge of={session.lane} iconOnly size={12} />}
              <strong className={styles.id}>{session.id}</strong>
              {fresh > 0 && <span className={styles.fresh}>{fresh} new</span>}
              <span className={styles.muted}>{session.lastMessageAgeSeconds === null ? 'unknown' : sessionAge(session.lastMessageAgeSeconds)}</span>
            </span>
            <span className={styles.rowLine}><span className={styles.rowState} data-state={session.state}>{STATE_WORD[session.state]}</span> {railPreview(entry)}</span>
          </button>
        </li>;
      })}
    </ul>}
    {read && <p className={styles.railFoot}>J and K move to the next and previous conversation.</p>}
  </nav>;
}
