/**
 * The Conversations panel's read and the map's thread lines. The read is
 * GET /api/verse/fleet/control/agent-conversations, the same agents.conversations.v1
 * `phm agents conversations --json` prints; everything here is pure.
 */
import { CONVERSATION_LINE_WINDOW_MS, CONVERSATION_STATES, CONVERSATION_STATE_WORDS, UNKNOWN_AGENT, plainAge,
  type Conversation, type ConversationAgent, type ConversationState } from '../../../../core/fleet/agent-conversation-model.js';
import { scrubSecrets } from '../../../../core/util/scrub.js';
import { apiGet } from '../../../data/client.js';
import type { QueryDef } from '../../../data/queries.js';

export { plainAge };
export const AGENT_CONVERSATIONS_API = '/api/verse/fleet/control/agent-conversations';
const MAX_THREADS = 200, MAX_ITEMS = 100, MAX_TEXT = 160;

type Obj = Record<string, unknown>;
const object = (v: unknown): v is Obj => v !== null && typeof v === 'object' && !Array.isArray(v);
/** Every word shown passes the shared secret scrub again, the one the rest of the app uses. */
const text = (v: unknown): string | null => typeof v === 'string' && v !== '' ? scrubSecrets(v.slice(0, MAX_TEXT)) : null;
const time = (v: unknown): string | null => { const t = text(v); return t && Number.isFinite(Date.parse(t)) ? t : null; };

/** Malformed threads and messages are dropped; nothing is invented. Null when the read is something else or the bus is unknown. */
export function narrowConversations(raw: unknown): Conversation[] | null {
  if (!object(raw) || raw.schema !== 'agents.conversations.v1' || raw.version !== 1 || !Array.isArray(raw.conversations)) return null;
  return raw.conversations.slice(0, MAX_THREADS).flatMap((row): Conversation[] => {
    if (!object(row) || !Array.isArray(row.participants) || !Array.isArray(row.messages)) return [];
    const id = text(row.id), lastAt = time(row.lastAt), state = CONVERSATION_STATES.find(s => s === row.state);
    if (!id || !lastAt || !state) return [];
    const participants = row.participants.flatMap((p): ConversationAgent[] => object(p) && text(p.name)
      ? [{ name: text(p.name)!, known: p.known === true, label: p.known === true ? text(p.name)! : UNKNOWN_AGENT, node: text(p.node) }] : []);
    const messages = row.messages.slice(0, MAX_ITEMS).flatMap(m => object(m) && text(m.id) && time(m.at) && text(m.from) && text(m.to)
      ? [{ id: text(m.id)!, at: time(m.at)!, from: text(m.from)!, to: text(m.to)!, kind: (text(m.kind) ?? 'status') as Conversation['messages'][number]['kind'], subject: text(m.subject) ?? 'unknown' }] : []);
    const w = object(row.waiting) ? row.waiting : null;
    const waiting = state === 'waiting' && w && text(w.on) && time(w.since) && typeof w.ms === 'number' && w.ms >= 0 ? { on: text(w.on)!, since: time(w.since)!, ms: w.ms } : null;
    const links = Array.isArray(row.links) ? row.links.flatMap(l => object(l) && text(l.a) && text(l.b) && time(l.lastAt) && typeof l.count === 'number'
      ? [{ a: text(l.a)!, b: text(l.b)!, count: l.count, lastAt: time(l.lastAt)! }] : []) : [];
    const jobs = Array.isArray(row.jobs) ? row.jobs.flatMap(j => { const t = text(j); return t === null ? [] : [t]; }) : [];
    return [{ id, participants, subject: text(row.subject) ?? 'unknown', messageCount: typeof row.messageCount === 'number' ? row.messageCount : messages.length,
      lastAt, state, stateText: CONVERSATION_STATE_WORDS[state], waiting, jobs, links, messages }];
  });
}
export const conversationsQuery: QueryDef<Conversation[] | null> = {
  key: 'verse-fleet-agent-conversations',
  fetch: async signal => narrowConversations(await apiGet<unknown>(AGENT_CONVERSATIONS_API, signal)),
};

/** A map line from thread talk: two map nodes, how many messages in the last 10 minutes, and whether one waits for a reply. */
export interface ThreadLine { key: string; a: string; b: string; count: number; waiting: boolean; threadId: string }

/**
 * Pairs of drawn agents that exchanged a message in the last 10 minutes. `threadId` is the newest thread on the line,
 * so a click opens it. Agents the map does not draw have no line; their threads still list in the panel.
 */
export function threadLines(conversations: readonly Conversation[] | null, now: number, drawn: ReadonlySet<string>): ThreadLine[] {
  const lines = new Map<string, ThreadLine & { at: number }>();
  for (const c of conversations ?? []) {
    const node = (name: string) => c.participants.find(p => p.name === name)?.node ?? null;
    const last = c.messages[c.messages.length - 1];
    for (const link of c.links) {
      const at = Date.parse(link.lastAt), a = node(link.a), b = node(link.b);
      if (!a || !b || a === b || !drawn.has(a) || !drawn.has(b) || now - at > CONVERSATION_LINE_WINDOW_MS || at > now + 60_000) continue;
      const key = [a, b].sort().join('|'), line = lines.get(key);
      const waits = !!c.waiting && !!last && [last.from, last.to].sort().join('|') === [link.a, link.b].sort().join('|');
      if (!line) lines.set(key, { key, a, b, count: link.count, waiting: waits, threadId: c.id, at });
      else { line.count += link.count; line.waiting ||= waits; if (at > line.at) { line.at = at; line.threadId = c.id; } }
    }
  }
  return [...lines.values()].map(({ at: _at, ...line }) => line);
}

export type { Conversation, ConversationState };
