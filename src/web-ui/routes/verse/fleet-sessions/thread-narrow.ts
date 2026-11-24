/**
 * routes/verse/fleet-sessions/thread-narrow.ts: narrowing one session's
 * conversation to the part being looked for. A long-running worker's read
 * holds its brief, every recorded step, command lists, output and the
 * messages exchanged; this picks out either the messages (what was said to
 * the session and what it said) or the work (everything else on record), and
 * keeps only the entries holding every find word.
 *
 * It narrows what the read already returned. Nothing is requested, and
 * nothing outside the read is searched: an entry the read left out (see the
 * conversation's "Not shown" list) is not found here either.
 */
export const THREAD_VIEWS = ['all', 'said', 'did'] as const;
export type ThreadView = (typeof THREAD_VIEWS)[number];
export const VIEW_WORD: Readonly<Record<ThreadView, string>> = { all: 'Everything', said: 'Messages', did: 'Work' };

/** Kinds of entry that are words exchanged: Mason's, the Leader's, the bus, the brief, and the session's own notes and latest line. Every other kind is work on record. */
const SAID_KINDS: ReadonlySet<string> = new Set(['order', 'routing', 'brief', 'bus', 'owner', 'reply', 'notes', 'latest', 'sent']);

export const viewOfKind = (kind: string): Exclude<ThreadView, 'all'> => (SAID_KINDS.has(kind) ? 'said' : 'did');

export interface NarrowEntry { key: string; kind: string; label: string; text: string }
export interface Narrowing { view: ThreadView; find: string }
export const NOT_NARROWED: Narrowing = { view: 'all', find: '' };
export const isNarrowed = (narrowing: Narrowing): boolean => narrowing.view !== 'all' || findWords(narrowing.find).length > 0;

export const findWords = (find: string): string[] => find.toLowerCase().split(/\s+/).filter(Boolean);

function holds(entry: NarrowEntry, words: readonly string[]): boolean {
  if (words.length === 0) return true;
  const hay = `${entry.label}\n${entry.text}`.toLowerCase();
  return words.every(word => hay.includes(word));
}

/** The entries left by the view and the find words, in the order given. The same array when nothing narrows. */
export function narrowEntries<T extends NarrowEntry>(entries: readonly T[], narrowing: Narrowing): readonly T[] {
  if (!isNarrowed(narrowing)) return entries;
  const words = findWords(narrowing.find);
  return entries.filter(entry => (narrowing.view === 'all' || viewOfKind(entry.kind) === narrowing.view) && holds(entry, words));
}

/** How many entries each view would show under the find words: where the hits are, before choosing. */
export function viewCounts(entries: readonly NarrowEntry[], find: string): Record<ThreadView, number> {
  const words = findWords(find);
  const counts: Record<ThreadView, number> = { all: 0, said: 0, did: 0 };
  for (const entry of entries) {
    if (!holds(entry, words)) continue;
    counts.all += 1;
    counts[viewOfKind(entry.kind)] += 1;
  }
  return counts;
}

/**
 * Where the "New" rule sits once entries are hidden: above the first entry still shown that is the marked one or
 * came after it. Null when the marked entry has left the read or nothing shown is that late.
 */
export function shownMark(all: readonly { key: string }[], shown: readonly { key: string }[], markKey: string | null): string | null {
  if (markKey === null) return null;
  const from = all.findIndex(entry => entry.key === markKey);
  if (from < 0) return null;
  const kept = new Set(shown.map(entry => entry.key));
  return all.slice(from).find(entry => kept.has(entry.key))?.key ?? null;
}

/** "12 of 41 shown"; empty when nothing narrows. */
export function narrowLine(shown: number, total: number, narrowing: Narrowing): string {
  return isNarrowed(narrowing) ? `${shown} of ${total} shown` : '';
}

/** Why the conversation is empty under the narrowing, in the reader's words. */
export function nothingLine(narrowing: Narrowing): string {
  const find = narrowing.find.trim();
  const where = narrowing.view === 'said' ? 'No message' : narrowing.view === 'did' ? 'No work on record' : 'Nothing';
  if (find !== '') return `${where} in this read holds “${find}”.`;
  return narrowing.view === 'said' ? 'No message is on record for this session.' : 'No work is on record for this session.';
}

// The view chosen is a reading habit, so it holds from one conversation to the next and across a reload. Find words belong to one conversation and are never kept.
export const THREAD_VIEW_KEY = 'phantom.sessionThreadView.v1';
let chosen: ThreadView | null = null;

const isView = (value: unknown): value is ThreadView => (THREAD_VIEWS as readonly unknown[]).includes(value);

export function chosenView(): ThreadView {
  if (chosen !== null) return chosen;
  let stored: string | null = null;
  try { stored = window.localStorage.getItem(THREAD_VIEW_KEY); } catch { /* storage denied: the choice lasts as long as the window */ }
  chosen = isView(stored) ? stored : 'all';
  return chosen;
}

export function chooseView(view: ThreadView): void {
  chosen = view;
  try {
    if (view === 'all') window.localStorage.removeItem(THREAD_VIEW_KEY);
    else window.localStorage.setItem(THREAD_VIEW_KEY, view);
  } catch { /* storage denied */ }
}

/** Test hook: forget the choice held in memory so the next read comes from storage. */
export function forgetChosenView(): void { chosen = null; }
