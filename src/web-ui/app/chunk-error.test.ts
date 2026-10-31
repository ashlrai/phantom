import { describe, expect, it, vi } from 'vitest';
import { isChunkLoadError, subscribeChunkErrors } from './chunk-error.js';

describe('chunk errors', () => {
  it.each([
    [new TypeError('Failed to fetch dynamically imported module: /old.js'), true],
    [new TypeError('Importing a module script failed.'), true],
    [{ message: 'ERROR LOADING DYNAMICALLY IMPORTED MODULE' }, true],
    ['Failed to fetch dynamically imported module', true],
    [new Error('Failed to fetch'), false],
    [{ message: 42 }, false], [null, false], [undefined, false],
  ])('recognizes %s: %s', (error, expected) => {
    expect(isChunkLoadError(error)).toBe(expected);
  });

  it('handles preload errors and matching rejections and unsubscribes', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeChunkErrors(listener);
    const preload = new Event('vite:preloadError', { cancelable: true });
    window.dispatchEvent(preload);
    expect(preload.defaultPrevented).toBe(true);
    const rejection = (reason: unknown) => Object.assign(new Event('unhandledrejection'), { reason });
    window.dispatchEvent(rejection(new Error('unrelated')));
    expect(listener).toHaveBeenCalledTimes(1);
    window.dispatchEvent(rejection(new Error('Importing a module script failed')));
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
    const after = new Event('vite:preloadError', { cancelable: true });
    window.dispatchEvent(after);
    window.dispatchEvent(rejection(new Error('Importing a module script failed')));
    expect(after.defaultPrevented).toBe(false);
    expect(listener).toHaveBeenCalledTimes(2);
  });
});
