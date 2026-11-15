import { describe, expect, it } from 'vitest';
import { formatMobileHash, parseMobileHash, tabOf } from './mobile-router.js';

describe('goals and ideas routes', () => {
  it.each(['goals', 'ideas'] as const)('#/%s parses and formats back', (screen) => {
    const route = { screen } as const;
    expect(formatMobileHash(route)).toBe(`#/${screen}`);
    expect(parseMobileHash(formatMobileHash(route))).toEqual(route);
  });

  it.each(['goals', 'ideas'] as const)('tabOf(#/%s) is the More tab', (screen) => {
    expect(tabOf({ screen })).toBe('more');
  });
});
