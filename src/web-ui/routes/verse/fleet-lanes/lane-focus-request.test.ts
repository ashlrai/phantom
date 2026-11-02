import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { requestLaneFocus, resetLaneFocus, subscribeLaneFocus, takeRequestedLane, useRequestedLane } from './lane-focus-request.js';

afterEach(() => { cleanup(); resetLaneFocus(); });

it('takes and clears a requested lane', () => {
  requestLaneFocus('devin');
  expect(takeRequestedLane()).toBe('devin');
  expect(takeRequestedLane()).toBeNull();
});

it('ignores invalid lane names without replacing a pending lane', () => {
  requestLaneFocus('devin');
  requestLaneFocus('../x');
  expect(takeRequestedLane()).toBe('devin');
  for (const bad of ['../x', 'Bad Lane', '-leading', 'a'.repeat(41), '']) {
    requestLaneFocus(bad);
    expect(takeRequestedLane()).toBeNull();
  }
});

it('notifies subscribers when the focus changes and stops after unsubscribe', () => {
  const listener = vi.fn();
  const unsubscribe = subscribeLaneFocus(listener);
  requestLaneFocus('devin');
  requestLaneFocus('../x');
  expect(listener).toHaveBeenCalledTimes(1);
  takeRequestedLane();
  expect(listener).toHaveBeenCalledTimes(2);
  unsubscribe();
  requestLaneFocus('devin');
  expect(listener).toHaveBeenCalledTimes(2);
});

it('exposes the pending lane to the hook', () => {
  const { result } = renderHook(() => useRequestedLane());
  expect(result.current).toBeNull();
  act(() => requestLaneFocus('devin'));
  expect(result.current).toBe('devin');
  act(() => { takeRequestedLane(); });
  expect(result.current).toBeNull();
});
