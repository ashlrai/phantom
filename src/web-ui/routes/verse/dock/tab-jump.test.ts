import { beforeEach, describe, expect, it } from 'vitest';
import { getDockState, hydrateDockState, resetDockStore } from './dock-store.js';
import { jumpToDockTab, nthDockTab } from './tab-jump.js';

describe('dock tab jumping', () => {
  beforeEach(() => {
    localStorage.clear();
    resetDockStore();
  });

  it('resolves only existing tabs at integer positions from 1 through 9', () => {
    const state = { tabs: ['terminal', 'tasks', 'diff'] };
    expect(nthDockTab(state, 1)).toBe('terminal');
    expect(nthDockTab(state, 3)).toBe('diff');
    for (const n of [-1, 0, 4, 10, 1.5, NaN]) expect(nthDockTab(state, n)).toBeNull();
    expect(nthDockTab({ tabs: Array.from({ length: 10 }, (_, i) => `pane-${i}`) }, 9)).toBe('pane-8');
    expect(nthDockTab({ tabs: Array.from({ length: 10 }, (_, i) => `pane-${i}`) }, 10)).toBeNull();
  });

  it('activates the third tab without changing the tab order', () => {
    hydrateDockState({ open: true, tabs: ['terminal', 'tasks', 'diff'], active: 'terminal' });
    expect(jumpToDockTab(3)).toBe(true);
    expect(getDockState()).toMatchObject({ open: true, tabs: ['terminal', 'tasks', 'diff'], active: 'diff' });
  });

  it('leaves the dock unchanged when the requested tab is absent', () => {
    hydrateDockState({ open: true, tabs: ['terminal', 'tasks'], active: 'terminal' });
    const before = getDockState();
    expect(jumpToDockTab(3)).toBe(false);
    expect(getDockState()).toBe(before);
  });

  it('opens a closed dock on the requested tab', () => {
    hydrateDockState({ open: false, tabs: ['terminal', 'tasks', 'diff'], active: 'terminal' });
    expect(jumpToDockTab(3)).toBe(true);
    expect(getDockState()).toMatchObject({ open: true, active: 'diff' });
  });
});
