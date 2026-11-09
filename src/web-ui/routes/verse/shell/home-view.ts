/**
 * routes/verse/shell/home-view.ts — what the app opens on, and how it is laid out.
 *
 * Before this, a fresh profile opened the Home section (`live`) and the Leader
 * thread was a dock pane inside Chat: ⌘5, open the panel, pick Leader (three
 * steps). Now the Leader thread IS the landing view. The only thing that moves
 * it is an explicit pick of Feed in the compact strip, remembered here (the
 * Needs-you and Fleet taps navigate away; they are not a "home").
 *
 * Pure: no storage, no window. The store and hook are in home-view-store.ts.
 */

/** Below this window width the shell uses the narrow layout (thread fills the window, compact strip on top). */
export const HOME_COMPACT_BELOW = 720;

/** The views the landing surface can show. `live` is the old Home section, kept only if no pane is registered. */
export type HomeView = 'leader' | 'feed' | 'live';
export type HomeLayout = 'compact' | 'wide';

export interface HomeViewInput {
  /** The stored value, untrusted (a hand-edited or future blob must not break launch). */
  persisted: unknown;
  width: number;
  /** Is the `leader-thread` pane registered? */
  hasLeaderThread: boolean;
}

export function homeLayoutFor(width: number): HomeLayout {
  return width < HOME_COMPACT_BELOW ? 'compact' : 'wide';
}

export function resolveHomeView({ persisted, width, hasLeaderThread }: HomeViewInput): { view: HomeView; layout: HomeLayout } {
  const layout = homeLayoutFor(width);
  if (persisted === 'feed') return { view: 'feed', layout };
  return { view: hasLeaderThread ? 'leader' : 'live', layout };
}
