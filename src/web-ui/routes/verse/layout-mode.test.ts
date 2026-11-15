import { describe, expect, it } from 'vitest';
import { isLayoutPreference, NARROW_BELOW_PX, resolveLayout } from './layout-mode.js';

describe('resolveLayout', () => {
  it('auto is narrow under 960px and wide from 960px (the 959/960 boundary)', () => {
    expect(NARROW_BELOW_PX).toBe(960);
    expect(resolveLayout('auto', 959)).toBe('narrow');
    expect(resolveLayout('auto', 960)).toBe('wide');
    expect(resolveLayout('auto', 959.5)).toBe('narrow');
  });

  it('auto follows the width at the extremes', () => {
    expect(resolveLayout('auto', 0)).toBe('narrow');
    expect(resolveLayout('auto', 375)).toBe('narrow');
    expect(resolveLayout('auto', 1400)).toBe('wide');
  });

  it('narrow wins at any width', () => {
    expect(resolveLayout('narrow', 2560)).toBe('narrow');
    expect(resolveLayout('narrow', 960)).toBe('narrow');
  });

  it('wide wins at any width', () => {
    expect(resolveLayout('wide', 320)).toBe('wide');
    expect(resolveLayout('wide', 959)).toBe('wide');
  });

  it('only accepts the three preferences', () => {
    for (const ok of ['auto', 'wide', 'narrow']) expect(isLayoutPreference(ok)).toBe(true);
    for (const bad of ['', 'compact', 'NARROW', null, undefined, 1]) expect(isLayoutPreference(bad)).toBe(false);
  });
});
