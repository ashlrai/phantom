import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { LAST_SEEN_STORAGE_KEY, markSeen, readLastSeen, resetLastSeen, useMarkSeenWhileViewing, useUnreadTitle } from './last-seen-store.js';

const NOW = 1_700_000_000_000;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  localStorage.clear();
  resetLastSeen();
});
afterEach(() => { vi.useRealTimers(); localStorage.clear(); resetLastSeen(); });

describe('last-seen store', () => {
  it('reads a fresh profile as now', () => {
    expect(readLastSeen()).toEqual({ leader: NOW, feed: NOW });
  });

  it.each(['{not json', '"text"', 'null', '{"leader":"x","feed":-5}'])('reads bad data %s as now', (raw) => {
    localStorage.setItem(LAST_SEEN_STORAGE_KEY, raw);
    expect(readLastSeen()).toEqual({ leader: NOW, feed: NOW });
  });

  it('keeps a good stored time and defaults only the bad one', () => {
    localStorage.setItem(LAST_SEEN_STORAGE_KEY, JSON.stringify({ leader: 5, feed: 'x' }));
    expect(readLastSeen()).toEqual({ leader: 5, feed: NOW });
  });

  it('marking feed does not move leader, persists, and never goes backwards', () => {
    localStorage.setItem(LAST_SEEN_STORAGE_KEY, JSON.stringify({ leader: 10, feed: 20 }));
    markSeen('feed', 30);
    expect(readLastSeen()).toEqual({ leader: 10, feed: 30 });
    markSeen('feed', 25);
    expect(readLastSeen().feed).toBe(30);
    expect(JSON.parse(localStorage.getItem(LAST_SEEN_STORAGE_KEY)!)).toEqual({ leader: 10, feed: 30 });
  });

  it('survives storage that throws', () => {
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('private mode'); });
    markSeen('leader', NOW + 5);
    expect(readLastSeen().leader).toBe(NOW + 5);
    spy.mockRestore();
  });
});

describe('useMarkSeenWhileViewing', () => {
  it('marks the viewed view seen only, including a newer item', () => {
    localStorage.setItem(LAST_SEEN_STORAGE_KEY, JSON.stringify({ leader: 1, feed: 1 }));
    resetLastSeen();
    renderHook(() => useMarkSeenWhileViewing('leader', NOW + 50));
    expect(readLastSeen()).toEqual({ leader: NOW + 50, feed: 1 });
  });

  it('marks nothing when no home view is showing', () => {
    localStorage.setItem(LAST_SEEN_STORAGE_KEY, JSON.stringify({ leader: 1, feed: 1 }));
    resetLastSeen();
    renderHook(() => useMarkSeenWhileViewing(null, NOW));
    expect(readLastSeen()).toEqual({ leader: 1, feed: 1 });
  });

  it('marks nothing while the document is hidden', () => {
    localStorage.setItem(LAST_SEEN_STORAGE_KEY, JSON.stringify({ leader: 1, feed: 1 }));
    resetLastSeen();
    const spy = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    renderHook(() => useMarkSeenWhileViewing('feed', NOW));
    expect(readLastSeen().feed).toBe(1);
    spy.mockRestore();
  });
});

describe('useUnreadTitle', () => {
  it('shows (N) Phantom and returns to the original title at 0', () => {
    document.title = 'Original';
    const { rerender } = renderHook(({ n }) => useUnreadTitle(n), { initialProps: { n: 4 } });
    expect(document.title).toBe('(4) Phantom');
    act(() => rerender({ n: 2 }));
    expect(document.title).toBe('(2) Phantom');
    act(() => rerender({ n: 0 }));
    expect(document.title).toBe('Original');
  });
});
