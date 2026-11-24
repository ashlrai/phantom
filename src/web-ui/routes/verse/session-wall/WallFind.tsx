/**
 * Under the wall's find box: the sessions whose whole conversation holds the
 * words typed, each with the lines that hold one and the words marked
 * (wall-find.ts; GET /api/verse/fleet/control/session-find). The cards below
 * are filtered at once from what is on screen; this asks the server once the
 * box has rested, and finds what the cards cannot: a word said earlier than a
 * card's three newest messages, or in a session past the forty on screen.
 * Choosing a result opens that session's conversation. Down from the find box
 * lands on the first result; arrows (or J and K) move between results and
 * past the last one go on to the cards.
 */
import { Fragment, useEffect, useMemo, useState, type KeyboardEvent } from 'react';
import { ProviderBadge } from '../../../components/primitives/ProviderBadge.js';
import { useQuery, useRefetch } from '../../../data/hooks.js';
import { clockTime } from '../leader/thread-model.js';
import type { WallScope } from './session-wall-model.js';
import { FIND_FRESH_MS, FIND_REST_MS, findFailure, findQuery, foundHeadline, foundMeta, markParts, sessionFindQuery, type FoundSession, type SessionFindRead } from './wall-find.js';
import styles from './wall-find.module.css';

/** The value once it has stopped changing for `ms`; the first value at once, so a find kept across a reload is searched straight away. */
function useRested<T>(value: T, ms: number): T {
  const [rested, setRested] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setRested(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return rested;
}

function Marked({ text, words }: { text: string; words: readonly string[] }) {
  return <>{markParts(text, words).map((part, at) => (part.hit ? <mark key={at} className={styles.mark}>{part.text}</mark> : <Fragment key={at}>{part.text}</Fragment>))}</>;
}

function Result({ result, words, onOpen }: { result: FoundSession; words: readonly string[]; onOpen: (id: string) => void }) {
  const more = result.hitCount - result.hits.length;
  return <li className={styles.result} data-state={result.state}>
    <button type="button" className={styles.open} data-found={result.id} onClick={() => onOpen(result.id)} aria-label={`Open ${result.id}: ${foundMeta(result)}`}>
      <span className={styles.top}>
        {result.kind === 'worker' && result.lane !== 'unknown' && <ProviderBadge of={result.lane} iconOnly size={14} />}
        <strong className={styles.id}><Marked text={result.id} words={words} /></strong>
        <span className={styles.meta}>{foundMeta(result)}</span>
      </span>
      {result.hits.length === 0 && <span className={styles.line} data-side="record" data-summary><span className={styles.text}>
        {result.summary ? <Marked text={result.summary} words={words} /> : 'Summary unknown: the read returned none.'}
      </span></span>}
      {more > 0 && <span className={styles.more}>{more} earlier message{more === 1 ? '' : 's'} hold{more === 1 ? 's' : ''} them too</span>}
      {result.hits.map(hit => <span key={hit.key} className={styles.line} data-side={hit.side}>
        <span className={styles.label}>{hit.label}{hit.at && ` · ${clockTime(hit.at)}`}</span>
        <span className={styles.text}><Marked text={hit.text} words={words} /></span>
      </span>)}
    </button>
  </li>;
}

export interface WallFindProps {
  /** The find box's text. Nothing is drawn, and nothing asked, until it holds a word of two characters. */
  find: string;
  /** The wall's own narrowing; the search answers the same one. */
  scope: WallScope;
  visible: boolean;
  onOpen: (id: string) => void;
  /** Hand the keyboard to the cards (Down past the last result). */
  onLeave: () => void;
}

export function WallFind({ find, scope, visible, onOpen, onLeave }: WallFindProps) {
  const query = findQuery(find), rested = useRested(query, FIND_REST_MS);
  const { lane, repo, live } = scope;
  const def = useMemo(() => sessionFindQuery(rested ?? '', { lane, repo, live }), [rested, lane, repo, live]);
  const read = useQuery(def, { enabled: visible && rested !== null, freshMs: FIND_FRESH_MS });
  const refetch = useRefetch(def);
  // The last answer stays on screen, dimmed, while the next one is read, so the list does not blink out between words.
  const [held, setHeld] = useState<SessionFindRead | null>(null);
  if (read.data && read.data !== held) setHeld(read.data);
  if (query === null) return null;
  const current = rested === query ? read.data : undefined;
  const failure = rested === query && read.error && !current ? findFailure(read.error) : null;
  const waiting = current === undefined && failure === null;
  const shown = current ?? (waiting ? held : null);

  const onKeyDown = (event: KeyboardEvent<HTMLUListElement>) => {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const all = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button[data-found]')], at = all.indexOf(document.activeElement as HTMLButtonElement);
    const down = event.key === 'ArrowDown' || event.key === 'j', up = event.key === 'ArrowUp' || event.key === 'k';
    if (at < 0 || (!down && !up && event.key !== 'Home' && event.key !== 'End')) return;
    event.preventDefault();
    // Keys handled here never reach the cards' own handler or the pane's.
    event.stopPropagation();
    if (down && at === all.length - 1) { onLeave(); return; }
    all[event.key === 'Home' ? 0 : event.key === 'End' ? all.length - 1 : Math.max(0, at + (down ? 1 : -1))]?.focus();
  };
  return <section className={styles.found} aria-label="Found in whole conversations" data-find={waiting ? 'reading' : failure ? 'failed' : 'read'}>
    <p className={styles.head} aria-live="polite">
      {waiting ? `Searching whole conversations for “${query}”…` : failure ? failure.text : current === null ? 'The server answered with something that is not a search result.' : foundHeadline(current!)}
      {failure?.kind === 'unavailable' && <button type="button" className={styles.again} onClick={refetch}>Try again</button>}
    </p>
    {shown && shown.results.length > 0 && <ul className={styles.results} aria-label="Sessions holding the words" data-stale={waiting ? '' : undefined} onKeyDown={onKeyDown}>
      {shown.results.map(result => <Result key={result.id} result={result} words={shown.words} onOpen={onOpen} />)}
    </ul>}
    {current && current.gaps.length > 0 && <ul className={styles.gaps} aria-label="Not searched">{current.gaps.map(gap => <li key={gap}>{gap}</li>)}</ul>}
  </section>;
}
