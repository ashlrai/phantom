/**
 * routes/verse/fleet-sessions/thread-found.ts: a session conversation opened
 * at a line a find turned up. The find box in Conversations and `/find` in the
 * Leader chat both search every session's whole conversation
 * (session-wall/wall-find.ts); choosing a line there asks here, and the
 * conversation that opens next (SessionThread.tsx) takes the request: it is
 * read with its earlier entries (thread-depth.ts), since the line may be older
 * than the newest few, and it opens at that line with the words marked
 * (ThreadFound.tsx).
 *
 * A request is taken once, so going back and opening the session again starts
 * at its newest message as always. Which entries hold the words is worked out
 * here from the entries on screen, by the rule the search itself uses
 * (core/fleet/session-find.ts: a word anywhere in an entry's label or text,
 * whatever its case). Nothing here is a fleet fact.
 */
import { useCallback, useEffect, useState } from 'react';
import { setWantsEarlier } from './thread-depth.js';

export interface FoundPlace {
  id: string;
  /** Lower case, two characters or more. */
  words: string[];
  /** The entry chosen; null opens at the newest entry holding a word. */
  key: string | null;
}

/** Session ids are job ids, `leader`, or helper ids: one short token, never free text. */
const SESSION_ID_RE = /^[\w.:@-]{1,160}$/;
const WORDS_MAX = 8;

let pending: FoundPlace | null = null;
const listeners = new Set<() => void>();

/** Asks the conversation with `id`, open or about to be, to show the entries holding `words`, starting at `key`. */
export function openThreadAtFound(id: string, words: readonly string[], key: string | null = null): void {
  const wanted = [...new Set(words.map(word => word.trim().toLowerCase()).filter(word => word.length >= 2))].slice(0, WORDS_MAX);
  if (!SESSION_ID_RE.test(id) || wanted.length === 0) return;
  pending = { id, words: wanted, key };
  // The search read the whole conversation, so the line may be older than the newest entries a fresh opening shows.
  setWantsEarlier(id, true);
  for (const listener of [...listeners]) listener();
}

/** The waiting request for `id`, cleared; null when there is none. */
export function takeFoundPlace(id: string): FoundPlace | null {
  if (pending?.id !== id) return null;
  const place = pending;
  pending = null;
  return place;
}

/** Drops a request nobody took (tests, and nothing else). */
export function forgetFoundPlace(): void {
  pending = null;
}

/** The request this conversation took, and the way to let it go. A request made while the conversation is open is taken too. */
export function useFoundPlace(id: string): [FoundPlace | null, () => void] {
  const [place, setPlace] = useState<FoundPlace | null>(null);
  useEffect(() => {
    const take = () => { const next = takeFoundPlace(id); if (next) setPlace(next); };
    take();
    listeners.add(take);
    return () => { listeners.delete(take); };
  }, [id]);
  const clear = useCallback(() => setPlace(null), []);
  return [place?.id === id ? place : null, clear];
}

/** Keys of the entries holding a word, in the order they are shown. */
export function holdingKeys(messages: readonly { key: string; label: string; text: string }[], words: readonly string[]): string[] {
  return messages.filter(message => { const low = `${message.label}\n${message.text}`.toLowerCase(); return words.some(word => low.includes(word)); }).map(message => message.key);
}

/** Where the reader stands among the entries that hold the words: the entry stepped to, else the one chosen, else the newest. Null when none holds them. */
export function foundAt(held: readonly string[], chosen: string | null, cursor: string | null): string | null {
  if (cursor !== null && held.includes(cursor)) return cursor;
  if (chosen !== null && held.includes(chosen)) return chosen;
  return held[held.length - 1] ?? null;
}

/** The entry one step earlier (-1) or later (1) than `at`; null at either end. */
export function foundStep(held: readonly string[], at: string | null, by: 1 | -1): string | null {
  const index = at === null ? -1 : held.indexOf(at);
  return index < 0 ? null : held[index + by] ?? null;
}

/**
 * What the bar says. `whole` is false while the entries on screen are only the newest of each record, so a count is never
 * read as the whole conversation's. `total` is the number of entries on screen.
 */
export function foundLine(words: readonly string[], held: readonly string[], at: string | null, total: number, whole: boolean): string {
  const said = `“${words.join(' ')}”`, scope = whole ? '' : ' shown';
  if (at === null) {
    return `None of the ${total} ${total === 1 ? 'entry' : 'entries'}${scope} holds ${said}. A find also reads a session's id, lane, repo and summary.`;
  }
  return `Found ${said}: entry ${held.indexOf(at) + 1} of ${held.length}${whole ? '' : ' in the entries shown'}`;
}
