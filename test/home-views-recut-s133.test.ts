// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { HOME_PANE_IDS, resolveHomeView } from '../src/web-ui/routes/verse/shell/home-view.js';

describe('home view selection', () => {
  it.each(['ideas', 'goals', 'library'] as const)('opens the registered %s pane and falls back when absent', (choice) => {
    const input = { persisted: choice, width: 500, hasLeaderThread: true };
    expect(resolveHomeView({ ...input, registered: (id) => id === HOME_PANE_IDS[choice] })).toEqual({ view: choice, layout: 'compact' });
    expect(resolveHomeView({ ...input, registered: () => false })).toEqual({ view: 'leader', layout: 'compact' });
  });

  it('does not accept inherited properties as home choices', () => {
    expect(resolveHomeView({ persisted: 'toString', width: 900, hasLeaderThread: false, registered: () => true })).toEqual({ view: 'live', layout: 'wide' });
  });
});

import { afterEach } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
import { registerPane } from '../src/web-ui/routes/verse/panes/pane-registry.js';
import { HOME_VIEW_STORAGE_KEY, resetHomeChoice, setHomeChoice, useHomeView } from '../src/web-ui/routes/verse/shell/home-view-store.js';

afterEach(() => {
  cleanup();
  localStorage.clear();
  resetHomeChoice();
});

describe('home view selection', () => {
  it('persists a choice and follows pane registration and removal', () => {
    const { result } = renderHook(() => useHomeView());
    act(() => setHomeChoice('goals'));
    expect(localStorage.getItem(HOME_VIEW_STORAGE_KEY)).toBe('goals');
    expect(result.current.view).toBe('leader');

    let dispose = () => {};
    act(() => { dispose = registerPane({ id: 'goals', title: 'Goals', icon: () => null, component: () => null }); });
    expect(result.current.view).toBe('goals');
    act(() => resetHomeChoice());
    expect(result.current.view).toBe('goals');
    act(() => dispose());
    expect(result.current.view).toBe('leader');
  });
});
