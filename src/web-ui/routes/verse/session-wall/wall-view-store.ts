/**
 * routes/verse/session-wall/wall-view-store.ts: where Mason left the
 * Conversations pane, kept in this browser's storage so a reload or a restart
 * of the app opens it the way it was: the words in the find box, and the lane,
 * repo and "Running only" the read was narrowed to.
 *
 * Only the view is kept, never a session's messages. A stored lane or repo is
 * believed only when it is a name the route accepts as a filter; anything else
 * reads as "not narrowed". When storage is denied (private mode) the view
 * lasts as long as the pane does.
 */
import { isScoped, NO_SCOPE, scopeName, type WallScope } from './session-wall-model.js';

export const WALL_VIEW_KEY = 'phantom.sessionWallView.v1';
/** Longer than anything typed to find a session; a stored value past it is cut, not trusted. */
const MAX_FIND = 200;

export interface WallViewState { find: string; scope: WallScope }

const EVERYTHING: WallViewState = { find: '', scope: NO_SCOPE };

function wallStorage(): Storage | null {
  try { return window.localStorage; } catch { return null; }
}

/** One stored record; anything unreadable is the unnarrowed wall. */
export function parseWallView(raw: string | null | undefined): WallViewState {
  if (!raw) return EVERYTHING;
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== 'object' || value === null) return EVERYTHING;
    const { find, scope } = value as { find?: unknown; scope?: unknown };
    const s = typeof scope === 'object' && scope !== null ? scope as Record<string, unknown> : {};
    const kept: WallScope = { lane: scopeName(s.lane), repo: scopeName(s.repo), live: s.live === true };
    return { find: typeof find === 'string' ? find.slice(0, MAX_FIND) : '', scope: isScoped(kept) ? kept : NO_SCOPE };
  } catch {
    return EVERYTHING;
  }
}

export function loadWallView(storage: Storage | null = wallStorage()): WallViewState {
  try { return parseWallView(storage?.getItem(WALL_VIEW_KEY)); } catch { return EVERYTHING; }
}

/** Keeps a narrowed view and forgets an unnarrowed one. False when it could not be written, so it lasts only while the pane is open. */
export function saveWallView(view: WallViewState, storage: Storage | null = wallStorage()): boolean {
  if (!storage) return false;
  try {
    if (view.find.trim() === '' && !isScoped(view.scope)) storage.removeItem(WALL_VIEW_KEY);
    else storage.setItem(WALL_VIEW_KEY, JSON.stringify({ find: view.find.slice(0, MAX_FIND), scope: view.scope }));
    return true;
  } catch {
    return false;
  }
}

export function forgetWallView(storage: Storage | null = wallStorage()): void {
  try { storage?.removeItem(WALL_VIEW_KEY); } catch { /* nothing was kept */ }
}
