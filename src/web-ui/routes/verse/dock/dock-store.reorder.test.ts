import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_DOCK_STATE, VERSE_UI_STORAGE_KEY, type DockState } from '../shell/dock-catalog.js';
import { resetVerseUi } from '../verse-ui-store.js';
import { activateDockChat, getDockState, hydrateDockState, moveDockTab, openDockPane, resetDockStore, withTabMoved } from './dock-store.js';

const state: DockState = {
  ...DEFAULT_DOCK_STATE, open: true, tabs: ['terminal', 'tasks', 'context'], active: 'tasks', splitWith: 'terminal',
};

describe('withTabMoved', () => {
  it('swaps a middle tab with either neighbour without changing the visible panes', () => {
    for (const [delta, tabs] of [[-1, ['tasks', 'terminal', 'context']], [1, ['terminal', 'context', 'tasks']]] as const) {
      const result = withTabMoved(state, 'tasks', delta);
      expect(result).not.toBe(state);
      expect(result.tabs).toEqual(tabs);
      expect(result.active).toBe(state.active);
      expect(result.splitWith).toBe(state.splitWith);
    }
    expect(state.tabs).toEqual(['terminal', 'tasks', 'context']);
  });

  it('returns the same state for a boundary or unknown tab', () => {
    expect(withTabMoved(state, 'terminal', -1)).toBe(state);
    expect(withTabMoved(state, 'context', 1)).toBe(state);
    expect(withTabMoved(state, 'unknown-pane', 1)).toBe(state);
  });
});

describe('moveDockTab', () => {
  beforeEach(() => {
    resetVerseUi();
    resetDockStore();
    localStorage.clear();
  });

  it('persists the order through the UI store and restores it after a reload', () => {
    openDockPane('terminal');
    openDockPane('tasks');
    openDockPane('context');
    moveDockTab('tasks', -1);
    const persisted = JSON.parse(localStorage.getItem(VERSE_UI_STORAGE_KEY)!) as { dock: unknown };
    resetDockStore();
    hydrateDockState(persisted.dock);
    expect(getDockState().tabs).toEqual(['tasks', 'terminal', 'context']);
  });

  it('changes only the current chat layout', () => {
    activateDockChat('first');
    openDockPane('terminal');
    openDockPane('tasks');
    activateDockChat('second');
    moveDockTab('tasks', -1);
    expect(getDockState().tabs).toEqual(['tasks', 'terminal']);
    activateDockChat('first');
    expect(getDockState().tabs).toEqual(['terminal', 'tasks']);
    activateDockChat('second');
    expect(getDockState().tabs).toEqual(['tasks', 'terminal']);
  });
});
