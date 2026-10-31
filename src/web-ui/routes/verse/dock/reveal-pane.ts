import { normalizePaneId, type DockPaneId } from '../shell/dock-catalog.js';
import { setFocusMode } from '../shell/focus-mode.js';
import { setVerseSection } from '../verse-ui-store.js';
import { openDockPane } from './dock-store.js';

/** Reveal a dock pane from any surface. Invalid IDs leave the current view alone. */
export function revealDockPane(paneId: DockPaneId | string): void {
  const normalized = normalizePaneId(paneId);
  if (normalized === null) return;
  setFocusMode(false);
  setVerseSection('chat');
  openDockPane(normalized);
}
