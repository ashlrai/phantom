/**
 * The words in the wall's find box, looked for in every session's whole
 * conversation: GET /api/verse/fleet/control/session-find?q=, the
 * fleet.session-find.v1 document `phm sessions find <words> --json` prints
 * (core/fleet/session-find.ts). The box itself filters the cards from what is
 * already on screen (three messages a session); this read is how a word said
 * earlier, or in a session past the forty on screen, is found. Narrowing is
 * defensive, as for the wall's own read: a malformed result or hit is dropped
 * and a body of another schema is no read at all.
 */
import { ApiError, apiGet, readFailureReason } from '../../../data/client.js';
import type { QueryDef } from '../../../data/queries.js';
import { STATE_WORD, WALL_STATES, type WallScope, type WallState } from './session-wall-model.js';

export const SESSION_FIND_API = '/api/verse/fleet/control/session-find';
/** How long the box must rest before the server is asked, and how long an answer counts as current. */
export const FIND_REST_MS = 300, FIND_FRESH_MS = 10_000;
const MAX_RESULTS = 120, MAX_HITS = 12, MAX_TEXT = 600, MAX_LINE = 400;
/** Mirror of the read's own limits (core/fleet/session-find.ts, which is server code); the server re-checks. */
const QUERY_CHARS = 200, WORDS_MAX = 8;

export interface FoundHit { key: string; side: 'session' | 'other' | 'record'; label: string; at: string | null; text: string }
export interface FoundSession {
  id: string; kind: 'leader' | 'worker' | 'subagent'; lane: string; repo: string; state: WallState;
  summary: string;
  hits: FoundHit[];
  /** Messages holding a word, and messages in the conversation searched; null when the read did not say. */
  hitCount: number; messageCount: number | null;
}
export interface SessionFindRead {
  generatedAt: string;
  /** The words the server searched for; the ones marked in each line. */
  words: string[];
  /** Conversations read, and sessions in the list; null when the read did not say. */
  searched: number | null; sessions: number | null;
  results: FoundSession[];
  gaps: string[];
}

type Obj = Record<string, unknown>;
const object = (v: unknown): v is Obj => v !== null && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown, max = MAX_LINE): string | null => (typeof v === 'string' && v !== '' ? v.slice(0, max) : null);
const count = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);
const oneOf = <T extends string>(v: unknown, allowed: readonly T[], fallback: T): T => (allowed.includes(v as T) ? v as T : fallback);
const lines = (v: unknown): string[] => (Array.isArray(v) ? v.map(line => text(line)).filter((line): line is string => line !== null).slice(0, 20) : []);

function narrowHit(raw: unknown): FoundHit | null {
  if (!object(raw)) return null;
  const key = text(raw.key), body = text(raw.text, MAX_TEXT), at = text(raw.at);
  if (!key || body === null) return null;
  return { key, side: oneOf(raw.side, ['session', 'other', 'record'] as const, 'record'), label: text(raw.label) ?? 'Unlabelled', at: at && Number.isFinite(Date.parse(at)) ? at : null, text: body };
}

function narrowResult(raw: unknown): FoundSession | null {
  if (!object(raw) || !object(raw.session)) return null;
  const s = raw.session, id = text(s.id);
  if (!id) return null;
  const hits = (Array.isArray(raw.hits) ? raw.hits : []).slice(0, MAX_HITS).map(narrowHit).filter((hit): hit is FoundHit => hit !== null);
  return { id, kind: oneOf(s.kind, ['leader', 'worker', 'subagent'] as const, 'worker'), lane: text(s.lane) ?? 'unknown', repo: text(s.repo) ?? 'unknown',
    state: oneOf(s.state, WALL_STATES, 'unknown'), summary: lines(raw.summary).join(' '), hits,
    // A count below the lines shown would say fewer matched than are on screen.
    hitCount: Math.max(count(raw.hitCount) ?? 0, hits.length), messageCount: count(raw.messageCount) };
}

