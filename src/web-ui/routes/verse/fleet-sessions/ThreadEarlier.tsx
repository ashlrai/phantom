/**
 * The foot of an opened session conversation: what the read left out, and the
 * way to the earlier entries. A conversation is read at its newest entries
 * (50 bus messages, 10 of Mason's, 12 log lines…); when the server says a
 * deeper read of the same records holds more (`deeper`), "Show earlier" asks
 * for it (`depth=full`, thread-depth.ts) and the conversation is read again.
 * The entries on screen stay while it reads, and the row then says how many
 * joined them, since they land above what was already there. E does the same
 * from anywhere in the conversation but a text field. A server that names no
 * depth gets the plain list of what was left out and no button.
 */
import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useRefresh } from '../../../data/hooks.js';
import { sessionThreadQuery, type SessionThread } from './session-thread-model.js';
import { setWantsEarlier, useWantsEarlier } from './thread-depth.js';
import threadStyles from './session-thread.module.css';
import styles from './thread-earlier.module.css';

/**
 * `offer`: earlier entries exist and were not asked for. `reading`: asked for, and the read on screen is still the newest
 * entries. `full`: the read on screen holds them. `folding`: given up, and the read on screen still holds them.
 */
export type EarlierState = 'none' | 'offer' | 'reading' | 'full' | 'folding';

export function earlierState(thread: Pick<SessionThread, 'depth' | 'deeper'>, asked: boolean): EarlierState {
  if (thread.depth === null) return 'none';
  if (thread.depth === 'full') return asked ? 'full' : 'folding';
  return asked ? 'reading' : thread.deeper ? 'offer' : 'none';
}

/** What the row says once the earlier entries are on screen. `added` is null when this window did not see them arrive. */
export function earlierLine(added: number | null): string {
  if (added === null) return 'Showing the earlier entries too.';
  return added === 0 ? 'Nothing earlier is on record: this is every entry.' : `${added} earlier ${added === 1 ? 'entry' : 'entries'} shown above.`;
}

export function ThreadEarlier({ thread }: { thread: SessionThread }) {
  const id = thread.session.id;
  const asked = useWantsEarlier(id);
  const state = earlierState(thread, asked);
  const def = useMemo(() => sessionThreadQuery(id), [id]);
  // A press promises a read made after it, never one that was already on its way at the old depth.
  const refresh = useRefresh(def);
  const row = useRef<HTMLDivElement>(null);
  // The entries that were on screen when the earlier ones were asked for, so the row can count what joined them.
  const before = useRef<{ id: string; keys: ReadonlySet<string> } | null>(null);
  const added = state === 'full' && before.current?.id === id ? thread.messages.filter(message => !before.current!.keys.has(message.key)).length : null;

  const toggle = useCallback(() => {
    if (state === 'offer') { before.current = { id, keys: new Set(thread.messages.map(message => message.key)) }; setWantsEarlier(id, true); }
    else if (state === 'full') { before.current = null; setWantsEarlier(id, false); }
    else return;
    refresh();
  }, [state, id, thread.messages, refresh]);

  // E from anywhere in the conversation. Listened for on the conversation's own section, so the key lives and dies with this row.
  useEffect(() => {
    const root = row.current?.closest('section');
    if (!root || (state !== 'offer' && state !== 'full')) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'e' || event.metaKey || event.ctrlKey || event.altKey || event.defaultPrevented) return;
      if (event.target instanceof Element && event.target.closest('textarea, input, select, [role="dialog"]')) return;
      event.preventDefault();
      toggle();
    };
    root.addEventListener('keydown', onKey);
    return () => root.removeEventListener('keydown', onKey);
  }, [state, toggle]);

  const toStart = () => row.current?.closest('section')?.querySelector('ol > li')?.scrollIntoView?.({ block: 'start' });
  return <div ref={row} className={styles.earlier} data-earlier={state}>
    {thread.gaps.length > 0 && <ul className={threadStyles.gaps} aria-label="Not shown">{thread.gaps.map(gap => <li key={gap}>{gap}</li>)}</ul>}
    {state !== 'none' && <p className={styles.row} data-state={state}>
      {state === 'offer' && <>
        <span>Only the newest entries of each record are shown.</span>
        <button type="button" className={styles.action} onClick={toggle} title="Read the earlier entries the same records hold (E)">Show earlier <kbd>E</kbd></button>
      </>}
      {state === 'reading' && <span role="status" className={styles.busy}>Reading the earlier entries…</span>}
      {state === 'folding' && <span role="status" className={styles.busy}>Going back to the newest entries…</span>}
      {state === 'full' && <>
        <span role="status">{earlierLine(added)}</span>
        {added !== 0 && <button type="button" className={styles.action} onClick={toStart}>Go to the first</button>}
        <button type="button" className={styles.action} onClick={toggle} title="Go back to the newest entries of each record (E)">Show fewer <kbd>E</kbd></button>
      </>}
    </p>}
  </div>;
}
