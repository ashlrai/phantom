import { hydrateDockState, openFleetWorkspace, resetDockStore } from '../dock/dock-store.js';
import { curatedWorkspace } from '../fleet-hub/fleet-hub-model.js';
import { listPanes } from '../panes/pane-registry.js';
import { VERSE_UI_STORAGE_KEY_V2 } from '../shell/dock-catalog.js';

const defaults = {
  reset: () => { resetDockStore(); hydrateDockState(null); },
  open: openFleetWorkspace,
  panes: () => listPanes().map(pane => pane.id),
};

export function resetDockLayout(deps = defaults): string[] {
  try { localStorage.removeItem(VERSE_UI_STORAGE_KEY_V2); } catch { /* Storage may be unavailable. */ }
  deps.reset();
  const ids = curatedWorkspace(deps.panes());
  deps.open(ids);
  return ids;
}
