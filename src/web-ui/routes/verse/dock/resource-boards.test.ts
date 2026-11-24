import { describe, expect, it } from 'vitest';
import { DEFAULT_DOCK_STATE, type DockState } from '../shell/dock-catalog.js';
import { withPaneSwapped } from './dock-store.js';
import { isResourceBoard, neighbourBoard, resourceBoards } from './resource-boards.js';

const titles: Record<string, string> = { 'fleet-pools': 'Pools', 'fleet-usage': 'Usage', models: 'Models', 'fleet-lanes': 'Lanes' };
const lookup = (id: string) => (titles[id] ? { title: titles[id]!, description: id === 'models' ? 'Every model.' : null } : null);

describe('resourceBoards', () => {
  it('lists only registered boards, in switcher order, named by their registrations', () => {
    const boards = resourceBoards(lookup);
    expect(boards.map((board) => board.title)).toEqual(['Pools', 'Usage', 'Models', 'Lanes']);
    expect(boards.find((board) => board.id === 'models')!.description).toBe('Every model.');
  });

  it('marks where a new group begins among the boards that are listed', () => {
    // Router is not registered here, so Models opens the routing group; the first board never gets a divider.
    expect(resourceBoards(lookup).map((board) => board.startsGroup)).toEqual([false, false, true, true]);
  });

  it('is empty when no board is registered', () => {
    expect(resourceBoards(() => null)).toEqual([]);
  });

  it('knows a resource board from any other pane', () => {
    expect(isResourceBoard('fleet-capacity')).toBe(true);
    expect(isResourceBoard('fleet-router')).toBe(true);
    expect(isResourceBoard('fleet-throughput')).toBe(true);
    expect(isResourceBoard('fleet-sessions')).toBe(false);
  });
});

describe('neighbourBoard', () => {
  const boards = resourceBoards(lookup);
  it('steps along the row and wraps at both ends', () => {
    expect(neighbourBoard(boards, 'fleet-pools', 1)).toBe('fleet-usage');
    expect(neighbourBoard(boards, 'fleet-pools', -1)).toBe('fleet-lanes');
    expect(neighbourBoard(boards, 'fleet-lanes', 1)).toBe('fleet-pools');
  });

  it('has no neighbour for an unlisted board or a row of one', () => {
    expect(neighbourBoard(boards, 'fleet-supply', 1)).toBeNull();
    expect(neighbourBoard(boards.slice(0, 1), 'fleet-pools', 1)).toBeNull();
  });
});

describe('withPaneSwapped', () => {
  const state: DockState = { ...DEFAULT_DOCK_STATE, open: true, tabs: ['terminal', 'fleet-pools', 'tasks'], active: 'fleet-pools', splitWith: null };

  it('puts the new pane in the old one\'s tab position and on screen', () => {
    const next = withPaneSwapped(state, 'fleet-pools', 'fleet-usage');
    expect(next.tabs).toEqual(['terminal', 'fleet-usage', 'tasks']);
    expect(next.active).toBe('fleet-usage');
    expect(state.tabs).toEqual(['terminal', 'fleet-pools', 'tasks']);
  });

  it('keeps the lower half of a split the lower half', () => {
    const split: DockState = { ...state, active: 'terminal', splitWith: 'fleet-pools' };
    const next = withPaneSwapped(split, 'fleet-pools', 'fleet-lanes');
    expect(next.active).toBe('terminal');
    expect(next.splitWith).toBe('fleet-lanes');
    expect(next.tabs).toEqual(['terminal', 'fleet-lanes', 'tasks']);
  });

  it('brings forward a pane that already has a tab and leaves both tabs', () => {
    const both: DockState = { ...state, tabs: ['fleet-pools', 'fleet-usage'] };
    const next = withPaneSwapped(both, 'fleet-pools', 'fleet-usage');
    expect(next.tabs).toEqual(['fleet-pools', 'fleet-usage']);
    expect(next.active).toBe('fleet-usage');
  });

  it('opens the pane normally when the one to replace has no tab, and is a no-op onto itself', () => {
    const next = withPaneSwapped(state, 'fleet-supply', 'fleet-usage');
    expect(next.tabs).toEqual(['terminal', 'fleet-pools', 'tasks', 'fleet-usage']);
    expect(next.active).toBe('fleet-usage');
    expect(withPaneSwapped(state, 'fleet-pools', 'fleet-pools')).toBe(state);
  });
});
