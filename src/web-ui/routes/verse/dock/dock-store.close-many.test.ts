/**
 * dock/dock-store.close-many.test.ts — closing MANY tabs at once. A dock
 * tab's context menu ("Close other panes", "Close all panes") and the close
 * button's shift-click fold withTabClosed over a list, so the active
 * hand-over is the same rule the per-tab close button follows.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_DOCK_STATE, type DockState } from '../shell/dock-catalog.js';
import { closeDockTabs, getDockState, openDockPane, resetDockStore, withTabsClosed } from './dock-store.js';

const base = (over: Partial<DockState> = {}): DockState => ({ ...DEFAULT_DOCK_STATE, tabs: [], ...over });

describe('withTabsClosed', () => {
  it('closes two of three tabs and keeps the third active', () => {
    const state = base({ open: true, tabs: ['terminal', 'tasks', 'context'], active: 'context' });
    expect(withTabsClosed(state, ['terminal', 'tasks'])).toMatchObject({ open: true, tabs: ['context'], active: 'context' });
  });

  it('moves the split\'s lower pane up when the batch takes the active tab', () => {
    const state = base({ open: true, tabs: ['browser', 'terminal', 'tasks'], active: 'browser', splitWith: 'terminal' });
    expect(withTabsClosed(state, ['browser', 'tasks'])).toMatchObject({ tabs: ['terminal'], active: 'terminal', splitWith: null });
  });

  it('returns the same state object for an empty list or ids that are not open', () => {
    const state = base({ open: true, tabs: ['tasks'], active: 'tasks' });
    expect(withTabsClosed(state, [])).toBe(state);
    expect(withTabsClosed(state, ['not-open'])).toBe(state);
  });

  it('closing every tab leaves the dock closed with nothing active', () => {
    const state = base({ open: true, tabs: ['terminal', 'tasks'], active: 'terminal' });
    expect(withTabsClosed(state, ['terminal', 'tasks'])).toMatchObject({ open: false, tabs: [], active: null, splitWith: null });
  });
});

describe('closeDockTabs', () => {
  beforeEach(() => {
    localStorage.clear();
    resetDockStore();
  });

  it('updates the store snapshot', () => {
    openDockPane('terminal');
    openDockPane('tasks');
    openDockPane('context');
    closeDockTabs(['terminal', 'context']);
    expect(getDockState()).toMatchObject({ open: true, tabs: ['tasks'], active: 'tasks' });
  });
});
