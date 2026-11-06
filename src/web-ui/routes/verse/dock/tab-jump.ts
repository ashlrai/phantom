import type { DockPaneId, DockState } from '../shell/dock-catalog.js';
import { getDockState, openDockPane } from './dock-store.js';

/** Resolve a one-based shortcut position in the current tab order. */
export function nthDockTab(state: Pick<DockState, 'tabs'>, n: number): DockPaneId | null {
  if (!Number.isInteger(n) || n < 1 || n > 9) return null;
  return state.tabs[n - 1] ?? null;
}

/** Activate an existing tab, opening the dock if necessary. */
export function jumpToDockTab(n: number): boolean {
  const pane = nthDockTab(getDockState(), n);
  if (pane === null) return false;
  openDockPane(pane);
  return true;
}
