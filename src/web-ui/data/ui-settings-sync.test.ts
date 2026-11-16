/**
 * The settings round trip: file → UI on load/reload, UI → file on change,
 * migration of an old localStorage-only setup, and honest degradation when the
 * file cannot be written. The server is a fake `~/.ashlr/ui.json` behind a
 * mocked client; the stores are the real ones.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultUiSettings, normalizeUiSettings, type UiSettings } from '../../core/ui-settings-schema.js';

let disk: { exists: boolean; settings: UiSettings };
let token: string | null;
let phase: 'authenticated' | 'checking';
const authListeners = new Set<() => void>();
const apiPut = vi.fn();

vi.mock('./client.js', () => {
  class ApiError extends Error {
    constructor(message: string, readonly status: number, readonly path?: string) { super(message); }
  }
  return {
    ApiError,
    apiGet: async () => ({ path: '/home/me/.ashlr/ui.json', exists: disk.exists, parsed: true, settings: disk.settings, problems: [] }),
    apiPut: (...args: unknown[]) => apiPut(...args),
  };
});
vi.mock('./auth-store.js', () => ({
  getAuthSnapshot: () => ({ phase }),
  getMutationToken: () => token,
  subscribeAuth: (l: () => void) => { authListeners.add(l); return () => authListeners.delete(l); },
}));
vi.mock('./remote-mode.js', () => ({ isRemoteMobileMode: () => false }));

const settle = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

async function load() {
  vi.resetModules();
  const sync = await import('./ui-settings-sync.js');
  const appearance = await import('./appearance-store.js');
  const verse = await import('../routes/verse/verse-ui-store.js');
  return { sync, appearance, verse };
}

beforeEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute('data-density');
  disk = { exists: true, settings: defaultUiSettings() };
  token = 'tok';
  phase = 'authenticated';
  authListeners.clear();
  apiPut.mockReset();
  apiPut.mockImplementation(async (_path: string, body: unknown) => {
    const { settings } = normalizeUiSettings(body, disk.settings);
    disk = { exists: true, settings };
    return { path: '/home/me/.ashlr/ui.json', exists: true, parsed: true, settings, problems: [] };
  });
  vi.useFakeTimers();
});
afterEach(() => vi.useRealTimers());

describe('file → UI', () => {
  it('applies the file over the local cache at startup, and never echoes it back', async () => {
    const { sync, appearance, verse } = await load();
    localStorage.setItem('ashlr.verse.appearance.v1', JSON.stringify({ density: 'comfortable' }));
    disk.settings = normalizeUiSettings({
      appearance: { density: 'compact', accentH: 10 },
      layout: { sidebarWidth: 320, resourcesOpen: false },
    }).settings;
    sync.startUiSettingsSync();
    await settle();

    expect(appearance.getAppearance()).toMatchObject({ density: 'compact', accentH: 10 });
    expect(document.documentElement.getAttribute('data-density')).toBe('compact');
    expect(verse.getVerseUiState()).toMatchObject({ sidebarWidth: 320, resourcesOpen: false });
    expect(sync.getUiSettingsStatus()).toMatchObject({ phase: 'synced', path: '/home/me/.ashlr/ui.json' });
    await vi.advanceTimersByTimeAsync(2000);
    expect(apiPut).not.toHaveBeenCalled();
  });

  it('"Reload from file" picks up an edit made outside the UI (an agent)', async () => {
    const { sync, appearance } = await load();
    sync.startUiSettingsSync();
    await settle();
    expect(appearance.getAppearance().radius).toBe('default');

    disk.settings = normalizeUiSettings({ appearance: { radius: 'soft', theme: 'dark' } }).settings;
    await sync.reloadUiSettingsFromFile();
    expect(appearance.getAppearance()).toMatchObject({ radius: 'soft', theme: 'dark' });
    await vi.advanceTimersByTimeAsync(2000);
    expect(apiPut).not.toHaveBeenCalled();
  });

  it('waits for a read session before reading', async () => {
    phase = 'checking';
    const { sync, appearance } = await load();
    disk.settings = normalizeUiSettings({ appearance: { density: 'compact' } }).settings;
    sync.startUiSettingsSync();
    await settle();
    expect(appearance.getAppearance().density).toBe('comfortable');
    phase = 'authenticated';
    authListeners.forEach((l) => l());
    await settle();
    expect(appearance.getAppearance().density).toBe('compact');
  });
});

describe('UI → file', () => {
  it('debounces store changes into one PUT that the file then holds', async () => {
    const { sync, appearance, verse } = await load();
    sync.startUiSettingsSync();
    await settle();

    appearance.setAppearance({ density: 'compact' });
    verse.setVerseSidebarWidth(300);
    appearance.setAppearance({ accentH: 100 });
    expect(sync.getUiSettingsStatus().phase).toBe('saving');
    await vi.advanceTimersByTimeAsync(sync.PUSH_DEBOUNCE_MS + 10);

    expect(apiPut).toHaveBeenCalledTimes(1);
    expect(apiPut.mock.calls[0]![0]).toBe('/api/ui-settings');
    expect(apiPut.mock.calls[0]![2]).toBe('tok');
    expect(disk.settings.appearance).toMatchObject({ density: 'compact', accentH: 100 });
    expect(disk.settings.layout).toMatchObject({ sidebarWidth: 300 });
    expect(sync.getUiSettingsStatus().phase).toBe('synced');
  });

  it('seeds a missing file from existing localStorage choices, but not from defaults', async () => {
    disk = { exists: false, settings: defaultUiSettings() };
    const first = await load();
    first.sync.startUiSettingsSync();
    await settle();
    expect(apiPut).not.toHaveBeenCalled();

    localStorage.setItem('ashlr.verse.appearance.v1', JSON.stringify({ density: 'compact', accentH: 20 }));
    const second = await load();
    second.sync.startUiSettingsSync();
    await settle();
    expect(apiPut).toHaveBeenCalledTimes(1);
    expect(disk.settings.appearance).toMatchObject({ density: 'compact', accentH: 20 });
    expect(second.appearance.getAppearance().density).toBe('compact');
  });

  it('keeps working locally and says why when the file cannot be written', async () => {
    token = null;
    const { sync, appearance } = await load();
    sync.startUiSettingsSync();
    await settle();
    appearance.setAppearance({ density: 'compact' });
    await vi.advanceTimersByTimeAsync(sync.PUSH_DEBOUNCE_MS + 10);
    expect(apiPut).not.toHaveBeenCalled();
    expect(sync.getUiSettingsStatus()).toMatchObject({ phase: 'local-only', detail: expect.stringContaining('Unlock') });
    expect(appearance.getAppearance().density).toBe('compact');

    // The token arrives: the pending change is written without another edit.
    token = 'tok';
    authListeners.forEach((l) => l());
    await vi.advanceTimersByTimeAsync(sync.PUSH_DEBOUNCE_MS + 10);
    expect(disk.settings.appearance.density).toBe('compact');
  });

  it('explains a server without --allow-dispatch (404) instead of failing silently', async () => {
    const { ApiError } = await import('./client.js');
    apiPut.mockRejectedValueOnce(new ApiError('nf', 404, '/api/ui-settings'));
    const { sync, appearance } = await load();
    sync.startUiSettingsSync();
    await settle();
    appearance.setAppearance({ radius: 'sharp' });
    await vi.advanceTimersByTimeAsync(sync.PUSH_DEBOUNCE_MS + 10);
    expect(sync.getUiSettingsStatus().detail).toContain('--allow-dispatch');
  });
});

describe('raw editor', () => {
  it('writes the typed document, applies it, and reports dropped keys', async () => {
    const { sync, appearance } = await load();
    sync.startUiSettingsSync();
    await settle();
    const ok = await sync.saveUiSettingsText('{"appearance":{"density":"compact","nope":1}}');
    expect(ok).toEqual({ ok: false, problems: ['unknown setting "appearance.nope"'] });
    expect(appearance.getAppearance().density).toBe('compact');
    expect(sync.currentUiSettingsText()).toContain('"density": "compact"');
  });

  it('refuses invalid JSON without touching the file', async () => {
    const { sync } = await load();
    sync.startUiSettingsSync();
    await settle();
    expect(await sync.saveUiSettingsText('{oops')).toEqual({ ok: false, problems: ['not valid JSON'] });
    expect(apiPut).not.toHaveBeenCalled();
  });
});
