/**
 * app/verse-first-paint.ts — how long the signed-in Phantom shell waits before
 * it mounts (VerseConsoleApp). Its own chunk, loaded alongside first paint.
 *
 * WHY: React holds every Suspense reveal for 300 ms after a fallback
 * commits. Mounting the shell while its section or the chat's columns were
 * still downloading put skeletons up, and the chat list then could not draw
 * until that throttle ran out, ~300 ms after its data had arrived (3.29.16
 * measurements: 40 chats, a 300-turn session). These chunks download in
 * parallel with the read-session probe, so waiting for them costs a warm
 * server nothing and removes the throttled frame. The wait is bounded: past
 * FIRST_PAINT_WAIT_MS the shell mounts anyway and the skeletons cover the rest.
 */
import { loadSection, SECTION_MODULES } from '../routes/verse/VerseApp.js';
import { getVerseUiState, VERSE_SECTIONS } from '../routes/verse/verse-ui-store.js';

export const FIRST_PAINT_WAIT_MS = 800;

/** Resolves once the opening section (and, for Chat, its list and workspace) is in, or after the bound. Never rejects. */
export async function firstPaintSurface(waitMs: number = FIRST_PAINT_WAIT_MS): Promise<void> {
  const section = VERSE_SECTIONS.find((s) => s.id === getVerseUiState().section);
  if (!section) return;
  const importer = SECTION_MODULES[`./sections/${section.module}.tsx`];
  const work = Promise.all([
    // Registers the section as loaded, so the shell mounts it without suspending.
    loadSection(section.id),
    importer?.().then((mod) => (mod as { preloadChatSurface?: () => Promise<unknown> }).preloadChatSurface?.()),
  ]).catch(() => undefined);
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([work, new Promise<void>((resolve) => { timer = setTimeout(resolve, waitMs); })]);
  clearTimeout(timer);
}
