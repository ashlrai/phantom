/**
 * routes/verse/chat/composer-forget.ts — forget ONE chat's drafts and sent
 * messages without loading the composer's memory (composer-memory.ts).
 *
 * The Chat section calls this when a chat is deleted; keeping it (and the two
 * storage keys it shares with composer-wipe.ts) apart from the memory module
 * keeps the memory out of the chat's first-paint critical JS. composer-memory
 * registers its in-memory unsaved drafts here when (and only if) it is loaded.
 */
import { DRAFT_KEY, SENT_KEY } from './composer-wipe.js';

const memoryForgets = new Set<(sessionId: string) => void>();

/** Register in-memory state to drop when a chat is forgotten (composer-memory's unsaved drafts). */
export function onComposerForget(forget: (sessionId: string) => void): void {
  memoryForgets.add(forget);
}

/**
 * Forget everything one chat remembered — its unsent draft and its sent
 * messages.
 *
 * Deleting a chat removes its transcript from disk, but the verbatim prompts
 * stayed in browser storage under the dead session id until forty newer
 * sessions rotated them out.
 */
export function forgetComposerMemory(sessionId: string | null | undefined): void {
  if (!sessionId) return;
  for (const forget of memoryForgets) forget(sessionId);
  for (const key of [DRAFT_KEY, SENT_KEY]) {
    try {
      const raw = localStorage.getItem(key);
      const map: unknown = raw ? JSON.parse(raw) : null;
      if (!map || typeof map !== 'object' || Array.isArray(map) || !(sessionId in map)) continue;
      delete (map as Record<string, unknown>)[sessionId];
      localStorage.setItem(key, JSON.stringify(map));
    } catch {
      /* storage unavailable or corrupt — nothing to forget */
    }
  }
}
