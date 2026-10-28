import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

beforeEach(() => { localStorage.clear(); vi.resetModules(); });
afterEach(() => { vi.restoreAllMocks(); });

describe('theme persistence', () => {
  it.each(['system', 'light', 'dark', 'high-contrast'] as const)('restores %s after a reload', async (theme) => {
    const store = await import('./theme-store.js');
    store.setTheme(theme);
    vi.resetModules();
    const reloaded = await import('./theme-store.js');
    expect(reloaded.getTheme()).toBe(theme);
    expect(document.documentElement.getAttribute('data-theme')).toBe(theme === 'system' ? null : theme);
  });

  it('cycles through every theme and notifies subscribers', async () => {
    const store = await import('./theme-store.js');
    const listener = vi.fn();
    const unsubscribe = store.subscribeTheme(listener);
    for (const theme of ['light', 'dark', 'high-contrast', 'system']) {
      store.cycleTheme();
      expect(store.getTheme()).toBe(theme);
    }
    expect(listener).toHaveBeenCalledTimes(4);
    unsubscribe();
    store.cycleTheme();
    expect(listener).toHaveBeenCalledTimes(4);
  });

  it('falls back for corrupt storage and works when persistence is blocked', async () => {
    localStorage.setItem('ashlr.theme.v1', 'invalid');
    const store = await import('./theme-store.js');
    expect(store.getTheme()).toBe('system');
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked'); });
    expect(() => store.setTheme('high-contrast')).not.toThrow();
    expect(store.getTheme()).toBe('high-contrast');
  });
});

it('restores compact layout alongside high contrast before rendering', async () => {
  const { setAppearance } = await import('./appearance-store.js');
  setAppearance({ theme: 'high-contrast', density: 'compact' });
  document.documentElement.removeAttribute('data-density');
  vi.resetModules();
  await import('./appearance-boot.js');
  const { getAppearance } = await import('./appearance-store.js');
  expect(getAppearance().theme).toBe('high-contrast');
  expect(getAppearance().density).toBe('compact');
  expect(document.documentElement.getAttribute('data-density')).toBe('compact');
});
