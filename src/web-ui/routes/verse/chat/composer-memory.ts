/**
 * routes/verse/chat/composer-memory.ts — the composer's memory: drafts
 * and sent messages, per chat.
 *
 * Two things a long agentic day needs from a message box and does not get
 * from a bare `useState`:
 *
 *   1. A draft survives switching chats and reloading the app. Half-written
 *      instructions are expensive to re-type and are lost today the moment
 *      ⌘K lands somewhere else.
 *   2. What was already sent can be recalled with ↑, the way every shell
 *      works, because the second attempt at a prompt is usually the first
 *      one plus a clause.
 *
 * Both are per-session and stored in `localStorage`, bounded so a long-lived
 * browser cannot accumulate an unbounded map. Every access is wrapped: a
 * private window with storage blocked still runs the app.
 *
 * Split from composer-state.ts (which re-exports all of it) so the cost
 * estimator and context-math stay out of the chat first-paint critical JS.
 * Forgetting and clearing this memory live in composer-forget.ts and
 * composer-wipe.ts, which the Chat section (on delete) and auth-store (on
 * logout) use without loading this file.
 */

import { forgetComposerMemory, onComposerForget } from './composer-forget.js';
import { DRAFT_KEY, SENT_KEY, onComposerWipe, wipeComposerMemory } from './composer-wipe.js';

/** Sessions remembered, newest last. */
const SESSION_LIMIT = 40;
/** Messages recalled per session. */
const HISTORY_LIMIT = 25;
/** Matches VERSE_MAX_TURN_TEXT_BYTES; a draft over it cannot be sent anyway. */
const TEXT_LIMIT = 64 * 1024;

function readMap<T>(key: string, parse: (value: unknown) => T | null): Record<string, T> {
  const out: Record<string, T> = {};
  try {
    const raw = localStorage.getItem(key);
    const parsed = raw ? (JSON.parse(raw) as unknown) : null;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
        const clean = parse(value);
        if (clean !== null) out[id] = clean;
      }
    }
  } catch {
    /* storage unavailable or corrupt — an empty memory is a valid one */
  }
  return out;
}

/** True when the write landed; false when storage refused it (blocked, over quota). */
function writeMap(key: string, map: Record<string, unknown>): boolean {
  // Insertion order is recency order: every write deletes before re-inserting.
  const ids = Object.keys(map);
  for (const stale of ids.slice(0, Math.max(0, ids.length - SESSION_LIMIT))) delete map[stale];
  try {
    localStorage.setItem(key, JSON.stringify(map));
    return true;
  } catch {
    /* best-effort — the caller decides whether a refusal loses anything */
    return false;
  }
}

const asText = (value: unknown): string | null =>
  typeof value === 'string' && value.length > 0 ? value.slice(0, TEXT_LIMIT) : null;

const asHistory = (value: unknown): string[] | null => {
  if (!Array.isArray(value)) return null;
  const list = value.filter((v): v is string => typeof v === 'string' && v.length > 0)
    .slice(-HISTORY_LIMIT)
    .map((v) => v.slice(0, TEXT_LIMIT));
  return list.length > 0 ? list : null;
};

/**
 * Drafts whose last write storage REFUSED, held for the page's lifetime ('' =
 * a clear that could not be written) and consulted BEFORE storage.
 *
 * WHY: `localStorage` writes fail silently (blocked storage, a full quota),
 * and one draft is not a convenience but the only copy of something: the
 * handoff note. The dialog hands it over with `saveDraft` and the new chat's
 * Composer restores it with `loadDraft`; with storage refusing, the edited
 * note — possibly written after a paid summary turn — simply vanished. An
 * entry here is always newer than whatever storage holds for that chat, and a
 * later write that lands removes it, so storage is the answer again.
 */
const unsavedDrafts = new Map<string, string>();
onComposerWipe(() => unsavedDrafts.clear());
onComposerForget((sessionId) => unsavedDrafts.delete(sessionId));

/** The unsent draft for this chat, or `''`. */
export function loadDraft(sessionId: string | null | undefined): string {
  if (!sessionId) return '';
  const unsaved = unsavedDrafts.get(sessionId);
  if (unsaved !== undefined) return unsaved;
  return readMap(DRAFT_KEY, asText)[sessionId] ?? '';
}

/** Persist (or clear, when empty) the draft for this chat. */
export function saveDraft(sessionId: string | null | undefined, text: string): void {
  if (!sessionId) return;
  const clean = text.trim().length > 0 ? text.slice(0, TEXT_LIMIT) : '';
  const map = readMap(DRAFT_KEY, asText);
  delete map[sessionId];
  if (clean) map[sessionId] = clean;
  unsavedDrafts.delete(sessionId);
  if (!writeMap(DRAFT_KEY, map)) {
    unsavedDrafts.set(sessionId, clean);
    // Bounded like storage: oldest refusals go first.
    for (const stale of [...unsavedDrafts.keys()].slice(0, Math.max(0, unsavedDrafts.size - SESSION_LIMIT))) unsavedDrafts.delete(stale);
  }
}

/** Messages sent in this chat, oldest first. */
export function loadHistory(sessionId: string | null | undefined): string[] {
  if (!sessionId) return [];
  return readMap(SENT_KEY, asHistory)[sessionId] ?? [];
}

/** Record a sent message; consecutive duplicates are not stored twice. */
export function pushHistory(sessionId: string | null | undefined, text: string): void {
  if (!sessionId || text.trim().length === 0) return;
  const map = readMap(SENT_KEY, asHistory);
  const current = map[sessionId] ?? [];
  delete map[sessionId];
  const next = current[current.length - 1] === text ? current : [...current, text.slice(0, TEXT_LIMIT)];
  map[sessionId] = next.slice(-HISTORY_LIMIT);
  writeMap(SENT_KEY, map);
}

/**
 * Drop every remembered draft and sent message, for every session.
 *
 * Called on disconnect/logout alongside the query cache's `evictAll`, whose
 * contract is that stale data must not leak into the next session's first
 * paint. Prompt text is precisely the content that wipe exists for, and it is
 * the one thing that used to survive it.
 */
export const clearComposerMemory: () => void = wipeComposerMemory;
export { forgetComposerMemory };

export const VERSE_DRAFT_STORAGE_KEY = DRAFT_KEY;
export const VERSE_SENT_STORAGE_KEY = SENT_KEY;
