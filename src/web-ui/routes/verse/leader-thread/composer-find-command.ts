/**
 * routes/verse/leader-thread/composer-find-command.ts: `/find <words>` in the
 * Leader reply box. It looks for the words in every session's whole
 * conversation, the read behind the Conversations find box and
 * `phm sessions find <words> --json` (session-wall/wall-find.ts), and answers
 * in the chat: a line saying how many sessions hold the words, then one row a
 * session with its state, how much of its conversation matches and the newest
 * line that does. A job a row names is a button that opens that session beside
 * the chat, and a row that quotes a job's line has "Open at this line", which
 * opens the conversation at the line quoted (ComposerResultLine.tsx).
 * Which line a row quotes is kept here for this window only: an answer left
 * from before a reload keeps its words and its session buttons, no more.
 *
 * It only reads, so it needs no token and posts no inbox note. Nothing is
 * invented: a search that does not answer says so with the reason, and what
 * the read could not search is said under the rows. It never throws.
 */
import { ApiError } from '../../../data/client.js';
import type { FoundPlace } from '../fleet-sessions/thread-found.js';
import { clockTime } from '../leader/thread-model.js';
import { NO_SCOPE } from '../session-wall/session-wall-model.js';
import { findFailure, findQuery, foundHeadline, foundMeta, sessionFindQuery, type FoundSession, type SessionFindRead } from '../session-wall/wall-find.js';

export interface FindCommandDeps {
  /** The search for one query (already cut to what the server accepts); null when the answer is not a search result. */
  find: (query: string) => Promise<SessionFindRead | null>;
}

export const liveFindDeps: FindCommandDeps = {
  find: query => sessionFindQuery(query, NO_SCOPE).fetch(),
};

/** Sessions given a row in the answer, and the longest line quoted; the rest are counted. */
export const FIND_ROWS = 6, FIND_QUOTE_CHARS = 140;

const ROWS_KEPT = 60;
const quotedLines = new Map<string, FoundPlace>();

/** The line a row of an answer quotes, when that answer was given in this window and the row is a job's. */
export const foundRowPlace = (row: string): FoundPlace | null => quotedLines.get(row) ?? null;

/** Keeps which line each row of `read`'s answer quotes. Only a job's row: the chat opens jobs beside it, and `/thread` opens the rest. */
export function rememberFoundRows(read: SessionFindRead): void {
  for (const result of read.results.slice(0, FIND_ROWS)) {
    const hit = result.hits[result.hits.length - 1];
    if (hit && result.kind === 'worker') quotedLines.set(foundRow(result, read.words), { id: result.id, words: read.words, key: hit.key });
  }
  // The oldest rows go first; a Map keeps the order they were set in.
  for (const row of [...quotedLines.keys()].slice(0, Math.max(0, quotedLines.size - ROWS_KEPT))) quotedLines.delete(row);
}

/** The words a `/find` argument searches for, or null when it holds none of two letters or more. */
export const findArg = (arg: string): string | null => findQuery(arg);

/** A line cut to `max` characters around the first word found in it, with … where it was cut. */
export function quoteAround(line: string, words: readonly string[], max = FIND_QUOTE_CHARS): string {
  const flat = line.replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  const low = flat.toLowerCase();
  const found = words.map(word => low.indexOf(word)).filter(at => at >= 0);
  const first = found.length > 0 ? Math.min(...found) : 0;
  // A third of the room before the word, so what led up to it reads too.
  const from = Math.max(0, Math.min(first - Math.floor(max / 3), flat.length - max));
  return `${from > 0 ? '…' : ''}${flat.slice(from, from + max).trim()}${from + max < flat.length ? '…' : ''}`;
}

/** "RQ-A (running · 3 of 60 messages) said at 2:02 PM: “…the merge queue is stuck…”"; a line someone else wrote names them instead of "said". */
export function foundRow(result: FoundSession, words: readonly string[]): string {
  const head = `${result.id} (${foundMeta(result)})`;
  const hit = result.hits[result.hits.length - 1];
  if (!hit) return result.summary ? `${head} ${quoteAround(result.summary, words)}` : head;
  const when = hit.at ? clockTime(hit.at) : '';
  return `${head} ${hit.label === result.id ? 'said' : hit.label}${when ? ` at ${when}` : ''}: “${quoteAround(hit.text, words)}”`;
}

/** The answer: the headline, a row a session (newest hit quoted), then what is left out and what was not searched. One line each. */
export function findAnswer(read: SessionFindRead): string {
  const shown = read.results.slice(0, FIND_ROWS), more = read.results.length - shown.length;
  const leader = shown.some(result => result.kind !== 'worker');
  return [
    `${foundHeadline(read)}${shown.length > 0 ? ':' : '.'}`,
    ...shown.map(result => foundRow(result, read.words)),
    ...(more > 0 ? [`And ${more} more ${more === 1 ? 'session' : 'sessions'}: the find box in Conversations lists them all.`] : []),
    ...(leader ? ['/thread <session> opens one that is not a job.'] : []),
    ...(read.gaps.length > 0 ? [`Not searched: ${read.gaps[0]!.replace(/\s+/g, ' ')}${read.gaps.length > 1 ? ` (and ${read.gaps.length - 1} more)` : ''}`] : []),
  ].join('\n');
}

/** Runs `/find` and returns what the conversation shows. The argument was checked by commandArgError. */
export async function runFindCommand(arg: string, deps: FindCommandDeps): Promise<string> {
  const query = findArg(arg)!;
  try {
    const read = await deps.find(query);
    if (read) rememberFoundRows(read);
    return read ? findAnswer(read) : `Whether any conversation holds “${query}” is unknown: the server answered with something that is not a search result.`;
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return `Whether any conversation holds “${query}” is unknown: this Phantom server cannot search whole conversations yet. Update Phantom.`;
    return findFailure(error).text;
  }
}
