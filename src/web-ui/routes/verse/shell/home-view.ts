/**
 * routes/verse/shell/home-view.ts — what the app opens on, and how it is laid out.
 *
 * The app lands on Home: the `phm home` summary as one column of cards, each
 * opening its detailed view. An explicit pick of Feed, Ideas, Goals or Library
 * is remembered and becomes the landing view; Leader is one tap from Home and
 * lasts for the session (a reply notification opens it too, so it is not a
 * landing choice). Needs-you and Fleet navigate away; they are not a "home".
 *
 * Pure: no storage, no window. The store and hook are in home-view-store.ts.
 */

/** Below this window width the shell uses the narrow layout (thread fills the window, compact strip on top). */
export const HOME_COMPACT_BELOW = 720;

/** The views the landing surface can show. `live` is the old Home section, kept only if no pane is registered. */
export type HomeChoice = 'home' | 'leader' | 'feed' | 'ideas' | 'goals' | 'library';
export type HomeView = HomeChoice | 'live';
export const HOME_PANE_IDS: Readonly<Record<HomeChoice, string>> = {
  home: 'home', leader: 'leader-thread', feed: 'feed', ideas: 'ideas', goals: 'goals', library: 'library',
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
  /** Is the `home` pane registered? Without it the Leader thread is the landing view, as before. */
  hasHome?: boolean;
}

export function homeLayoutFor(width: number): HomeLayout {
  return width < HOME_COMPACT_BELOW ? 'compact' : 'wide';
}

export function resolveHomeView({ persisted, width, hasLeaderThread, registered = (id) => id === 'feed', hasHome = false }: HomeViewInput): { view: HomeView; layout: HomeLayout } {
  const layout = homeLayoutFor(width);
  if (isHomeChoice(persisted) && persisted !== 'home' && (persisted === 'leader' ? hasHome && hasLeaderThread : registered(HOME_PANE_IDS[persisted]))) return { view: persisted, layout };
  return { view: hasHome ? 'home' : hasLeaderThread ? 'leader' : 'live', layout };
}
