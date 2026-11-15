import { PANE_SECTIONS, sectionForPane } from '../shell/pane-sections.js';

interface PaneEntry { readonly id: string; readonly label: string }

export function matchesPaneQuery(pane: PaneEntry, query: string): boolean {
  const needle = query.trim().toLowerCase();
  return needle === '' || pane.label.toLowerCase().includes(needle) || pane.id.toLowerCase().includes(needle);
}

/** Panes grouped under the MetaMuse sections, in section order; empty sections are dropped. */
export function groupDockPanes<T extends PaneEntry>(panes: readonly T[], query: string) {
  return PANE_SECTIONS.map(({ id, label }) => ({
    id, label, panes: panes.filter((pane) => sectionForPane(pane.id) === id && matchesPaneQuery(pane, query)),
  })).filter((group) => group.panes.length > 0);
}
