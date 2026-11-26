import { act, cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '../../../components/primitives/Toast.js';
import { clearMutationToken } from '../../../data/auth-store.js';
import { evictAll } from '../../../data/cache.js';
import { setVerseSection } from '../verse-ui-store.js';
import { SettingsSection } from './SettingsSection.js';
import {
  SETTINGS_GROUPS,
  SETTINGS_GROUP_STORAGE_KEY,
  SETTINGS_PANELS,
  getSettingsView,
  resetSettingsView,
  searchSettings,
  setSettingsView,
} from './settings-groups.js';

function renderSettings() {
  return render(<ToastProvider><SettingsSection /></ToastProvider>);
}

const requested = () => vi.mocked(fetch).mock.calls.map(([url]) => String(url));

beforeEach(() => {
  localStorage.clear();
  resetSettingsView();
  setVerseSection('settings');
  clearMutationToken();
  evictAll();
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
  resetSettingsView();
});

describe('Settings groups', () => {
  it('names the seven groups in order and places every panel in one', () => {
    expect(SETTINGS_GROUPS.map((group) => group.label)).toEqual([
      'General', 'Appearance', 'Accounts & resources', 'Updates', 'Autonomy', 'Team', 'About',
    ]);
    const ids = SETTINGS_PANELS.map((panel) => panel.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const group of SETTINGS_GROUPS) expect(SETTINGS_PANELS.some((panel) => panel.group === group.id)).toBe(true);
  });

  it('opens on General and mounts only that group', () => {
    renderSettings();
    expect(screen.getByRole('button', { name: 'General' })).toHaveAttribute('aria-current', 'page');
    const content = screen.getByTestId('settings-content');
    expect(within(content).getAllByRole('heading', { name: 'Chat' }).length).toBeGreaterThan(0);
    expect(within(content).queryByRole('heading', { name: 'Appearance' })).toBeNull();
    expect(within(content).queryByRole('heading', { name: 'About' })).toBeNull();
    expect(within(content).queryByRole('heading', { name: 'Team' })).toBeNull();
  });

  it('does not start Team, ecosystem or update reads until their group opens', async () => {
    const user = userEvent.setup();
    renderSettings();
    await act(async () => { await Promise.resolve(); });
    expect(requested().some((url) => url.includes('/api/verse/team'))).toBe(false);
    expect(requested().some((url) => url.includes('/api/onboard/ecosystem'))).toBe(false);
    expect(requested().some((url) => url.includes('/api/verse/ops/self-update'))).toBe(false);
    await user.click(screen.getByRole('button', { name: 'Team' }));
    expect(screen.getByRole('button', { name: 'Team' })).toHaveAttribute('aria-current', 'page');
    await vi.waitFor(() => expect(requested().some((url) => url.includes('/api/verse/team'))).toBe(true));
  });

  it('remembers the selected group across opens', async () => {
    const user = userEvent.setup();
    const first = renderSettings();
    await user.click(screen.getByRole('button', { name: 'Autonomy' }));
    expect(localStorage.getItem(SETTINGS_GROUP_STORAGE_KEY)).toBe('autonomy');
    first.unmount();
    resetSettingsView();
    renderSettings();
    expect(screen.getByRole('button', { name: 'Autonomy' })).toHaveAttribute('aria-current', 'page');
  });

  it('searches titles and keywords across groups and mounts only the matches', async () => {
    const user = userEvent.setup();
    renderSettings();
    await user.type(screen.getByRole('searchbox', { name: 'Search settings' }), 'theme');
    const content = screen.getByTestId('settings-content');
    expect(within(content).getAllByRole('heading', { name: 'Appearance' }).length).toBeGreaterThan(0);
    expect(within(content).queryByRole('heading', { name: 'Chat' })).toBeNull();
    expect(screen.getByRole('button', { name: 'General' })).not.toHaveAttribute('aria-current');
    await user.clear(screen.getByRole('searchbox', { name: 'Search settings' }));
    await user.type(screen.getByRole('searchbox', { name: 'Search settings' }), 'zzzz-nothing');
    expect(screen.getByText('No settings match “zzzz-nothing”.')).toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(within(screen.getByTestId('settings-content')).getAllByRole('heading', { name: 'Chat' }).length).toBeGreaterThan(0);
  });

  it('matches every word of a query', () => {
    expect(searchSettings('').length).toBe(0);
    expect(searchSettings('update').map((panel) => panel.id)).toContain('updates');
    expect(searchSettings('dark accent').map((panel) => panel.id)).toEqual(['appearance']);
  });

  it('follows a Settings anchor to the group that holds it', () => {
    setVerseSection('settings', 'fleet-sources');
    renderSettings();
    expect(getSettingsView()).toBe('accounts');
    act(() => setVerseSection('settings', 'desktop-updates'));
    expect(screen.getByRole('button', { name: 'Updates' })).toHaveAttribute('aria-current', 'page');
  });

  it('All settings renders every group with a heading', async () => {
    setSettingsView('all');
    renderSettings();
    const content = screen.getByTestId('settings-content');
    for (const group of SETTINGS_GROUPS) {
      expect(content.querySelector(`[data-settings-group="${group.id}"]`)).not.toBeNull();
    }
    expect(within(content).getByText('Accounts & resources')).toBeInTheDocument();
  });
});
