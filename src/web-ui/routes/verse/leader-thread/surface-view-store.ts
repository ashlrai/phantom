/** Only view metadata crosses a mount: never conversation or composer text. */
export const SURFACE_VIEW_KEY = 'phantom.leaderSurface.v1';
export interface SurfaceView { session: string | null; split: number }
const EMPTY: SurfaceView = { session: null, split: 44 };

export function parseSurfaceView(raw: string | null): SurfaceView {
  try {
    const value: unknown = JSON.parse(raw ?? 'null');
    if (!value || typeof value !== 'object' || Array.isArray(value)) return EMPTY;
    const { session, split } = value as Record<string, unknown>;
    return {
      // Match the Leader conversation door's session-id grammar.
      session: typeof session === 'string' && /^[\w.:@-]{1,160}$/.test(session) ? session : null,
      split: typeof split === 'number' && Number.isFinite(split) ? Math.min(64, Math.max(28, Math.round(split))) : 44,
    };
  } catch { return EMPTY; }
}

export function readSurfaceView(): SurfaceView {
  try { return parseSurfaceView(window.localStorage.getItem(SURFACE_VIEW_KEY)); } catch { return EMPTY; }
}

export function writeSurfaceView(patch: Partial<SurfaceView>): void {
  try {
    const view = { ...readSurfaceView(), ...patch };
    // Revalidate writes and pick only the two permitted fields.
    window.localStorage.setItem(SURFACE_VIEW_KEY, JSON.stringify(parseSurfaceView(JSON.stringify({ session: view.session, split: view.split }))));
  } catch { /* Denied storage leaves the mounted pane usable. */ }
}
