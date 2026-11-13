import { act, renderHook } from '@testing-library/react';
import { expect, it, vi } from 'vitest';

const bus = vi.hoisted(() => ({ event: undefined as (() => void) | undefined }));
vi.mock('../../data/sse.js', () => ({
  isSseLive: () => false,
  subscribeSseLive: () => () => {},
  onSseEvent: (_name: string, listener: () => void) => {
    bus.event = listener;
    return () => { bus.event = undefined; };
  },
}));
import { useLeaderThreadPush } from './leader/use-leader-thread-push.js';

it('uses the latest thread refetch after a render and stops on unmount', () => {
  const first = vi.fn();
  const latest = vi.fn();
  const { rerender, unmount } = renderHook(({ refetch }) => useLeaderThreadPush(refetch), {
    initialProps: { refetch: first },
  });
  rerender({ refetch: latest });
  act(() => bus.event?.());
  expect(first).not.toHaveBeenCalled();
  expect(latest).toHaveBeenCalledOnce();
  unmount();
  expect(bus.event).toBeUndefined();
});
