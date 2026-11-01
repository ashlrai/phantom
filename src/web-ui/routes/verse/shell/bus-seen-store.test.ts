import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { markSeen, readSeenCursor, subscribeSeenCursor } from './bus-seen-store.js';

beforeEach(() => localStorage.clear());
afterEach(() => { vi.restoreAllMocks(); localStorage.clear(); });

it('persists a monotonic cursor and notifies subscribers', () => {
  const notify = vi.fn();
  const unsubscribe = subscribeSeenCursor(notify);
  expect(readSeenCursor()).toBe(0);
  markSeen(8);
  expect(JSON.parse(localStorage.getItem('verse.bus.seen.v1')!)).toEqual({ cursor: 8 });
  expect(readSeenCursor()).toBe(8);
  markSeen(4);
  expect(readSeenCursor()).toBe(8);
  expect(notify).toHaveBeenCalledTimes(2);
  unsubscribe();
});

it.each(['{', '{"cursor":-1}', '{"cursor":"8"}', 'null'])('ignores corrupt storage: %s', raw => {
  localStorage.setItem('verse.bus.seen.v1', raw);
  expect(readSeenCursor()).toBe(0);
  markSeen(3);
  expect(readSeenCursor()).toBe(3);
});

it('responds to another window changing the cursor', () => {
  const notify = vi.fn();
  const unsubscribe = subscribeSeenCursor(notify);
  localStorage.setItem('verse.bus.seen.v1', JSON.stringify({ cursor: 9 }));
  window.dispatchEvent(new StorageEvent('storage', { key: 'verse.bus.seen.v1' }));
  expect(notify).toHaveBeenCalledOnce();
  expect(readSeenCursor()).toBe(9);
  unsubscribe();
});

it('keeps the cursor in memory if storage is blocked', () => {
  const get = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
  const set = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked'); });
  markSeen(12);
  expect(readSeenCursor()).toBe(12);
  get.mockRestore();
  set.mockRestore();
  markSeen(12);
});
