import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { registerPane } from '../panes/pane-registry.js';
import { HOME_VIEW_STORAGE_KEY, resetHomeChoice, setHomeChoice, useHomeView } from './home-view-store.js';

afterEach(() => { localStorage.clear(); resetHomeChoice(); });

it('resolves the saved home when the registry loads and follows registration changes', async () => {
  setHomeChoice('goals');
  const view = renderHook(useHomeView);
  expect(view.result.current.view).toBe('leader');
  let unregister = () => {};
  try {
    act(() => {
      unregister = registerPane({ id: 'goals', title: 'Goals', icon: () => null, component: () => null });
    });
    await waitFor(() => expect(view.result.current.view).toBe('goals'));
    act(() => unregister());
    expect(view.result.current.view).toBe('leader');
    expect(localStorage.getItem(HOME_VIEW_STORAGE_KEY)).toBe('goals');
    act(() => setHomeChoice('feed'));
    act(() => {
      unregister = registerPane({ id: 'feed', title: 'Feed', icon: () => null, component: () => null });
    });
    expect(view.result.current.view).toBe('feed');
  } finally { view.unmount(); unregister(); }
});

it('resolves an already registered home synchronously on the first render', () => {
  const unregister = registerPane({ id: 'feed', title: 'Feed', icon: () => null, component: () => null });
  setHomeChoice('feed');
  const view = renderHook(useHomeView);
  try { expect(view.result.current.view).toBe('feed'); }
  finally { view.unmount(); unregister(); }
});
