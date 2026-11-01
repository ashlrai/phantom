import { DOCK_PANE_GROUPS, type DockPaneCatalogEntry } from '../shell/dock-catalog.js';

export function matchesPaneQuery(pane: DockPaneCatalogEntry, query: string): boolean {
  const needle = query.trim().toLowerCase();
  return needle === '' || pane.label.toLowerCase().includes(needle) || pane.id.toLowerCase().includes(needle);
}

export function groupDockPanes<T extends DockPaneCatalogEntry>(panes: readonly T[], query: string) {
  return DOCK_PANE_GROUPS.map(({ id, label }) => ({
    id, label, panes: panes.filter((pane) => (pane.group ?? 'agent') === id && matchesPaneQuery(pane, query)),
  })).filter((group) => group.panes.length > 0);
}
