import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { defaultUiSettings } from '../../../../core/ui-settings-schema.js';
import { ToastProvider } from '../../../components/primitives/Toast.js';
import { getAppearance, resetAppearance } from '../../../data/appearance-store.js';
import { clearMutationToken } from '../../../data/auth-store.js';
import { evictAll } from '../../../data/cache.js';
import { resetUiSettingsSyncForTest, UI_SETTINGS_ENDPOINT } from '../../../data/ui-settings-sync.js';
import { getVerseUiState, resetVerseUi } from '../verse-ui-store.js';
import { SettingsSection } from './SettingsSection.js';
import { setSettingsView } from './settings-groups.js';

// The long page these suites assert is the "All settings" view.
beforeEach(() => { setSettingsView('all'); });

describe('SettingsSection file reload through the recovered panels (C427)', () => {
  beforeEach(() => {
    evictAll();
    localStorage.clear();
    resetAppearance();
    resetVerseUi();
    resetUiSettingsSyncForTest();
    clearMutationToken();
  });

  afterEach(() => {
    resetUiSettingsSyncForTest();
    vi.unstubAllGlobals();
    clearMutationToken();
    localStorage.clear();
    resetAppearance();
    resetVerseUi();
  });

  it('reloads a file edit into both live stores and discards the raw editor draft without a write', async () => {
    const settings = defaultUiSettings();
    settings.appearance['density'] = 'compact';
    settings.layout['resourcesWidth'] = 400;
    settings.layout['resourcesOpen'] = false;
    const requests: Array<{ path: string; method: string }> = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(input instanceof Request ? input.url : String(input), window.location.origin).pathname;
      requests.push({ path, method: init?.method ?? 'GET' });
      const body = path === UI_SETTINGS_ENDPOINT
        ? { path: '/home/tester/.ashlr/ui.json', exists: true, parsed: true, settings, problems: [] }
        : {};
      return new Response(JSON.stringify(body), { status: 200 });
    }));
    render(<ToastProvider><SettingsSection /></ToastProvider>);
    await act(async () => { await import('../panes/index.js'); });

    const editor = screen.getByRole('textbox', { name: /Contents/ });
    fireEvent.change(editor, { target: { value: '{"layout":{"resourcesWidth":280}}' } });
    expect(screen.getByRole('button', { name: 'Save to file' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: 'Reload from file' }));

    await waitFor(() => {
      expect(getVerseUiState()).toMatchObject({ resourcesWidth: 400, resourcesOpen: false });
      expect(getAppearance().density).toBe('compact');
      expect(editor).toHaveValue(`${JSON.stringify(settings, null, 2)}\n`);
      expect(screen.getByRole('button', { name: 'Save to file' })).toBeDisabled();
    });
    expect(screen.getByRole('switch', { name: 'Show resources panel' })).not.toBeChecked();
    expect(screen.getByRole('radio', { name: 'Compact' })).toBeChecked();
    expect(screen.getByText('/home/tester/.ashlr/ui.json')).toBeInTheDocument();
    expect(requests.filter(({ path }) => path === UI_SETTINGS_ENDPOINT)).toEqual([
      { path: UI_SETTINGS_ENDPOINT, method: 'GET' },
    ]);
    expect(requests.every(({ method }) => method === 'GET')).toBe(true);
  });
});
