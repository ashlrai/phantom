import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const root = document.documentElement;
const appearanceKey = 'ashlr.verse.appearance.v1';
const themeKey = 'ashlr.theme.v1';

beforeEach(() => {
  localStorage.clear();
  root.removeAttribute('data-theme');
  root.removeAttribute('data-density');
  root.removeAttribute('data-ui-scale');
  root.removeAttribute('style');
  vi.resetModules();
});

afterEach(() => { vi.unstubAllGlobals(); });

describe('appearance live application and reload', () => {
  it('applies and restores theme, accent, density and display size', async () => {
    const store = await import('./appearance-store.js');
    store.setAppearance({ theme: 'light' });
    expect(root.getAttribute('data-theme')).toBe('light');
    store.setAppearance({ theme: 'dark' });
    expect(root.getAttribute('data-theme')).toBe('dark');
    store.setAppearance({ accentH: 190, accentS: 80, accentL: 40 });
    expect(root.style.getPropertyValue('--accent-h')).toBe('190');
    expect(root.style.getPropertyValue('--accent-s')).toBe('80%');
    expect(root.style.getPropertyValue('--accent-l')).toBe('40%');
    store.setAppearance({ density: 'compact' });
    expect(root.getAttribute('data-density')).toBe('compact');
    store.setAppearance({ uiScale: 'large' });
    expect(root.getAttribute('data-ui-scale')).toBe('large');

    root.removeAttribute('style');
    root.removeAttribute('data-theme');
    root.removeAttribute('data-density');
    root.removeAttribute('data-ui-scale');
    vi.resetModules();
    const reloaded = await import('./appearance-store.js');
    expect(reloaded.getAppearance()).toMatchObject({ theme: 'dark', accentH: 190, accentS: 80, accentL: 40, density: 'compact', uiScale: 'large' });
    expect(root.getAttribute('data-theme')).toBe('dark');
    expect(root.style.getPropertyValue('--accent-h')).toBe('190');
    expect(root.style.getPropertyValue('--accent-s')).toBe('80%');
    expect(root.style.getPropertyValue('--accent-l')).toBe('40%');
    expect(root.getAttribute('data-density')).toBe('compact');
    expect(root.getAttribute('data-ui-scale')).toBe('large');
  });

  it('leaves system theme to the live CSS media query and restores it', async () => {
    const store = await import('./appearance-store.js');
    store.setAppearance({ theme: 'dark' });
    store.setAppearance({ theme: 'system' });
    expect(root.hasAttribute('data-theme')).toBe(false);
    vi.resetModules();
    const reloaded = await import('./appearance-store.js');
    expect(reloaded.getAppearance().theme).toBe('system');
    expect(root.hasAttribute('data-theme')).toBe(false);
    // jsdom does not evaluate media queries; verify the browser-owned rule.
    const css = readFileSync('src/web-ui/design/tokens.css', 'utf8');
    expect(css).toMatch(/@media\s*\(prefers-color-scheme:\s*dark\)\s*\{\s*:root:not\(\[data-theme="light"\]\)\s*\{\s*color-scheme:\s*dark/);
  });

  it('falls back for invalid fields and corrupt or legacy storage', async () => {
    localStorage.setItem(themeKey, 'invalid');
    localStorage.setItem(appearanceKey, JSON.stringify({ accentH: 'bad', accentS: null, accentL: {}, density: 'dense', uiScale: 'huge' }));
    let store = await import('./appearance-store.js');
    expect(store.getAppearance()).toMatchObject({ theme: 'system', accentH: 245, accentS: 72, accentL: 58, density: 'comfortable', uiScale: 'default' });
    expect(root.hasAttribute('data-theme')).toBe(false);
    expect(root.style.getPropertyValue('--accent-h')).toBe('245');
    expect(root.getAttribute('data-density')).toBe('comfortable');
    expect(root.getAttribute('data-ui-scale')).toBe('default');
    localStorage.setItem(appearanceKey, '{broken');
    vi.resetModules();
    store = await import('./appearance-store.js');
    expect(store.getAppearance()).toEqual(store.defaultAppearance());
    localStorage.setItem(appearanceKey, JSON.stringify({ reduceMotion: true }));
    vi.resetModules();
    store = await import('./appearance-store.js');
    expect(store.getAppearance()).toMatchObject({ accentH: 245, density: 'comfortable', uiScale: 'default', motion: 'system' });
  });
});
