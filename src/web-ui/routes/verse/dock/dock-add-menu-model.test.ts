import { describe, expect, it } from 'vitest';
import { DOCK_PANES } from '../shell/dock-pane-catalog.js';
import { groupDockPanes, matchesPaneQuery } from './dock-add-menu-model.js';

const panes = [
  { id: 'files', label: 'Files' },
  { id: 'fleet-queue', label: 'Queue' },
  { id: 'fleet-bus', label: 'Bus' },
  { id: 'fleet-lanes', label: 'Lanes' },
];

describe('groupDockPanes', () => {
  it('drops empty groups and preserves input order within each group', () => {
    const groups = groupDockPanes(panes, '');
    expect(groups.map((group) => group.id)).toEqual(['feed', 'fleet']);
    expect(groups[1]?.panes.map((pane) => pane.id)).toEqual(['files', 'fleet-queue', 'fleet-lanes']);
  });

  it('filters labels and IDs case-insensitively, ignoring surrounding whitespace', () => {
    expect(groupDockPanes(panes, '  BU  ').flatMap((group) => group.panes.map((pane) => pane.label))).toEqual(['Bus']);
    expect(matchesPaneQuery(panes[1]!, 'FLEET-QUE')).toBe(true);
    expect(groupDockPanes(panes, 'missing')).toEqual([]);
  });

  it('includes every catalog pane exactly once', () => {
    const grouped = groupDockPanes(DOCK_PANES, ' ').flatMap((group) => group.panes.map((pane) => pane.id)).sort();
    expect(grouped).toEqual(DOCK_PANES.map((pane) => pane.id).sort());
  });
});
