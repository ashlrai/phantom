// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
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
