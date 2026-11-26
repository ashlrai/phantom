/**
 * Group room and topic labels: the pure address grammar every bus read
 * shares. No bus store, no Node imports — the web UI and the pure
 * conversation model read the same wire rule the transport writes, so a
 * `group:<room>:<topic>` label parses identically in every projection.
 */

/** A room and topic are separate bounded namespace components, not paths. */
const NAME = /^[a-z0-9](?:[a-z0-9_-]{0,31})$/;
const MEMBER = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
export const GROUP_PRESENCE_TTL_MS = 5 * 60_000;

export function groupAddress(room: string, topic: string): string {
  if (!NAME.test(room) || !NAME.test(topic)) throw new Error('Invalid room or topic');
  return `group:${room}:${topic}`;
}

/**
 * The topic component of a well-formed `group:<room>:<topic>` routing label —
 * the two-component grammar `groupAddress` writes, room and topic each under
 * the room rule — or null for any other label. Envelope `to` values carry raw
 * routing labels, so this parse is what the `--topic` read filters match on:
 * a bare `group:<room>`, a deeper label, an agent address and a malformed room
 * or topic all resolve to null and never match. The same rule
 * `phm agents bus work next --topic`, `phm comms bus next --topic`,
 * `phm agents messages --topic` and `phm agents conversations --topic` apply.
 */
export function groupAddressTopicOf(to: string): string | null {
  if (!to.startsWith('group:')) return null;
  const sep = to.indexOf(':', 'group:'.length);
  if (sep < 0) return null;
  const room = to.slice('group:'.length, sep);
  const topic = to.slice(sep + 1);
  return NAME.test(room) && NAME.test(topic) ? topic : null;
}

/**
 * A `group.presence` body is an observation with its own read (`groupPresence`),
 * never mail or a work-board request: the curated agent-facing projections
 * (inbox, conversations, messages-on-map, fleet edges, work board) exclude it
 * while the raw retained reads — `subscribeGroup`, `comms bus group read`,
 * `bus show`, `phm messages` — keep it.
 */
export function isGroupPresenceBody(body: unknown): boolean {
  return body !== null && typeof body === 'object' && !Array.isArray(body) &&
    (body as Record<string, unknown>).kind === 'group.presence';
}

/** Presence member labels take the same bounded printable grammar every bus address carries. */
export function groupMemberLabel(member: string): boolean {
  return MEMBER.test(member);
}
