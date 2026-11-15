import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FEED_SEEN_STORAGE_KEY, countNew, firstOlderIndex, markSeen, readStored, resetFeedSeen, useFeedSeen } from './feed-seen-store.js';

// Newest first.
const items = ['2026-01-03T00:00:00.000Z', '2026-01-02T00:00:00.000Z', '2026-01-01T00:00:00.000Z'].map(at => ({ at }));

beforeEach(() => { localStorage.clear(); resetFeedSeen(); });
afterEach(() => { vi.restoreAllMocks(); });

describe('countNew / firstOlderIndex', () => {
  it('counts nothing when seenAt is null or unparseable', () => {
    for (const seen of [null, 'not a date', '']) {
      expect(countNew(items, seen)).toBe(0);
    }
    expect(firstOlderIndex(items, null)).toBe(0);
    expect(firstOlderIndex([], null)).toBe(-1);
  });

  it('counts every item when seenAt is before all', () => {
    expect(countNew(items, '2025-12-31T00:00:00.000Z')).toBe(3);
    expect(firstOlderIndex(items, '2025-12-31T00:00:00.000Z')).toBe(-1);
  });

  it('splits at seenAt', () => {
    expect(countNew(items, '2026-01-01T12:00:00.000Z')).toBe(2);
    expect(firstOlderIndex(items, '2026-01-01T12:00:00.000Z')).toBe(2);
  });

  it('treats an item at exactly seenAt as seen', () => {
    expect(countNew(items, '2026-01-02T00:00:00.000Z')).toBe(1);
    expect(firstOlderIndex(items, '2026-01-02T00:00:00.000Z')).toBe(1);
  });

  it('counts nothing when seenAt is after all', () => {
    expect(countNew(items, '2026-02-01T00:00:00.000Z')).toBe(0);
    expect(firstOlderIndex(items, '2026-02-01T00:00:00.000Z')).toBe(0);
  });
});

describe('markSeen', () => {
  it('persists and never moves backwards', () => {
    markSeen('2026-01-02T00:00:00.000Z');
    markSeen('2026-01-01T00:00:00.000Z');
    markSeen('garbage');
    expect(readStored()).toBe('2026-01-02T00:00:00.000Z');
    expect(JSON.parse(localStorage.getItem(FEED_SEEN_STORAGE_KEY)!)).toBe('2026-01-02T00:00:00.000Z');
    markSeen('2026-01-03T00:00:00.000Z');
    expect(readStored()).toBe('2026-01-03T00:00:00.000Z');
  });

  it('reads corrupt stored JSON as unset', () => {
    for (const raw of ['{nope', '42', '"not a date"', 'null']) {
      localStorage.setItem(FEED_SEEN_STORAGE_KEY, raw); resetFeedSeen();
      expect(readStored()).toBeNull();
    }
  });
});

describe('useFeedSeen', () => {
  it('stamps now on a first launch', () => {
    const before = Date.now();
    const { result } = renderHook(() => useFeedSeen());
    expect(Date.parse(result.current.seenAt!)).toBeGreaterThanOrEqual(before);
  });

  it('keeps a stored time and follows markSeen', () => {
    localStorage.setItem(FEED_SEEN_STORAGE_KEY, JSON.stringify('2026-01-01T00:00:00.000Z'));
    const { result } = renderHook(() => useFeedSeen());
    expect(result.current.seenAt).toBe('2026-01-01T00:00:00.000Z');
    act(() => result.current.markSeen('2026-01-02T00:00:00.000Z'));
    expect(result.current.seenAt).toBe('2026-01-02T00:00:00.000Z');
  });

  it('still works in memory when storage throws', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('denied'); });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('denied'); });
    const { result } = renderHook(() => useFeedSeen());
    expect(result.current.seenAt).not.toBeNull();
    act(() => result.current.markSeen('2999-01-01T00:00:00.000Z'));
    expect(result.current.seenAt).toBe('2999-01-01T00:00:00.000Z');
  });

  it('follows a change from another window', () => {
    const { result } = renderHook(() => useFeedSeen());
    act(() => {
      localStorage.setItem(FEED_SEEN_STORAGE_KEY, JSON.stringify('2999-06-01T00:00:00.000Z'));
      window.dispatchEvent(new StorageEvent('storage', { key: FEED_SEEN_STORAGE_KEY }));
    });
    expect(result.current.seenAt).toBe('2999-06-01T00:00:00.000Z');
  });
});
