/**
 * routes/verse/fleet-sessions/thread-read-store.ts: which messages of a
 * session conversation Mason has already read to the end, kept in this
 * browser's storage so that opening the conversation again (after a reload,
 * or the next morning) can put the "New" rule above the first message that
 * arrived since.
 *
 * No message is kept, only a short fingerprint of each (its kind, time and
 * text hashed to a number), so nothing a session said can be read back out of
 * storage. The fingerprint leaves the message key out on purpose: some keys
 * are positions (`reply:0`, `latest`) that a later read gives to a different
 * message. A conversation that was never read to its end has no record, and
 * nothing in it is called new. When storage is denied (private mode) the
 * record lasts as long as the window does.
 */
export const THREAD_READ_KEY = 'phantom.sessionThreadRead.v1';
/** Conversations remembered; the ones read longest ago are dropped first. */
const MAX_SESSIONS = 40;
/** Fingerprints kept per conversation, newest last. A read holds far fewer messages than this. */
const MAX_MARKS = 400;

interface ReadMessage { key: string; kind: string; at: string | null; text: string }
interface ReadRecord { at: number; marks: readonly string[] }

let records: Map<string, ReadRecord> | null = null;

function threadReadStorage(): Storage | null {
  try { return window.localStorage; } catch { return null; }
}

/** FNV-1a over the message's kind, time and text: enough to tell two messages of one conversation apart. */
export function messageMark(message: Omit<ReadMessage, 'key'>): string {
  const source = `${message.kind}\n${message.at ?? ''}\n${message.text}`;
  let hash = 0x811c9dc5;
  for (let index = 0; index < source.length; index += 1) hash = Math.imul(hash ^ source.charCodeAt(index), 0x01000193);
  return (hash >>> 0).toString(36);
}

/** The stored records; anything unreadable or misshapen is dropped, never trusted. */
export function parseThreadRead(raw: string | null | undefined): Map<string, ReadRecord> {
  const out = new Map<string, ReadRecord>();
  if (!raw) return out;
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return out;
    for (const [id, record] of Object.entries(value)) {
      if (typeof record !== 'object' || record === null) continue;
      const { at, marks } = record as { at?: unknown; marks?: unknown };
      if (typeof at !== 'number' || !Number.isFinite(at) || !Array.isArray(marks)) continue;
      out.set(id, { at, marks: marks.filter((mark): mark is string => typeof mark === 'string').slice(-MAX_MARKS) });
    }
  } catch { /* an unreadable record is no record */ }
  return out;
}

function load(): Map<string, ReadRecord> {
  if (records === null) {
    let raw: string | null = null;
    try { raw = threadReadStorage()?.getItem(THREAD_READ_KEY) ?? null; } catch { /* storage denied */ }
    records = parseThreadRead(raw);
  }
  return records;
}

/**
 * The keys of the messages that arrived since the conversation was last read to its end, in the order given.
 * Empty when it was never read to its end here: a first opening marks nothing as new.
 */
export function unreadSince(id: string, messages: readonly ReadMessage[]): string[] {
  const record = load().get(id);
  if (!record) return [];
  const read = new Set(record.marks);
  return messages.filter(message => !read.has(messageMark(message))).map(message => message.key);
}

/** Records every message given as read. False when it could not be written to storage, so it lasts only while the window does. */
export function noteThreadRead(id: string, messages: readonly ReadMessage[], now: number = Date.now()): boolean {
  const all = load();
  const marks = messages.map(messageMark).slice(-MAX_MARKS);
  const before = all.get(id);
  // The read is polled; an unchanged conversation is not written again.
  if (before && before.marks.length === marks.length && before.marks.every((mark, index) => mark === marks[index])) return true;
  all.delete(id);
  all.set(id, { at: now, marks });
  const oldestFirst = [...all.entries()].sort((a, b) => a[1].at - b[1].at);
  for (const [stale] of oldestFirst.slice(0, Math.max(0, oldestFirst.length - MAX_SESSIONS))) all.delete(stale);
  const storage = threadReadStorage();
  if (!storage) return false;
  try {
    storage.setItem(THREAD_READ_KEY, JSON.stringify(Object.fromEntries(all)));
    return true;
  } catch {
    return false;
  }
}

/** Forgets every record, in this window and in storage. */
export function forgetThreadRead(): void {
  records = new Map();
  try { threadReadStorage()?.removeItem(THREAD_READ_KEY); } catch { /* nothing was kept */ }
}

/** Drops what this window holds in memory, so the next question is answered from storage, as it is after a reload. */
export function reloadThreadRead(): void {
  records = null;
}
