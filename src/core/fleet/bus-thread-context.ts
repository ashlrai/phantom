import { isProxy } from 'node:util/types';
import { BUS_INBOX_MAX_MESSAGES, BUS_INBOX_MAX_READ, listBusInboxAfter, type BusInboxOptions, type BusInboxReceipt } from './bus-inbox.js';

/** Select data correlations only; routing labels and message bodies confer no authority. */
export function projectBusThread(rows: readonly BusInboxReceipt[], id: string): BusInboxReceipt[] {
  if (!rows.some(row => row.envelope.id === id)) return [];
  const children = new Map<string, BusInboxReceipt[]>();
  for (const row of rows) {
    const body = row.envelope.body;
    if (!body || typeof body !== 'object' || isProxy(body) || Array.isArray(body)) continue;
    const proto = Object.getPrototypeOf(body);
    if (proto !== Object.prototype && proto !== null) continue;
    const property = Object.getOwnPropertyDescriptor(body, 'inReplyTo');
    if (!property?.enumerable || !('value' in property) || typeof property.value !== 'string') continue;
    const list = children.get(property.value) ?? [];
    list.push(row);
    children.set(property.value, list);
  }
  const selected = new Set([id]), pending = [id];
  for (let i = 0; i < pending.length; i++) {
    for (const row of children.get(pending[i]!) ?? []) {
      if (!selected.has(row.envelope.id)) {
        selected.add(row.envelope.id);
        pending.push(row.envelope.id);
      }
    }
  }
  const emitted = new Set<string>();
  return [...rows].sort((a, b) => a.cursor - b.cursor).filter(row => {
    const key = row.envelope.id;
    if (!selected.has(key) || emitted.has(key)) return false;
    emitted.add(key);
    return true;
  });
}

export interface BusThreadResult {
  schema: 'fleet.bus-thread.v1';
  requestedId: string;
  rootFound: boolean;
  messages: BusInboxReceipt[];
  scannedThrough: number;
  complete: boolean;
  sourceFailure: string | null;
}

/** Read bounded live pages and recheck TTL before projection. Pages are not an atomic snapshot. */
export function readBusThread(id: string, options: BusInboxOptions = {}, list = listBusInboxAfter): BusThreadResult {
  const rows: BusInboxReceipt[] = [];
  let cursor = 0, complete = false, failure: string | null = null;
  let now = 0, clockValid = false;
  try {
    now = (options.now ?? Date.now)();
    if (!Number.isSafeInteger(now) || now < 0) throw new Error('clock');
    clockValid = true;
    while (cursor < BUS_INBOX_MAX_MESSAGES) {
      const page = list(cursor, BUS_INBOX_MAX_READ, { ...options, now: () => now });
      if (page.status !== 'ok') { failure = page.status; break; }
      if (!Number.isSafeInteger(page.nextCursor) || page.nextCursor < cursor || page.nextCursor > BUS_INBOX_MAX_MESSAGES ||
        page.messages.length > BUS_INBOX_MAX_READ || page.messages.some((row, i) =>
          !Number.isSafeInteger(row.cursor) || row.cursor <= (i ? page.messages[i - 1]!.cursor : cursor) || row.cursor > page.nextCursor)) {
        failure = 'invalid-page'; break;
      }
      if (page.nextCursor === cursor && page.messages.length !== 0) { failure = 'invalid-page'; break; }
      rows.push(...page.messages);
      const advanced = page.nextCursor > cursor;
      cursor = page.nextCursor;
      if (page.messages.length < BUS_INBOX_MAX_READ || cursor === BUS_INBOX_MAX_MESSAGES) { complete = true; break; }
      if (!advanced) { failure = 'invalid-page'; break; }
    }
  } catch { failure = 'unavailable'; }
  let live: BusInboxReceipt[] = [];
  try {
    if (!clockValid) throw new Error('clock');
    const finishedAt = (options.now ?? Date.now)();
    if (!Number.isSafeInteger(finishedAt) || finishedAt < 0) throw new Error('clock');
    const elapsed = Math.max(0, finishedAt - now);
    live = rows.filter(row => row.envelope.ttl > elapsed).map(row => ({
      ...row, envelope: { ...row.envelope, ttl: row.envelope.ttl - elapsed },
    }));
  } catch { complete = false; failure = 'clock'; }
  const messages = projectBusThread(live, id);
  return { schema: 'fleet.bus-thread.v1', requestedId: id, rootFound: messages.length > 0,
    messages, scannedThrough: cursor, complete, sourceFailure: failure };
}
