/**
 * routes/verse/session-wall/wall-requests-model.ts: the Conversations wall
 * read the other way round. Instead of "what is each session doing", it
 * answers "who is working on what Mason asked": the sessions on screen put
 * together under the message of Mason's each one serves.
 *
 * The tie is the read's own (`serves` on each fleet.session-threads.v1
 * entry): a job serves a message when its prompt cites it. Nothing is
 * inferred from timing or wording here. A helper stands with the worker it
 * helps. A session whose job cites no message is counted as "no message
 * cited", which is not the same as "nobody asked for it".
 */
import { STATE_WORD, WALL_STATES, type WallEntry, type WallServes, type WallState } from './session-wall-model.js';

/** The key of the "no message cited" group. A served message's key is an inbox id or a time, never this. */
export const UNTIED = '\u0000untied';

export interface WallRequest {
  key: string;
  /** The message's time as the inbox wrote it: Eastern wall time to the minute. */
  at: string;
  source: string | null;
  /** Mason's words; null when the read did not hold them. */
  text: string | null;
  truncated: boolean;
  /** Every job the Leader's routing ties to the message, on screen or not; null when the read did not say. */
  jobs: number | null;
  /** Sessions on screen under the message, helpers included, in wall order. */
  sessions: string[];
  /** How many of `sessions` are workers serving it themselves. */
  workers: number;
  states: Record<WallState, number>;
}

/** The message a session stands under: its own, or for a helper the one its worker serves. */
export function servedOf(entry: WallEntry, byId: ReadonlyMap<string, WallEntry>): WallServes | null {
  if (entry.serves) return entry.serves;
  const parent = entry.session.kind === 'subagent' && entry.session.parentId ? byId.get(entry.session.parentId) : undefined;
  return parent?.serves ?? null;
}

const index = (entries: readonly WallEntry[]) => new Map(entries.map(entry => [entry.session.id, entry]));

/**
 * The messages with sessions on screen, newest message first, and how many
 * sessions on screen stand under none. The leader is in neither: it routes
 * the messages, it does not serve one.
 */
export function wallRequests(entries: readonly WallEntry[]): { requests: WallRequest[]; untied: number } {
  const byId = index(entries), byKey = new Map<string, WallRequest>();
  let untied = 0;
  for (const entry of entries) {
    if (entry.session.kind === 'leader') continue;
    const serves = servedOf(entry, byId);
    if (!serves) { untied += 1; continue; }
    let request = byKey.get(serves.key);
    if (!request) {
      request = { ...serves, sessions: [], workers: 0, states: Object.fromEntries(WALL_STATES.map(state => [state, 0])) as Record<WallState, number> };
      byKey.set(serves.key, request);
    }
    request.sessions.push(entry.session.id);
    if (entry.serves) request.workers += 1;
    request.states[entry.session.state] += 1;
  }
  // The inbox writes every time in one fixed form, so the text order is the time order; equal times keep wall order.
  const requests = [...byKey.values()].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  return { requests, untied };
}

/**
 * The sessions on screen under one message (or under none, for UNTIED). A key
 * nothing on screen stands under gives everything back, so a message whose
 * last session has left never empties the wall.
 */
export function servedEntries(entries: readonly WallEntry[], key: string | null): readonly WallEntry[] {
  if (key === null) return entries;
  const byId = index(entries);
  const kept = entries.filter(entry => entry.session.kind !== 'leader'
    && (key === UNTIED ? servedOf(entry, byId) === null : servedOf(entry, byId)?.key === key));
  return kept.length > 0 ? kept : entries;
}

/** "11-20 14:02 ET": the inbox's own minute, without the year. Anything in another form is shown as it came. */
export function requestTime(at: string): string {
  const match = /^\d{4}-(\d{2}-\d{2} \d{2}:\d{2})(?: ET)?$/.exec(at);
  return match ? `${match[1]} ET` : at;
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;

/** "2 of 4 routed jobs on screen · 2 running, 1 done": what the screen holds of the message's routing, then the states. */
export function requestWords(request: WallRequest): string {
  const { jobs, workers, sessions, states } = request;
  const routed = jobs === null ? `${plural(workers, 'job')} on screen, routed jobs unknown`
    : jobs > workers ? `${workers} of ${plural(jobs, 'routed job')} on screen` : plural(jobs, 'routed job');
  const helpers = sessions.length - workers;
  const by = WALL_STATES.filter(state => states[state] > 0).map(state => `${states[state]} ${STATE_WORD[state]}`).join(', ');
  return [routed, helpers > 0 ? plural(helpers, 'helper') : '', by].filter(Boolean).join(' · ');
}

/** What a message's button is called: its time, where it came from, and its words when the read holds them. */
export function requestName(request: WallRequest): string {
  const from = request.source ? ` from ${request.source}` : '';
  return `the owner's message of ${requestTime(request.at)}${from}${request.text ? `: ${request.text}` : ''}`;
}
