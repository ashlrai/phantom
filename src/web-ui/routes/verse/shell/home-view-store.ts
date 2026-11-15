/**
 * routes/verse/shell/home-view-store.ts — the operator's explicit home choice
 * (Leader, Feed, Ideas, Goals or Library) and the window layout, bound for the shell.
 *
 * Same shape as data/appearance-store.ts: a module-level value + listener set,
 * best-effort localStorage (Safari private mode throws), nothing stored until
 * the operator actually chooses, so a fresh profile follows the default.
 */
import { useMemo, useSyncExternalStore } from 'react';
import { getPane, subscribePanes } from '../panes/pane-registry.js';
import { HOME_COMPACT_BELOW, HOME_PANE_IDS, isHomeChoice, resolveHomeView, type HomeChoice, type HomeLayout, type HomeView } from './home-view.js';

export const HOME_VIEW_STORAGE_KEY = 'ashlr.verse.home.v1';

let choice: HomeChoice | null | undefined;
const listeners = new Set<() => void>();

function readChoice(): HomeChoice | null {
  if (choice !== undefined) return choice;
  try {
    const raw = localStorage.getItem(HOME_VIEW_STORAGE_KEY);
    choice = isHomeChoice(raw) ? raw : null;
  } catch {
    choice = null;
  }
  return choice;
}

/** Remember an explicit home pick. */
export function setHomeChoice(next: HomeChoice): void {
  choice = next;
  try {
    localStorage.setItem(HOME_VIEW_STORAGE_KEY, next);
  } catch {
    /* best-effort */
  }
  for (const listener of listeners) listener();
}

/** Tests: forget the in-memory value so the next read hits storage again. */
export function resetHomeChoice(): void {
  choice = undefined;
  for (const listener of listeners) listener();
}

const NARROW_QUERY = `(max-width: ${HOME_COMPACT_BELOW - 0.02}px)`;

function currentNarrow(): boolean {
  if (typeof window === 'undefined') return false;
  if (typeof window.matchMedia === 'function') return window.matchMedia(NARROW_QUERY).matches;
  return (window.innerWidth || HOME_COMPACT_BELOW) < HOME_COMPACT_BELOW;
}

function subscribeNarrow(onChange: () => void): () => void {
  if (typeof window === 'undefined') return () => {};
  if (typeof window.matchMedia !== 'function') {
    window.addEventListener('resize', onChange);
    return () => window.removeEventListener('resize', onChange);
  }
  const list = window.matchMedia(NARROW_QUERY);
  list.addEventListener('change', onChange);
  return () => list.removeEventListener('change', onChange);
}

function subscribeChoice(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** The landing view and layout, re-rendering only when either changes. */
export function useHomeView(): { view: HomeView; layout: HomeLayout } {
  const persisted = useSyncExternalStore(subscribeChoice, readChoice, () => null);
  const narrow = useSyncExternalStore(subscribeNarrow, currentNarrow, () => false);
  const pickedRegistered = useSyncExternalStore(subscribePanes,
    () => persisted ? getPane(HOME_PANE_IDS[persisted]) !== null : false, () => false);
  return useMemo(
    () => resolveHomeView({ persisted, width: narrow ? HOME_COMPACT_BELOW - 1 : HOME_COMPACT_BELOW, hasLeaderThread: true, registered: () => pickedRegistered }),
    [persisted, narrow, pickedRegistered],
  );
}
