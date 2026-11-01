import { describe, expect, it } from 'vitest';
import { DOCK_PANES, type DockPaneCatalogEntry } from '../shell/dock-catalog.js';
import { groupDockPanes, matchesPaneQuery } from './dock-add-menu-model.js';

const panes: DockPaneCatalogEntry[] = [
  { id: 'files', label: 'Files' },
  { id: 'fleet-queue', label: 'Queue', group: 'fleet' },
  { id: 'fleet-merges', label: 'Merges', group: 'shipping' },
  { id: 'fleet-lanes', label: 'Lanes', group: 'fleet' },
];

describe('groupDockPanes', () => {
  it('drops empty groups and preserves input order within each group', () => {
    const groups = groupDockPanes(panes, '');
    expect(groups.map((group) => group.id)).toEqual(['fleet', 'shipping', 'agent']);
    expect(groups[0]?.panes.map((pane) => pane.id)).toEqual(['fleet-queue', 'fleet-lanes']);
  });

  it('filters labels and IDs case-insensitively, ignoring surrounding whitespace', () => {
    expect(groupDockPanes(panes, '  MERG  ').flatMap((group) => group.panes.map((pane) => pane.label))).toEqual(['Merges']);
    expect(matchesPaneQuery(panes[1]!, 'FLEET-QUE')).toBe(true);
    expect(groupDockPanes(panes, 'missing')).toEqual([]);
  });

  it('includes every catalog pane exactly once', () => {
    const grouped = groupDockPanes(DOCK_PANES, ' ').flatMap((group) => group.panes.map((pane) => pane.id)).sort();
    expect(grouped).toEqual(DOCK_PANES.map((pane) => pane.id).sort());
  });
});
