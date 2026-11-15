/**
 * The Layout preference: default, live apply, persistence, and migration of a
 * blob stored before the field existed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { APPEARANCE_STORAGE_KEY, defaultAppearance, getAppearance, resetAppearance, setAppearance } from './appearance-store.js';
import { isDefaultAppearance } from './appearance-presets.js';
import { bootAppearance } from './appearance-boot.js';

const attr = () => document.documentElement.getAttribute('data-layout-pref');
const stored = () => JSON.parse(localStorage.getItem(APPEARANCE_STORAGE_KEY) ?? '{}') as Record<string, unknown>;

describe('appearance layout', () => {
  beforeEach(() => {
    localStorage.clear();
    resetAppearance();
  });
  afterEach(() => {
    vi.resetModules();
    localStorage.clear();
    resetAppearance();
  });

  it('defaults to auto and applies it to <html>', () => {
    expect(defaultAppearance().layout).toBe('auto');
    expect(getAppearance().layout).toBe('auto');
    expect(attr()).toBe('auto');
  });

  it('applies a change live and persists it', () => {
    setAppearance({ layout: 'narrow' });
    expect(getAppearance().layout).toBe('narrow');
    expect(attr()).toBe('narrow');
    expect(stored().layout).toBe('narrow');
    expect(isDefaultAppearance()).toBe(false);
    setAppearance({ layout: 'auto' });
    expect(isDefaultAppearance()).toBe(true);
  });

  it('coerces an unknown value to auto', () => {
    setAppearance({ layout: 'sideways' as never });
    expect(getAppearance().layout).toBe('auto');
  });

  it('reset restores auto and clears the stored blob', () => {
    setAppearance({ layout: 'wide' });
    resetAppearance();
    expect(getAppearance().layout).toBe('auto');
    expect(attr()).toBe('auto');
    expect(localStorage.getItem(APPEARANCE_STORAGE_KEY)).toBeNull();
  });

  it('loads a stored layout on a fresh module instance', async () => {
    localStorage.setItem(APPEARANCE_STORAGE_KEY, JSON.stringify({ layout: 'wide', density: 'compact' }));
    vi.resetModules();
    const fresh = await import('./appearance-store.js');
    expect(fresh.getAppearance().layout).toBe('wide');
    expect(fresh.getAppearance().density).toBe('compact');
    expect(attr()).toBe('wide');
  });

  it('migrates an old stored blob with no layout field to auto, keeping its other values', async () => {
    localStorage.setItem(APPEARANCE_STORAGE_KEY, JSON.stringify({ accentH: 100, density: 'compact', uiScale: 'large', displayFont: 'mono', radius: 'soft', motion: 'reduce' }));
    vi.resetModules();
    const fresh = await import('./appearance-store.js');
    const a = fresh.getAppearance();
    expect(a.layout).toBe('auto');
    expect([a.accentH, a.density, a.uiScale, a.displayFont, a.radius, a.motion]).toEqual([100, 'compact', 'large', 'mono', 'soft', 'reduce']);
    // The next write stores the migrated field.
    fresh.setAppearance({ density: 'comfortable' });
    expect(stored().layout).toBe('auto');
  });

  it('boots the attribute from storage before React, defaulting to auto', () => {
    localStorage.setItem(APPEARANCE_STORAGE_KEY, JSON.stringify({ layout: 'narrow' }));
    bootAppearance();
    expect(attr()).toBe('narrow');
    localStorage.setItem(APPEARANCE_STORAGE_KEY, JSON.stringify({ density: 'compact' }));
    bootAppearance();
    expect(attr()).toBe('auto');
    localStorage.setItem(APPEARANCE_STORAGE_KEY, JSON.stringify({ layout: 'bogus' }));
    bootAppearance();
    expect(attr()).toBe('auto');
  });
});
