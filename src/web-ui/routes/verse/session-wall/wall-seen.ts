/**
 * routes/verse/session-wall/wall-seen.ts: how many messages each conversation
 * held when Mason last had it open, or when the Conversations pane first saw
 * it. The difference from the newest read is the "N new" mark on a card and
 * on a row of the list beside an open conversation.
 *
 * Kept in this browser's storage (a count per session id, never a message),
 * so the mark means "since you last looked here", across a reload or a
 * restart of the app. When storage is denied (private mode) it lasts as long
 * as the window does. The count is the read's own `messageCount`; the read
 * keeps only the newest part of a long conversation, so a session whose total
 * has stopped growing shows no mark even while its lines change.
 */
interface Counted { session: { id: string }; messageCount: number }

export const WALL_SEEN_KEY = 'phantom.sessionWallSeen.v1';
/** Sessions remembered. Only a narrowed read lets the list grow past what one read holds; the oldest are dropped first. */
const MAX_SEEN = 300;

let seen: Map<string, number> | null = null;

function wallSeenStorage(): Storage | null {
  try { return window.localStorage; } catch { return null; }
}

/** The stored counts; anything that is not a whole, non-negative number is dropped, never trusted. */
export function parseWallSeen(raw: string | null | undefined): Map<string, number> {
  const out = new Map<string, number>();
  if (!raw) return out;
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return out;
    for (const [id, count] of Object.entries(value)) if (typeof count === 'number' && Number.isInteger(count) && count >= 0) out.set(id, count);
  } catch { /* an unreadable record is no record */ }
  return out;
}

function counts(): Map<string, number> {
  if (seen === null) {
    let raw: string | null = null;
    try { raw = wallSeenStorage()?.getItem(WALL_SEEN_KEY) ?? null; } catch { /* storage denied */ }
    seen = parseWallSeen(raw);
  }
  return seen;
}

function keep(all: Map<string, number>): void {
  for (const id of [...all.keys()].slice(0, Math.max(0, all.size - MAX_SEEN))) all.delete(id);
  try { wallSeenStorage()?.setItem(WALL_SEEN_KEY, JSON.stringify(Object.fromEntries(all))); } catch { /* it lasts while the window does */ }
}

/**
 * Records a first sight of each session, and everything in the open conversation as read. Sessions that left the read are forgotten,
 * unless `narrowed` says the read was asked for only some sessions: the others are still there, and keep their marks.
 */
export function noteWallSeen(entries: readonly Counted[], openId: string | null, narrowed = false): void {
  const all = counts();
  const present = new Set<string>();
  let changed = false;
  for (const { session: { id }, messageCount } of entries) {
    present.add(id);
    const before = all.get(id);
    // A total that shrank (old lines dropped off the read) becomes the new mark, so later growth still counts.
    if (before === undefined || messageCount < before || (id === openId && messageCount !== before)) { all.set(id, messageCount); changed = true; }
  }
  if (!narrowed) for (const id of [...all.keys()]) if (!present.has(id)) { all.delete(id); changed = true; }
  // The read is polled; storage is written only when a count moved.
  if (changed) keep(all);
}

/** Messages added since the session was last looked at. Zero for the open conversation and for one never seen before. */
export function unseenCount(entry: Counted, openId: string | null): number {
  const before = counts().get(entry.session.id);
  if (before === undefined || entry.session.id === openId) return 0;
  return Math.max(0, entry.messageCount - before);
}

/** How many of these conversations hold messages Mason has not looked at. */
export function unseenSessions(entries: readonly Counted[], openId: string | null): number {
  return entries.filter(entry => unseenCount(entry, openId) > 0).length;
}

/**
 * The next conversation with new messages: the first one after `fromId` in the list's order, going round to the top.
 * From the wall (`fromId` null) it is the first in the list. Null when nothing is new.
 */
export function nextUnseen(entries: readonly Counted[], fromId: string | null): string | null {
  const at = fromId === null ? -1 : entries.findIndex(entry => entry.session.id === fromId);
  for (let step = 1; step <= entries.length; step += 1) {
    const entry = entries[(at + step) % entries.length]!;
    if (unseenCount(entry, fromId) > 0) return entry.session.id;
  }
  return null;
}

/** Forgets every count, in this window and in storage. */
export function forgetWallSeen(): void {
  seen = new Map();
  try { wallSeenStorage()?.removeItem(WALL_SEEN_KEY); } catch { /* nothing was kept */ }
}

/** Drops what this window holds in memory, so the next question is answered from storage, as it is after a reload. */
export function reloadWallSeen(): void {
  seen = null;
}
