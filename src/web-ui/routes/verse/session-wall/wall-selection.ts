/**
 * routes/verse/session-wall/wall-selection.ts: the one session another
 * surface asks the Conversations pane to open (a routed job in the Leader
 * chat). The pane takes it on mount and whenever it changes; taking clears
 * it, so a request opens one conversation once and never reopens it after
 * Mason goes back to the wall.
 */
let pending: string | null = null;
const listeners = new Set<() => void>();

/** Session ids are job ids, `leader`, or helper ids: one short token, never free text. */
const SESSION_ID_RE = /^[\w.:@-]{1,160}$/;

export function requestWallSession(id: string): void {
  if (!SESSION_ID_RE.test(id)) return;
  pending = id;
  for (const listener of [...listeners]) listener();
}

/** The waiting session id, cleared; null when none. */
export function takeRequestedWallSession(): string | null {
  const id = pending;
  pending = null;
  return id;
}

export function subscribeWallSelection(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
