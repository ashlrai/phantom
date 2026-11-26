/** Group rooms are a convention over the local durable bus, not an identity boundary. */
import { appendBusInbox, listBusInboxAfter, type BusInboxOptions } from './bus-inbox.js';
import type { BusJsonValue, BusPriority } from './bus-envelope.js';
import { GROUP_PRESENCE_TTL_MS, groupAddress, groupMemberLabel } from './bus-group-address.js';

// The pure address grammar lives in bus-group-address.ts so projections that
// never touch the bus store (the web UI, the pure conversation model) share
// the same wire rule; re-exported here so every existing importer keeps one
// import site.
export { GROUP_PRESENCE_TTL_MS, groupAddress, groupAddressTopicOf, isGroupPresenceBody } from './bus-group-address.js';

export function publishGroupMessage(input: {
  room: string; topic: string; id: string; from: string; body: BusJsonValue;
  ttl: number; priority?: BusPriority;
}, options: BusInboxOptions = {}) {
  let to: string;
  try { to = groupAddress(input.room, input.topic); } catch { return { status: 'invalid' as const }; }
  return appendBusInbox({ id: input.id, from: input.from, to, priority: input.priority ?? 'P2', ttl: input.ttl,
    body: { kind: 'group.message', value: input.body } }, options);
}

/** Presence is an expiring observation, never proof of identity or authorization. */
export function publishGroupPresence(input: {
  room: string; topic: string; id: string; member: string; state: 'online' | 'offline';
}, options: BusInboxOptions = {}) {
  let to: string;
  try { to = groupAddress(input.room, input.topic); } catch { return { status: 'invalid' as const }; }
  if (!groupMemberLabel(input.member) || !['online', 'offline'].includes(input.state)) return { status: 'invalid' as const };
  return appendBusInbox({ id: input.id, from: input.member, to, priority: 'P3', ttl: GROUP_PRESENCE_TTL_MS,
    body: { kind: 'group.presence', state: input.state } }, options);
}

/** One page of a subscription. Advance using nextCursor even when no rows match. */
export function subscribeGroup(room: string, topic: string, after: number, limit: number, options: BusInboxOptions = {}) {
  let address: string;
  try { address = groupAddress(room, topic); } catch { return { status: 'invalid' as const }; }
  const page = listBusInboxAfter(after, limit, options);
  if (page.status !== 'ok') return page;
  return { ...page, messages: page.messages.filter(row => row.envelope.to === address) };
}

/** Fold all live presence observations in cursor order; callers must handle failures. */
export function groupPresence(room: string, topic: string, options: BusInboxOptions = {}) {
  const members = new Map<string, { member: string; state: 'online' | 'offline'; receivedAt: number }>();
  let cursor = 0;
  for (;;) {
    const page = subscribeGroup(room, topic, cursor, 100, options);
    if (page.status !== 'ok') return { status: page.status };
    for (const row of page.messages) {
      const body = row.envelope.body;
      if (body && typeof body === 'object' && !Array.isArray(body) && body.kind === 'group.presence' &&
          (body.state === 'online' || body.state === 'offline') && row.envelope.ttl <= GROUP_PRESENCE_TTL_MS && groupMemberLabel(row.envelope.from)) {
        members.set(row.envelope.from, { member: row.envelope.from, state: body.state, receivedAt: row.receivedAt });
      }
    }
    if (page.nextCursor === cursor) break;
    cursor = page.nextCursor;
  }
  return { status: 'ok' as const, members: [...members.values()].filter(member => member.state === 'online') };
}
