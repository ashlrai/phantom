/**
 * routes/verse/chat/composer-wipe.ts — wipe the composer's memory on
 * disconnect/logout without loading it.
 *
 * auth-store runs on every app's first paint, the phone's included, while the
 * composer's memory (drafts, sent history) is only ever read by the chat. Both
 * halves of the wipe live here: the two storage keys, and a hook for the
 * composer's in-memory drafts that composer-memory.ts registers when (and only
 * if) it is loaded. Logout therefore costs the phone's first paint a few
 * lines, not the whole memory module.
 */

export const DRAFT_KEY = 'ashlr.verse.drafts.v1';
export const SENT_KEY = 'ashlr.verse.sent.v1';

const memoryWipes = new Set<() => void>();

/** Register in-memory state to drop on every wipe (composer-memory's unsaved drafts). */
export function onComposerWipe(wipe: () => void): void {
  memoryWipes.add(wipe);
}

/**
 * Drop every remembered draft and sent message, for every session: the
 * in-memory drafts of whatever is loaded, then both storage keys.
 */
export function wipeComposerMemory(): void {
  for (const wipe of memoryWipes) wipe();
  for (const key of [DRAFT_KEY, SENT_KEY]) {
    try {
      localStorage.removeItem(key);
    } catch {
      /* storage unavailable — nothing to clear */
    }
  }
}
