import { describe, expect, it, vi } from 'vitest';
import { applyAppBadge } from './app-badge.js';

describe('applyAppBadge', () => {
  it('sets the count, clears zero, and leaves an unknown count alone', () => {
    const nav = { setAppBadge: vi.fn(async () => undefined), clearAppBadge: vi.fn(async () => undefined) };
    expect(applyAppBadge(nav, 3)).toBe('set');
    expect(nav.setAppBadge).toHaveBeenCalledWith(3);
    expect(applyAppBadge(nav, 0)).toBe('cleared');
    expect(nav.clearAppBadge).toHaveBeenCalledOnce();
    expect(nav.setAppBadge).toHaveBeenCalledOnce();
    expect(applyAppBadge(nav, null)).toBe('skipped');
    expect(nav.clearAppBadge).toHaveBeenCalledOnce();
    expect(nav.setAppBadge).toHaveBeenCalledOnce();
  });

  it('falls back to setting zero when clearAppBadge is absent', () => {
    const nav = { setAppBadge: vi.fn(async () => undefined) };
    expect(applyAppBadge(nav, 0)).toBe('cleared');
    expect(nav.setAppBadge).toHaveBeenCalledWith(0);
  });

  it('reports unsupported navigators', () => {
    expect(applyAppBadge({}, 3)).toBe('unsupported');
    expect(applyAppBadge(undefined, null)).toBe('unsupported');
  });

  it('swallows rejected badge promises', async () => {
    const nav = { setAppBadge: vi.fn(async () => { throw new Error('unavailable'); }) };
    expect(applyAppBadge(nav, 3)).toBe('set');
    await Promise.resolve();
  });
});
