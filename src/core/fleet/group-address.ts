/**
 * The group-address grammar, pure so every reader — including the web-ui's
 * conversation model — shares the one parse. A room and topic are separate
 * bounded namespace components, not paths; `group:<room>:<topic>` is a
 * routing convention over the local durable bus, not an identity boundary.
 * No bus, no Node imports.
 */
const NAME = /^[a-z0-9](?:[a-z0-9_-]{0,31})$/;

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
 * `phm agents bus work next --topic`, `phm comms bus next --topic`, the work
 * feed's `--topic` and `phm agents conversations --topic` apply.
 */
export function groupAddressTopicOf(to: string): string | null {
  if (!to.startsWith('group:')) return null;
  const sep = to.indexOf(':', 'group:'.length);
  if (sep < 0) return null;
  const room = to.slice('group:'.length, sep);
  const topic = to.slice(sep + 1);
  return NAME.test(room) && NAME.test(topic) ? topic : null;
}
