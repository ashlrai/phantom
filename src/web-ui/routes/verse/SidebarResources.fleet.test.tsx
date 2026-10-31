import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { evictAll } from '../../data/cache.js';
import { installFetch, json } from './context/context-fixtures.test-support.js';
import { getDockState, resetDockStore } from './dock/dock-store.js';
import { isFocusMode, setFocusMode } from './shell/focus-mode.js';
import { getVerseUiState, resetVerseUi, setVerseSection } from './verse-ui-store.js';
import { SidebarResources } from './SidebarResources.js';

beforeEach(() => {
  localStorage.clear();
  evictAll();
  resetVerseUi();
  resetDockStore();
  setFocusMode(false);
  setVerseSection('agents');
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('sidebar Fleet entry', () => {
  // Pane registration is global to this test file's module graph, so this
  // case must run before any test below imports a *.pane.js module.
  it('is disabled with a note when this build registers no fleet panes', async () => {
    render(<SidebarResources />);
    const button = screen.getByRole('button', { name: 'Open fleet workspace' });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('title', 'Fleet panes are not in this build');
    await userEvent.setup().click(button);
    expect(getVerseUiState().section).toBe('agents');
    expect(getDockState()).toMatchObject({ open: false, tabs: [] });
  });

  it('opens the curated fleet workspace in the chat dock without any server calls', async () => {
    const { calls } = installFetch(() => json({ error: 'unexpected read' }, 500));
    await import('./fleet-lanes/fleet-lanes.pane.js');
    await import('./fleet-merges/fleet-merges.pane.js');
    setFocusMode(true);
    const user = userEvent.setup();
    render(<SidebarResources />);
    const button = screen.getByRole('button', { name: 'Open fleet workspace' });
    expect(button).toBeEnabled();
    await user.click(button);
    expect(getVerseUiState().section).toBe('chat');
    expect(isFocusMode()).toBe(false);
    expect(getDockState()).toMatchObject({
      open: true,
      tabs: ['fleet-lanes', 'fleet-merges'],
      active: 'fleet-lanes',
      splitWith: 'fleet-merges',
    });
    expect(calls).toHaveLength(0);
  });

  it('dismisses the floating phone sidebar like the other entries', async () => {
    await import('./fleet-lanes/fleet-lanes.pane.js');
    vi.stubGlobal('matchMedia', (query: string) => ({ matches: query === '(max-width: 760px)' }));
    const user = userEvent.setup();
    render(<SidebarResources />);
    await user.click(screen.getByRole('button', { name: 'Open fleet workspace' }));
    expect(getVerseUiState()).toMatchObject({ section: 'chat', sidebarCollapsed: true });
  });
});
