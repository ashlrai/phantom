/**
 * routes/verse/leader-thread/surface-view-store.ts: what the Leader pane keeps
 * about its side-by-side view across a reload: which session's conversation
 * was open beside the chat, and how much of the pane it was given. Only a
 * session id and a number are stored, never anything a session said.
 */
import { SPLIT_DEFAULT, SPLIT_MAX, SPLIT_MIN } from './surface-layout.js';

export const SURFACE_VIEW_KEY = 'phantom.leaderSurface.v1';
const MAX_ID = 200;

export interface SurfaceView {
  /** The session whose conversation was open, or null when none was. */
  session: string | null;
  /** The share of the pane the session's conversation takes, in percent. */
  split: number;
}

const NOTHING: SurfaceView = { session: null, split: SPLIT_DEFAULT };

/** A stored value read back; anything malformed falls to "nothing open, default split". */
export function parseSurfaceView(raw: string | null): SurfaceView {
  if (!raw) return NOTHING;
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return NOTHING; }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return NOTHING;
  const { session, split } = value as Record<string, unknown>;
  return {
    // A session id is one printable token; anything else is not an id this pane wrote.
    session: typeof session === 'string' && session.length > 0 && session.length <= MAX_ID && /^[\x21-\x7e]+$/.test(session) ? session : null,
    split: typeof split === 'number' && Number.isFinite(split) ? Math.min(SPLIT_MAX, Math.max(SPLIT_MIN, Math.round(split))) : SPLIT_DEFAULT,
  };
}

/** localStorage can be denied (private mode); the view then lasts only while the pane is mounted. */
export function readSurfaceView(): SurfaceView {
  try { return parseSurfaceView(window.localStorage.getItem(SURFACE_VIEW_KEY)); } catch { return NOTHING; }
}

export function writeSurfaceView(patch: Partial<SurfaceView>): void {
  try { window.localStorage.setItem(SURFACE_VIEW_KEY, JSON.stringify({ ...readSurfaceView(), ...patch })); } catch { /* Storage can be unavailable. */ }
}

/** For tests: the view outlives a mount. */
export function forgetSurfaceView(): void {
  try { window.localStorage.removeItem(SURFACE_VIEW_KEY); } catch { /* Storage can be unavailable. */ }
}
