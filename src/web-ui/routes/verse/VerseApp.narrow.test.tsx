/**
 * The shell's narrow layout: one tree, one `data-layout` attribute on the root.
 * Width comes from window.innerWidth (viewport.test-support); the Layout
 * preference comes from <html data-layout-pref>, as Settings writes it.
 */
import { act, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '../../components/primitives/Toast.js';
import { clearMutationToken, markCheckComplete } from '../../data/auth-store.js';
import { evictAll } from '../../data/cache.js';
import { MockEventSource } from './fixtures.test-support.js';
import { resetCommandBus } from './shell/command-bus.js';
import { resetGuard } from './shell/guarded-action.js';
import { activity, shellFetch } from './shell/shell-fixtures.test-support.js';
import { resetActivityForTest } from './shell/useActivity.js';
import { mockViewport, type ViewportMock } from './shell/viewport.test-support.js';
import { reloadResourcesUiForTest } from './resources/resources-store.js';
import { resetVerseStore } from './verse-store.js';
import { resetVerseUi, setVerseSection } from './verse-ui-store.js';
import { PhantomApp } from './VerseApp.js';

let viewport: ViewportMock | null = null;
const root = () => document.querySelector<HTMLElement>('[data-layout]');

function mountAt(width: number) {
  viewport = mockViewport(width);
  setVerseSection('chat');
  return render(<ToastProvider><PhantomApp /></ToastProvider>);
}

beforeEach(() => {
  window.history.replaceState(null, '', '/verse/');
  localStorage.clear();
  document.documentElement.removeAttribute('data-layout-pref');
  reloadResourcesUiForTest();
  evictAll();
  resetVerseStore();
  resetVerseUi();
  resetCommandBus();
  resetGuard();
  clearMutationToken();
  MockEventSource.reset();
  vi.stubGlobal('EventSource', MockEventSource);
  vi.stubGlobal('fetch', shellFetch(activity({})).fetch);
  resetActivityForTest();
  markCheckComplete(true);
});

afterEach(() => {
  viewport?.restore();
  viewport = null;
  act(() => markCheckComplete(false));
  vi.unstubAllGlobals();
  resetActivityForTest();
  document.documentElement.removeAttribute('data-layout-pref');
  window.history.replaceState(null, '', '/');
});

describe('PhantomApp narrow layout', () => {
  it('at 800px the root is narrow, the rail is icon-only and the section tabs render', async () => {
    mountAt(800);
    expect(root()).toHaveAttribute('data-layout', 'narrow');
    expect(root()).toHaveAttribute('data-rail', 'collapsed');
    const tabs = await screen.findByRole('navigation', { name: 'Home views' });
    for (const name of ['Leader', 'Feed']) expect(tabs).toHaveTextContent(name);
  });

  it('at 1400px the root is wide and there is no tab row', async () => {
    mountAt(1400);
    expect(root()).toHaveAttribute('data-layout', 'wide');
    await screen.findByRole('navigation', { name: 'Phantom sections' });
    expect(screen.queryByRole('navigation', { name: 'Home views' })).not.toBeInTheDocument();
  });

  it('follows a resize across the 960px boundary', async () => {
    mountAt(1400);
    expect(root()).toHaveAttribute('data-layout', 'wide');
    act(() => viewport!.setWidth(959));
    await waitFor(() => expect(root()).toHaveAttribute('data-layout', 'narrow'));
    act(() => viewport!.setWidth(960));
    await waitFor(() => expect(root()).toHaveAttribute('data-layout', 'wide'));
  });

  it('a pinned Layout preference overrides the width, live', async () => {
    mountAt(1400);
    act(() => document.documentElement.setAttribute('data-layout-pref', 'narrow'));
    await waitFor(() => expect(root()).toHaveAttribute('data-layout', 'narrow'));
    act(() => document.documentElement.setAttribute('data-layout-pref', 'wide'));
    act(() => viewport!.setWidth(700));
    await waitFor(() => expect(root()).toHaveAttribute('data-layout', 'wide'));
  });
});
