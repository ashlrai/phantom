/**
 * Words looked for in every session's whole conversation, in one read
 * (`fleet.session-find.v1`): behind `phm sessions find` and GET
 * /api/verse/fleet/control/session-find.
 *
 * Pure, and no source of its own. Each session's conversation is the thread
 * `phm sessions thread <id> --all` builds (session-thread.ts, depth `full`),
 * so a word said forty messages ago is found, which the three newest messages
 * `phm sessions threads` carries cannot do. A session is a result when every
 * word is somewhere in its id, lane, model, repo, summary or messages; its
 * `hits` are the messages holding a word, each cut to the words around it.
 * Matching ignores case and runs on text already scrubbed for the public
 * read, so a search can never confirm a secret the thread itself would hide.
 * The reader is `readSessionFind` in session-threads-read.ts.
 */
import { flatTree, type LiveSessionsV1 } from './live-sessions.js';
import { buildSessionThread, type SessionThreadMessage, type SessionThreadSession, type SessionThreadSource, type SessionThreadV1 } from './session-thread.js';
import { pickSessions, type SessionThreadsParts } from './session-threads.js';
import { sanitizePublicJson } from '../util/public-json.js';

export const SESSION_FIND_SCHEMA = 'fleet.session-find.v1';
/** The most sessions one search reads, the newest matching messages a result carries, and the longest excerpt. */
export const FIND_SESSIONS_MAX = 120, FIND_HITS_SHOWN = 5, FIND_TEXT_CHARS = 240;
/** The longest query and the most words taken from it; a word is at least two characters. */
export const FIND_QUERY_CHARS = 200, FIND_WORDS_MAX = 8;

/** Key order is the JSON contract. A matching message: `text` is the part of it around the first word found, with `…` where it was cut. */
export interface SessionFindHit extends Pick<SessionThreadMessage, 'key' | 'kind' | 'side' | 'label' | 'at' | 'text'> { truncated: boolean }
export interface SessionFindResult {
  session: SessionThreadSession;
  /** The same sentences `phm sessions thread <id>` prints. */
  summary: string[];
  /** The newest FIND_HITS_SHOWN messages holding a word, oldest of them first. Empty when the words are only in the session's facts or summary. */
  hits: SessionFindHit[];
  /** How many messages hold a word, and how many the conversation searched holds. */
  hitCount: number;
  messageCount: number;
}
export interface SessionFindV1 {
  schema: typeof SESSION_FIND_SCHEMA;
  generatedAt: string;
  /** The words searched for, lower case, as the read took them from the query. */
  words: string[];
  filter: { lane: string | null; repo: string | null; live: boolean };
  /** `sessions` counts every session in the list, `searched` the conversations read, `found` the results. */
  counts: { sessions: number; searched: number; found: number };
  /** In the order of the session tree: the leader, then each worker followed by its helpers. */
  results: SessionFindResult[];
  /** `unavailable` sessions means the list could not be read: no results is then not "nothing found". */
  sources: { sessions: 'available' | 'unavailable'; bus: SessionThreadSource; owner: SessionThreadSource; orders: SessionThreadSource };
  /** Plain words for what the search could not look through. */
  gaps: string[];
}

/** The words of a query: lower case, two characters or more, no repeats, at most FIND_WORDS_MAX. Empty means there is nothing to search for. */
export function findWords(query: string): string[] {
  return [...new Set(query.slice(0, FIND_QUERY_CHARS).toLowerCase().split(/\s+/).filter(word => word.length >= 2))].slice(0, FIND_WORDS_MAX);
}

/** The sessions a search reads, in tree order, and how many the list holds in all. Over FIND_SESSIONS_MAX, running sessions are read before ended ones (`pickSessions`). */
export function findSessions(list: LiveSessionsV1): { searched: { id: string; jobId: string | null; kind: string }[]; total: number } {
  const nodes = flatTree(list.tree.roots).map(entry => entry.node).filter(node => node.kind !== 'unknown-parent');
  return { searched: pickSessions(nodes, FIND_SESSIONS_MAX).kept.map(node => ({ id: node.id, jobId: node.jobId, kind: node.kind })), total: nodes.length };
}

/** A message cut to FIND_TEXT_CHARS around the first word found in it, on one line. */
function excerpt(message: SessionThreadMessage, words: readonly string[]): SessionFindHit {
  const flat = message.text.replace(/\s+/g, ' ').trim(), low = flat.toLowerCase();
  // A word found only in the label leaves the excerpt at the start of the text.
  const found = words.map(word => low.indexOf(word)).filter(at => at >= 0), first = found.length > 0 ? Math.min(...found) : 0;
  const from = flat.length <= FIND_TEXT_CHARS ? 0 : Math.max(0, Math.min(first - Math.floor(FIND_TEXT_CHARS / 3), flat.length - FIND_TEXT_CHARS));
  const cut = flat.slice(from, from + FIND_TEXT_CHARS), before = from > 0, after = from + FIND_TEXT_CHARS < flat.length;
  return { key: message.key, kind: message.kind, side: message.side, label: message.label, at: message.at,
    text: `${before ? '…' : ''}${cut.trim()}${after ? '…' : ''}`, truncated: before || after };
}

