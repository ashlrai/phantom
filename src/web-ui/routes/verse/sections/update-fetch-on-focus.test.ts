import { afterEach, describe, expect, it, vi } from 'vitest';
import { readLastFetchAt, shouldFetchOnFocus, writeLastFetchAt } from './update-fetch-on-focus.js';

const now = 2_000_000;
const ready = { lastFetchAt: null, now, visible: true, hasToken: true, routeAvailable: true };
describe('shouldFetchOnFocus', () => {
  it.each([
    ['hidden', { visible: false }, false],
    ['locked', { hasToken: false }, false],
    ['missing route', { routeAvailable: false }, false],
    ['five minutes ago', { lastFetchAt: now - 5 * 60_000 }, false],
    ['31 minutes ago', { lastFetchAt: now - 31 * 60_000 }, true],
    ['never', {}, true],
    ['exact interval', { lastFetchAt: now - 30 * 60_000 }, true],
  ])('%s', (_name, overrides, expected) => {
    expect(shouldFetchOnFocus({ ...ready, ...overrides })).toBe(expected);
  });
});

describe('fetch timestamp storage', () => {
  afterEach(() => { vi.unstubAllGlobals(); sessionStorage.clear(); });
  it('round-trips a timestamp and ignores invalid values', () => {
    writeLastFetchAt(now);
    expect(readLastFetchAt()).toBe(now);
    sessionStorage.setItem('ashlr.verse.update-fetch.last', 'invalid');
    expect(readLastFetchAt()).toBeNull();
  });
  it('tolerates unavailable storage', () => {
    vi.stubGlobal('sessionStorage', { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } });
    expect(readLastFetchAt()).toBeNull();
    expect(() => writeLastFetchAt(now)).not.toThrow();
  });
});
