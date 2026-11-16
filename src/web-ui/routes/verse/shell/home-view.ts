/**
 * routes/verse/shell/home-view.ts — what the app opens on, and how it is laid out.
 *
 * Before this, a fresh profile opened the Home section (`live`) and the Leader
 * thread was a dock pane inside Chat: ⌘5, open the panel, pick Leader (three
 * steps). Now the Leader thread IS the landing view. The only thing that moves
 * it is an explicit pick in the compact strip, remembered here (the
 * Needs-you and Fleet taps navigate away; they are not a "home").
 *
 * Pure: no storage, no window. The store and hook are in home-view-store.ts.
 */

/** Below this window width the shell uses the narrow layout (thread fills the window, compact strip on top). */
export const HOME_COMPACT_BELOW = 720;

/** The views the landing surface can show. `live` is the old Home section, kept only if no pane is registered. */
export type HomeChoice = 'leader' | 'feed' | 'ideas' | 'goals' | 'library';
export type HomeView = HomeChoice | 'live';
export const HOME_PANE_IDS: Readonly<Record<HomeChoice, string>> = {
  leader: 'leader-thread', feed: 'feed', ideas: 'ideas', goals: 'goals', library: 'library',
};
export function isHomeChoice(value: unknown): value is HomeChoice {
  return typeof value === 'string' && Object.hasOwn(HOME_PANE_IDS, value);
}
export type HomeLayout = 'compact' | 'wide';

export interface HomeViewInput {
  /** The stored value, untrusted (a hand-edited or future blob must not break launch). */
  persisted: unknown;
  width: number;
  /** Is the `leader-thread` pane registered? */
  hasLeaderThread: boolean;
  registered?: (paneId: string) => boolean;
}

export function homeLayoutFor(width: number): HomeLayout {
  return width < HOME_COMPACT_BELOW ? 'compact' : 'wide';
}

export function resolveHomeView({ persisted, width, hasLeaderThread, registered = (id) => id === 'feed' }: HomeViewInput): { view: HomeView; layout: HomeLayout } {
  const layout = homeLayoutFor(width);
  if (isHomeChoice(persisted) && persisted !== 'leader' && registered(HOME_PANE_IDS[persisted])) return { view: persisted, layout };
  return { view: hasLeaderThread ? 'leader' : 'live', layout };
}