/** One session's result, or null when a word is nowhere in it. */
function resultOf(thread: SessionThreadV1, words: readonly string[]): SessionFindResult | null {
  const session = thread.session;
  if (!session) return null;
  const texts = thread.messages.map(message => `${message.label}\n${message.text}`.toLowerCase());
  const facts = [session.id, session.kind, session.lane, session.model, session.repo, session.parentId ?? '', ...thread.summary].join('\n').toLowerCase();
  if (!words.every(word => facts.includes(word) || texts.some(text => text.includes(word)))) return null;
  const holding = thread.messages.filter((_, at) => words.some(word => texts[at]!.includes(word)));
  return { session, summary: thread.summary, hits: holding.slice(-FIND_HITS_SHOWN).map(message => excerpt(message, words)), hitCount: holding.length, messageCount: thread.messages.length };
}

/**
 * Every session in `list` whose whole conversation holds `words`. An unreadable list gives no results and says so. The parts each
 * session's thread is given follow buildSessionThreads (session-threads.ts): no inbox for a helper, routing for the leader and a worker with a job.
 */
export function buildSessionFind(list: LiveSessionsV1, parts: SessionThreadsParts, words: readonly string[], now: number): SessionFindV1 {
  const base = { schema: SESSION_FIND_SCHEMA as SessionFindV1['schema'], generatedAt: new Date(now).toISOString(), words: [...words],
    filter: { lane: list.filter.lane, repo: list.filter.repo, live: list.live } };
  if (!parts.sessionsRead) {
    return { ...base, counts: { sessions: 0, searched: 0, found: 0 }, results: [], sources: { sessions: 'unavailable', bus: 'none', owner: 'none', orders: 'none' },
      gaps: ['Sessions unknown: the session list could not be read.'] };
  }
  const { searched, total } = findSessions(list);
  const results: SessionFindResult[] = [];
  let read = 0;
  for (const { id, jobId, kind } of searched) {
    const thread = sanitizePublicJson(buildSessionThread(list, id, { sessionsRead: true, bus: parts.bus,
      ...(jobId !== null && parts.activity.has(jobId) ? { activity: parts.activity.get(jobId) } : {}),
      ...(jobId !== null && parts.output?.has(jobId) ? { output: parts.output.get(jobId) } : {}),
      ...(jobId !== null && parts.controls !== undefined ? { controls: parts.controls } : {}),
      ...(kind !== 'subagent' && parts.owner !== undefined ? { owner: parts.owner } : {}),
      ...(kind === 'leader' && parts.replies !== undefined ? { replies: parts.replies } : {}),
      ...((kind === 'leader' || (kind === 'worker' && jobId !== null)) && parts.orders !== undefined ? { orders: parts.orders } : {}) }, now, 'full')) as SessionThreadV1;
    if (!thread.session) continue;
    read += 1;
    const result = words.length > 0 ? resultOf(thread, words) : null;
    if (result) results.push(result);
  }
  const gaps = sanitizePublicJson([...list.gaps]) as string[];
  if (words.length === 0) gaps.push('Nothing to search for: give at least one word of two characters or more.');
  if (total > searched.length) gaps.push(`${total - searched.length} more session${total - searched.length === 1 ? '' : 's'} not searched: a search reads ${FIND_SESSIONS_MAX}. Narrow it with a lane or repo, or ask for running ones only.`);
  const busDown = parts.bus === null || parts.bus.source === 'unavailable', ownerDown = parts.owner === null || parts.owner?.sourceState === 'degraded';
  const ordersDown = parts.orders === null || parts.orders?.sources.inbox === 'degraded';
  if (busDown) gaps.push('Bus messages not searched: the agent bus could not be read.');
  if (ownerDown) gaps.push('Messages from Mason not searched: the Leader inbox could not be read.');
  if (ordersDown) gaps.push('Routing not searched: the order trace could not be read.');
  if ([...parts.activity.values()].some(activity => activity === null)) gaps.push('Some sessions\' recorded steps not searched: their activity could not be read.');
  const source = (down: boolean, asked: boolean): SessionThreadSource => (down ? 'unavailable' : asked ? 'available' : 'none');
  return { ...base, counts: { sessions: total, searched: read, found: results.length }, results,
    sources: { sessions: 'available', bus: source(busDown, true), owner: source(ownerDown, parts.owner !== undefined), orders: source(ordersDown, parts.orders !== undefined) }, gaps };
}

const SIDE_MARK: Readonly<Record<SessionThreadMessage['side'], string>> = { session: '<', other: '>', record: '-' };

/** `phm sessions find` for people: a count line, then one block per session with the messages that hold a word. `>` is said to the session, `<` is the session, `-` is a recorded step. */
export function renderSessionFindText(read: SessionFindV1): string {
  if (read.sources.sessions === 'unavailable') return read.gaps.join('\n');
  const said = read.words.join(' ');
  const lines = [read.words.length === 0 ? 'Nothing searched.'
    : `${read.counts.found} of ${read.counts.searched} session${read.counts.searched === 1 ? '' : 's'} hold${read.counts.found === 1 ? 's' : ''} "${said}".`];
  for (const result of read.results) {
    const { session } = result;
    lines.push('', `${session.id} | ${session.kind} | ${session.state === 'unknown' ? 'state unknown' : session.state} | ${result.hitCount} of ${result.messageCount} messages`);
    if (result.hits.length === 0) lines.push(`  ${result.summary.join(' ')}`);
    if (result.hitCount > result.hits.length) lines.push(`  (${result.hitCount - result.hits.length} earlier)`);
    for (const hit of result.hits) lines.push(`  ${SIDE_MARK[hit.side]} ${hit.label}${hit.at ? ` [${hit.at}]` : ''}: ${hit.text}`);
  }
  if (read.gaps.length > 0) lines.push('');
  for (const gap of read.gaps) lines.push(`note: ${gap}`);
  lines.push('', `Open one: phm sessions thread <id> --all. Updated ${read.generatedAt}.`);
  return lines.join('\n');
}
