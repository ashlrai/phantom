/**
 * Earlier messages in the Leader pane. The pane polls the newest page of the Leader thread; this adds the pages
 * before it, one at a time, from the same read (`before=<oldest id>`), so the conversation can be read back to
 * the start of what this computer holds. `useEarlierMessages` gives the pane the longer thread, and
 * `EarlierMessages` is the row at the top of the conversation: how far back it reaches, Load earlier messages,
 * and Show newest only. With the conversation focused and scrolled to its top, Up, Page Up or Home loads the
 * next page. The reading position is kept when a page arrives above it.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { readFailureReason } from '../../../data/client.js';
import { fetchOlderThread, THREAD_PAGE_SIZE } from '../leader/thread-data.js';
import type { LeaderThreadMessage } from '../leader/thread-types.js';
import { asksForEarlier, canLoadEarlier, earlierLine, earlierShown, joinThread, type EarlierState } from './leader-earlier-model.js';
import styles from './leader-earlier.module.css';

export interface EarlierControl {
  state: EarlierState;
  shown: boolean;
  canLoad: boolean;
  /** Messages loaded from before the newest page. */
  earlierCount: number;
  /** Thread messages held in all. */
  total: number;
  oldestAt: string | null;
  reason: string | null;
  load: () => void;
  newestOnly: () => void;
}

export function useEarlierMessages(page: LeaderThreadMessage[]): { messages: LeaderThreadMessage[]; control: EarlierControl } {
  const [earlier, setEarlier] = useState<LeaderThreadMessage[]>([]);
  const [state, setState] = useState<EarlierState>('idle');
  const [reason, setReason] = useState<string | null>(null);
  const busy = useRef(false);
  // Every newest-page message seen while earlier pages are on screen. Polling slides the newest-50 window
  // forward; without this, the messages that fall off its end would leave a hole above the new ones.
  const tail = useRef<LeaderThreadMessage[]>(page);

  const messages = useMemo(() => {
    if (earlier.length === 0) { tail.current = page; return page; }
    // Joining is idempotent, so a repeated render leaves the same tail.
    tail.current = joinThread(tail.current, page);
    return joinThread(earlier, tail.current);
  }, [earlier, page]);

  const oldestId = messages[0]?.id ?? null;
  const load = useCallback(() => {
    if (oldestId === null || busy.current) return;
    busy.current = true;
    setState('loading');
    setReason(null);
    void fetchOlderThread(oldestId).then(got => {
      setEarlier(prev => joinThread(got, prev));
      setState(got.length < THREAD_PAGE_SIZE ? 'done' : 'idle');
    }, (err: unknown) => {
      setReason(readFailureReason(err));
      setState('error');
    }).finally(() => { busy.current = false; });
  }, [oldestId]);
  const newestOnly = useCallback(() => { setEarlier([]); setState('idle'); setReason(null); }, []);

  const control: EarlierControl = {
    state, reason, load, newestOnly,
    shown: earlierShown(state, page.length, earlier.length, THREAD_PAGE_SIZE),
    canLoad: oldestId !== null && canLoadEarlier(state, page.length, earlier.length, THREAD_PAGE_SIZE),
    earlierCount: earlier.length,
    total: messages.length,
    oldestAt: messages[0]?.at ?? null,
  };
  return { messages, control };
}

export function EarlierMessages({ control }: { control: EarlierControl }) {
  const { state, canLoad, earlierCount, load } = control;
  const rootRef = useRef<HTMLDivElement>(null);
  /** Distance from the end of the conversation when a page was asked for; restored once it arrives. */
  const anchor = useRef<number | null>(null);
  const lastCount = useRef(earlierCount);
  const scroller = () => rootRef.current?.closest<HTMLElement>('[role="log"]') ?? null;

  const ask = useCallback(() => {
    const el = rootRef.current?.closest<HTMLElement>('[role="log"]') ?? null;
    anchor.current = el ? el.scrollHeight - el.scrollTop : null;
    load();
  }, [load]);

  useLayoutEffect(() => {
    const el = scroller();
    if (el && earlierCount > lastCount.current && anchor.current !== null) el.scrollTop = el.scrollHeight - anchor.current;
    // Back to the newest page: the place being read is gone, so the conversation returns to its end.
    else if (el && earlierCount === 0 && lastCount.current > 0) el.scrollTop = el.scrollHeight;
    if (earlierCount !== lastCount.current) anchor.current = null;
    lastCount.current = earlierCount;
  }, [earlierCount]);

  useEffect(() => {
    const el = scroller();
    if (!el || !canLoad) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.target !== el || el.scrollTop > 0 || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey || !asksForEarlier(event.key)) return;
      event.preventDefault();
      ask();
    };
    el.addEventListener('keydown', onKeyDown);
    return () => el.removeEventListener('keydown', onKeyDown);
  }, [canLoad, ask]);

  if (!control.shown) return null;
  const loading = state === 'loading';
  return <div ref={rootRef} className={styles.root} data-state={state} data-earlier-row="">
    <p className={styles.line} role="status" aria-busy={loading || undefined}>{earlierLine(control, Date.now())}</p>
    {canLoad ? <button type="button" className={styles.action} onClick={ask}>{state === 'error' ? 'Try again' : 'Load earlier messages'}</button> : null}
    {earlierCount > 0 && !loading ? <button type="button" className={styles.action} data-quiet="true" onClick={control.newestOnly}>Show newest only</button> : null}
    {loading ? <span className={styles.sweep} aria-hidden="true" /> : null}
  </div>;
}
