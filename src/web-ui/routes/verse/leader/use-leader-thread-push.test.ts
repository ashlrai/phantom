import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const bus = vi.hoisted(() => {
  const state = { live: false, event: new Set<() => void>(), status: new Set<() => void>() };
  return state;
});

vi.mock('../../../data/sse.js', () => ({
  isSseLive: () => bus.live,
  subscribeSseLive: (l: () => void) => { bus.status.add(l); return () => bus.status.delete(l); },
  onSseEvent: (_name: string, l: () => void) => { bus.event.add(l); return () => bus.event.delete(l); },
}));

import { useLeaderThreadPush } from './use-leader-thread-push.js';

const setLive = (live: boolean) => act(() => { bus.live = live; for (const l of [...bus.status]) l(); });

describe('useLeaderThreadPush', () => {
  beforeEach(() => { bus.live = false; bus.event.clear(); bus.status.clear(); });

  it('refetches once per leader-thread event', () => {
    const refetch = vi.fn();
    renderHook(() => useLeaderThreadPush(refetch));
    act(() => { for (const l of [...bus.event]) l(); });
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it('reports live=false once the stream closes', () => {
    const { result } = renderHook(() => useLeaderThreadPush(vi.fn()));
    expect(result.current.live).toBe(false);
    setLive(true);
    expect(result.current.live).toBe(true);
    setLive(false);
    expect(result.current.live).toBe(false);
  });

  it('catches up when the stream opens, and unsubscribes on unmount', () => {
    const refetch = vi.fn();
    const { unmount } = renderHook(() => useLeaderThreadPush(refetch));
    setLive(true);
    expect(refetch).toHaveBeenCalledTimes(1);
    unmount();
    expect(bus.event.size).toBe(0);
    expect(bus.status.size).toBe(0);
  });
});
