import { describe, expect, it } from 'vitest';
import { formatMobileHash, parseMobileHash, tabOf } from './mobile-router.js';

describe('worker routes', () => {
  it('round trips a worker and selects More', () => {
    const route = { screen: 'worker', job: 'RQ-FAKE_31.0' } as const;
    expect(formatMobileHash(route)).toBe('#/workers/RQ-FAKE_31.0');
    expect(parseMobileHash(formatMobileHash(route))).toEqual(route);
    expect(tabOf(route)).toBe('more');
  });
  it.each(['', 'ab', '%', '..%2Ffake', 'fake%2Fjob', 'fake/extra', 'x'.repeat(81)])('rejects invalid job %s', (job) => {
    expect(parseMobileHash(`#/workers/${job}`)).toEqual({ screen: 'runs' });
  });
  it('does not format invalid worker ids as worker routes', () => {
    expect(formatMobileHash({ screen: 'worker', job: '../fake' })).toBe('#/runs');
  });
});
