import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_DOCK_STATE, type DockState } from '../shell/dock-catalog.js';
import * as registry from '../panes/index.js';
import { getDockState, hydrateDockState, resetDockStore, withUnknownTabsPruned } from './dock-store.js';

const state: DockState = {
  ...DEFAULT_DOCK_STATE, open: true, tabs: ['gone', 'terminal', 'fleet-hub'], active: 'gone', splitWith: 'fleet-hub',
  byChat: { old: { open: true, tabs: ['missing'], active: 'missing', splitWith: null } },
};

describe('unknown dock panes', () => {
  beforeEach(() => { localStorage.clear(); resetDockStore(); });

  it('keeps builtins and registered panes, repairs both layouts, and promotes a surviving split', () => {
    expect(withUnknownTabsPruned(state, new Set(['fleet-hub']))).toMatchObject({
      open: true, tabs: ['terminal', 'fleet-hub'], active: 'fleet-hub', splitWith: null,
      byChat: { old: { open: false, tabs: [], active: null, splitWith: null } },
    });
    expect(withUnknownTabsPruned({ ...state, active: 'terminal', splitWith: 'gone' }, new Set(['fleet-hub'])))
      .toMatchObject({ active: 'terminal', splitWith: null });
    expect(withUnknownTabsPruned(state, new Set())).toBe(state);
  });

  it('connects discovery to the store after all fleet panes have registered', async () => {
    hydrateDockState(state);
    await Promise.resolve();
    expect(registry.getPane('fleet-hub')).not.toBeNull();
    expect(getDockState().tabs).toEqual(['terminal', 'fleet-hub']);
    registry.resetPaneRegistry();
    hydrateDockState(state);
    await Promise.resolve();
    expect(getDockState().tabs).toEqual(state.tabs);
    registry.registerBuiltinPanes();
    await Promise.resolve();
    expect(getDockState().tabs).toEqual(['terminal']);
  });
});
