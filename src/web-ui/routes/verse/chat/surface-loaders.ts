/**
 * routes/verse/chat/surface-loaders.ts — where the chat's two big columns,
 * the workspace and the chat list, are imported from.
 *
 * Each import() carries the preload list of its chunk's whole closure (every
 * script and style it needs, so the browser fetches them in parallel rather
 * than discovering them one hop at a time): ~3 KB of names that sat in the
 * Chat section's chunk, i.e. in the chat first-paint critical JS. Here they
 * cost nothing on that path. app/verse-first-paint.ts imports this module
 * the moment the shell evaluates and calls `warmChatSurface`, so both columns
 * start downloading in parallel with the Chat section's own chunk — earlier
 * than when the section's chunk had to arrive and evaluate first. The section
 * reaches the same loaders (the module is cached by then) when it declares
 * its preloaded columns.
 */
import type { Sidebar } from '../Sidebar.js';
import type { Workspace } from '../Workspace.js';

export const loadWorkspace = (): Promise<typeof Workspace> => import('../Workspace.js').then((m) => m.Workspace);
export const loadSidebar = (): Promise<typeof Sidebar> => import('../Sidebar.js').then((m) => m.Sidebar);

/** Start both downloads; failures are the section's to report when it mounts them. */
export function warmChatSurface(): void {
  void loadWorkspace().catch(() => undefined);
  void loadSidebar().catch(() => undefined);
}
