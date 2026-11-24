/**
 * The bar under a session conversation's header while it is open at a found
 * line (thread-found.ts): which words, which of the entries holding them the
 * reader is at, and the way to the earlier and later ones. `,` goes to the
 * earlier entry and `.` to the later one from anywhere in the conversation but
 * a text field. The entry the reader is at scrolls to the middle and is
 * ringed; every entry holding a word has the word marked. While the whole
 * conversation is still being read the bar says so and the view waits, so the
 * reader is taken to the line once and not to the end first. "Done" drops the
 * marks and leaves the reader where they are.
 */
import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import { useRefresh } from '../../../data/hooks.js';
import { markParts } from '../session-wall/wall-find.js';
import { sessionThreadQuery, type SessionThread } from './session-thread-model.js';
import { useWantsEarlier } from './thread-depth.js';
import { foundAt, foundLine, foundStep, holdingKeys, useFoundPlace, type FoundPlace } from './thread-found.js';
import styles from './thread-found.module.css';

/** What the conversation draws from: the words to mark, the entries that hold one, and the entry the reader is at. */
export interface FoundMarks { words: readonly string[]; held: ReadonlySet<string>; here: string | null }

export interface ThreadFoundState {
  /** Null when the conversation was not opened at a found line. */
  bar: ReactNode;
  marks: FoundMarks | null;
  /** True while the reader is being held at a found line: the conversation then does not scroll to its end or its "New" mark. */
  hold: RefObject<boolean>;
}

/** `text` with each found word marked. */
export function FoundText({ text, words }: { text: string; words: readonly string[] }) {
  return <>{markParts(text, words).map((part, at) => (part.hit ? <mark key={at} className={styles.mark}>{part.text}</mark> : <Fragment key={at}>{part.text}</Fragment>))}</>;
}

/** The attribute an entry carries: `here` for the one the reader is at, `held` for another holding a word. */
export const foundAttr = (marks: FoundMarks | null | undefined, key: string): 'here' | 'held' | undefined =>
  (!marks ? undefined : marks.here === key ? 'here' : marks.held.has(key) ? 'held' : undefined);

export function useThreadFound(id: string, thread: SessionThread | null, root: RefObject<HTMLElement | null>): ThreadFoundState {
  const [place, done] = useFoundPlace(id);
  const asked = useWantsEarlier(id);
  const def = useMemo(() => sessionThreadQuery(id), [id]);
  const refresh = useRefresh(def);
  // The entry stepped to, for the request it was stepped in: a new request starts at the line it names.
  const [stepped, setStepped] = useState<{ of: FoundPlace; key: string } | null>(null);
  const cursor = place !== null && stepped?.of === place ? stepped.key : null;
  const setCursor = (key: string) => { if (place !== null) setStepped({ of: place, key }); };
  const hold = useRef(false);
  // The read on screen is the newest entries and the whole conversation was asked for: the line may not be here yet.
  const settling = place !== null && (thread === null || (thread.depth === 'recent' && thread.deeper && asked));
  const held = useMemo(() => (place && thread ? holdingKeys(thread.messages, place.words) : []), [place, thread]);
  const here = place === null || settling ? null : foundAt(held, place.key, cursor);
  const loaded = thread !== null;

  // A conversation already on screen at its newest entries is read again, whole; one not yet read asks for the whole one itself.
  useEffect(() => { if (place !== null && loaded && settling) refresh(); }, [place, loaded, settling, refresh]);
  useEffect(() => { hold.current = place !== null && (settling || here !== null); });
  useEffect(() => {
    if (here === null) return;
    root.current?.querySelector('[data-found="here"]')?.scrollIntoView?.({ block: 'center' });
  }, [here, place, root]);

  const earlier = foundStep(held, here, -1), later = foundStep(held, here, 1);
  useEffect(() => {
    const node = root.current;
    if (!node || place === null) return;
    const onKey = (event: KeyboardEvent) => {
      if ((event.key !== ',' && event.key !== '.') || event.metaKey || event.ctrlKey || event.altKey || event.defaultPrevented) return;
      if (event.target instanceof Element && event.target.closest('textarea, input, select, [role="dialog"]')) return;
      event.preventDefault();
      const to = event.key === ',' ? earlier : later;
      if (to !== null) setStepped({ of: place, key: to });
    };
    node.addEventListener('keydown', onKey);
    return () => node.removeEventListener('keydown', onKey);
  }, [root, place, earlier, later]);

  const marks = useMemo<FoundMarks | null>(() => (place === null ? null : { words: place.words, held: new Set(held), here }), [place, held, here]);
  if (place === null || thread === null) return { bar: null, marks, hold };
  const whole = thread.depth !== 'recent' || !thread.deeper;
  // The line chosen is not among the entries read: the records moved on, or the read stops short of it.
  const moved = !settling && place.key !== null && here !== null && !held.includes(place.key);
  const bar = <div className={styles.bar} data-thread-found={settling ? 'reading' : here === null ? 'none' : 'at'}>
    <p className={styles.line} role="status">
      {settling ? `Reading the whole conversation for “${place.words.join(' ')}”…` : foundLine(place.words, held, here, thread.messages.length, whole)}
      {moved && <span className={styles.moved} data-moved> · The line you chose is not in this read; this is the newest that holds the words.</span>}
    </p>
    {!settling && held.length > 1 && <>
      <button type="button" className={styles.step} disabled={earlier === null} onClick={() => earlier !== null && setCursor(earlier)} title="The earlier entry holding the words (,)">↑ Earlier <kbd>,</kbd></button>
      <button type="button" className={styles.step} disabled={later === null} onClick={() => later !== null && setCursor(later)} title="The later entry holding the words (.)">↓ Later <kbd>.</kbd></button>
    </>}
    <button type="button" className={styles.step} onClick={done} title="Drop the marks and stay here">Done</button>
  </div>;
  return { bar, marks, hold };
}