/** Null when this is not a session-find read. */
export function narrowSessionFind(raw: unknown): SessionFindRead | null {
  if (!object(raw) || raw.schema !== 'fleet.session-find.v1' || !Array.isArray(raw.results)) return null;
  const seen = new Set<string>(), at = text(raw.generatedAt), counts = object(raw.counts) ? raw.counts : {};
  const results = raw.results.slice(0, MAX_RESULTS).map(narrowResult)
    .filter((result): result is FoundSession => result !== null && !seen.has(result.id) && seen.add(result.id) !== undefined);
  return { generatedAt: at && Number.isFinite(Date.parse(at)) ? at : new Date(0).toISOString(), words: lines(raw.words).map(word => word.toLowerCase()),
    searched: count(counts.searched), sessions: count(counts.sessions), results, gaps: lines(raw.gaps) };
}

/** The query a find box's text makes, or null when it holds no word the server would search for. */
export function findQuery(find: string): string | null {
  const words = [...new Set(find.toLowerCase().split(/\s+/).filter(word => word.length >= 2))].slice(0, WORDS_MAX);
  // Words that do not fit are left off whole, so the server is never sent half of one.
  while (words.join(' ').length > QUERY_CHARS) words.pop();
  return words.length > 0 ? words.join(' ') : null;
}

/** One cache entry per query and scope. The scope is the wall's own, so the results and the cards answer the same narrowing. */
export function sessionFindQuery(query: string, scope: WallScope): QueryDef<SessionFindRead | null> {
  const params = new URLSearchParams({ q: query });
  if (scope.lane) params.set('lane', scope.lane);
  if (scope.repo) params.set('repo', scope.repo);
  if (scope.live) params.set('live', '1');
  const path = `${SESSION_FIND_API}?${params.toString()}`;
  return { key: `verse-fleet-session-find:${params.toString()}`, fetch: async signal => narrowSessionFind(await apiGet<unknown>(path, signal)) };
}

/** Why the whole conversations could not be searched. `unsupported`: the server has no such read, and the cards' own find still works. */
export function findFailure(error: unknown): { kind: 'unsupported' | 'unavailable'; text: string } {
  if (error instanceof ApiError && error.status === 404) {
    return { kind: 'unsupported', text: 'This Phantom server cannot search whole conversations yet. Update Phantom; until then the find box looks through the newest messages on each card.' };
  }
  if (error instanceof ApiError && error.status === 503) return { kind: 'unavailable', text: 'Whole conversations could not be searched: the session list could not be read just now.' };
  return { kind: 'unavailable', text: `Whole conversations could not be searched. ${readFailureReason(error)}` };
}

/** A line split where a word was found, so each find can be marked. Case is ignored; the longest word wins where two overlap. */
export function markParts(line: string, words: readonly string[]): { text: string; hit: boolean }[] {
  const wanted = [...words].filter(Boolean).sort((a, b) => b.length - a.length), low = line.toLowerCase();
  const parts: { text: string; hit: boolean }[] = [];
  let from = 0, at = 0;
  while (at < line.length) {
    const word = wanted.find(candidate => low.startsWith(candidate, at));
    if (!word) { at += 1; continue; }
    if (at > from) parts.push({ text: line.slice(from, at), hit: false });
    parts.push({ text: line.slice(at, at + word.length), hit: true });
    from = at += word.length;
  }
  if (from < line.length) parts.push({ text: line.slice(from), hit: false });
  return parts;
}

/** The line above the results: how many sessions hold the words, of how many conversations read. */
export function foundHeadline(read: SessionFindRead): string {
  const said = `“${read.words.join(' ')}”`, of = read.searched === null ? '' : ` of ${read.searched} searched`;
  if (read.results.length === 0) return `No whole conversation holds ${said}${read.searched === null ? '' : `: ${read.searched} searched`}`;
  return `${read.results.length}${of} session${(read.searched ?? read.results.length) === 1 ? '' : 's'} hold${read.results.length === 1 ? 's' : ''} ${said} somewhere in the whole conversation`;
}

/** What a result says of itself: its state, and how much of its conversation holds a word. */
export function foundMeta(result: FoundSession): string {
  const lines = result.hitCount === 0 ? 'in its facts or summary' : `${result.hitCount}${result.messageCount === null ? '' : ` of ${result.messageCount}`} message${(result.messageCount ?? result.hitCount) === 1 ? '' : 's'}`;
  return `${STATE_WORD[result.state]} · ${lines}`;
}
