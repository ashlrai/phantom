import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { requestInboxChannel, subscribeInboxChannelRequest, takeRequestedInboxChannel, useRequestedInboxChannel } from './inbox-source-request.js';

afterEach(() => { cleanup(); takeRequestedInboxChannel(); });

it('takes the latest request once, including other', () => {
  requestInboxChannel('telegram');
  requestInboxChannel('other');
  expect(takeRequestedInboxChannel()).toBe('other');
  expect(takeRequestedInboxChannel()).toBeNull();
});

it('notifies only on changes and unsubscribes', () => {
  const listener = vi.fn();
  const unsubscribe = subscribeInboxChannelRequest(listener);
  requestInboxChannel('telegram');
  requestInboxChannel('telegram');
  expect(listener).toHaveBeenCalledTimes(1);
  takeRequestedInboxChannel();
  expect(listener).toHaveBeenCalledTimes(2);
  unsubscribe();
  requestInboxChannel('desktop');
  expect(listener).toHaveBeenCalledTimes(2);
});

it('exposes requests and consumption to the hook', () => {
  const { result } = renderHook(() => useRequestedInboxChannel());
  expect(result.current).toBeNull();
  act(() => requestInboxChannel('telegram'));
  expect(result.current).toBe('telegram');
  act(() => { takeRequestedInboxChannel(); });
  expect(result.current).toBeNull();
});
