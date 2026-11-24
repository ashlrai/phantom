/**
 * The row above a session's conversation that narrows it: Everything,
 * Messages or Work (each with the number of entries it would show), and a
 * find box. From anywhere in the conversation but a text field, "/" puts the
 * cursor in the find box and 1, 2, 3 choose the view. Esc in the find box
 * clears the words first, then hands the keyboard back to the conversation.
 * See thread-narrow.ts for what each view holds.
 */
import { useCallback, useMemo, useState, type KeyboardEvent } from 'react';
import { Input } from '../../../components/primitives/Input.js';
import { Segmented } from '../../../components/primitives/Segmented.js';
import { chooseView, chosenView, isNarrowed, narrowLine, THREAD_VIEWS, VIEW_WORD, viewCounts, type NarrowEntry, type Narrowing, type ThreadView } from './thread-narrow.js';
import styles from './thread-narrow.module.css';

export interface ThreadNarrow {
  narrowing: Narrowing;
  setView: (view: ThreadView) => void;
  setFind: (find: string) => void;
}

/** The view is one choice for every conversation; the find words belong to conversation `id` and leave with it. */
export function useThreadNarrow(id: string): ThreadNarrow {
  const [view, setViewState] = useState<ThreadView>(chosenView);
  const [found, setFound] = useState({ id, find: '' });
  const find = found.id === id ? found.find : '';
  const narrowing = useMemo(() => ({ view, find }), [view, find]);
  const setView = useCallback((next: ThreadView) => { chooseView(next); setViewState(next); }, []);
  const setFind = useCallback((next: string) => setFound({ id, find: next }), [id]);
  return useMemo(() => ({ narrowing, setView, setFind }), [narrowing, setView, setFind]);
}

const FIND_ATTR = 'data-thread-find';
const VIEW_KEYS: Readonly<Record<string, ThreadView>> = { '1': 'all', '2': 'said', '3': 'did' };

/** The conversation's narrowing keys. True when the key was taken. Does nothing while the row is not on screen (an empty or unread conversation). */
export function narrowKey(event: KeyboardEvent<HTMLElement>, root: HTMLElement | null, narrow: ThreadNarrow): boolean {
  if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return false;
  if (event.target instanceof Element && event.target.closest('textarea, input, select, [role="dialog"]')) return false;
  const box = root?.querySelector<HTMLInputElement>(`[${FIND_ATTR}] input`);
  if (!box) return false;
  const view = VIEW_KEYS[event.key];
  if (view) narrow.setView(view);
  else if (event.key === '/') box.focus();
  else return false;
  event.preventDefault();
  return true;
}

export interface ThreadNarrowBarProps {
  /** Every entry of the conversation, shown or not. */
  entries: readonly NarrowEntry[];
  /** How many of them the narrowing leaves. */
  shown: number;
  narrow: ThreadNarrow;
}

export function ThreadNarrowBar({ entries, shown, narrow }: ThreadNarrowBarProps) {
  const { narrowing, setView, setFind } = narrow;
  const counts = useMemo(() => viewCounts(entries, narrowing.find), [entries, narrowing.find]);
  const narrowed = isNarrowed(narrowing);
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== 'Escape') return;
    // Handled here, so the conversation's own Esc (which closes it) never sees it.
    event.preventDefault();
    event.stopPropagation();
    if (narrowing.find !== '') setFind('');
    else event.currentTarget.closest<HTMLElement>('section[tabindex]')?.focus();
  };
  return <div className={styles.bar} role="search" aria-label="Narrow this conversation" data-narrowed={narrowed ? '' : undefined} {...{ [FIND_ATTR]: '' }}>
    <Segmented size="sm" aria-label="Show" value={narrowing.view} onChange={setView} options={THREAD_VIEWS.map((view, index) => ({
      value: view, ariaLabel: `${VIEW_WORD[view]}, ${counts[view]}`,
      label: <span title={`${VIEW_WORD[view]} (${index + 1})`}>{VIEW_WORD[view]} <span className={styles.n}>{counts[view]}</span></span>,
    }))} />
    <Input type="search" size="sm" className={styles.find} aria-label="Find in this conversation" placeholder="Find in this conversation   /"
      value={narrowing.find} onChange={event => setFind(event.target.value)} onKeyDown={onKeyDown} autoComplete="off" spellCheck={false} />
    <span className={styles.count} role="status">{narrowLine(shown, entries.length, narrowing)}</span>
    {narrowed && <button type="button" className={styles.clear} onClick={() => { setView('all'); setFind(''); }}>Show everything</button>}
  </div>;
}
