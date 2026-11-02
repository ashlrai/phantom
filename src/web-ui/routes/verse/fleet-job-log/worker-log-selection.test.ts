import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { requestWorkerLogJob, resetWorkerLogSelection, subscribeWorkerLogSelection, takeRequestedWorkerLogJob, useRequestedWorkerLogJob } from './worker-log-selection.js';

afterEach(() => { cleanup(); resetWorkerLogSelection(); });

it('takes and clears a requested job', () => {
  requestWorkerLogJob('RQ-PHX-EXAMPLE1');
  expect(takeRequestedWorkerLogJob()).toBe('RQ-PHX-EXAMPLE1');
  expect(takeRequestedWorkerLogJob()).toBeNull();
});

it('ignores invalid IDs without replacing a pending job', () => {
  requestWorkerLogJob('RQ-PHX-EXAMPLE1');
  requestWorkerLogJob('../bad');
  expect(takeRequestedWorkerLogJob()).toBe('RQ-PHX-EXAMPLE1');
  requestWorkerLogJob('../bad');
  expect(takeRequestedWorkerLogJob()).toBeNull();
});

it('notifies subscribers when the selection changes and stops after unsubscribe', () => {
  const listener = vi.fn();
  const unsubscribe = subscribeWorkerLogSelection(listener);
  requestWorkerLogJob('RQ-PHX-EXAMPLE1');
  requestWorkerLogJob('../bad');
  expect(listener).toHaveBeenCalledTimes(1);
  takeRequestedWorkerLogJob();
  expect(listener).toHaveBeenCalledTimes(2);
  unsubscribe();
  requestWorkerLogJob('RQ-PHX-EXAMPLE1');
  expect(listener).toHaveBeenCalledTimes(2);
});

it('exposes the pending job to the hook', () => {
  const { result } = renderHook(() => useRequestedWorkerLogJob());
  expect(result.current).toBeNull();
  act(() => requestWorkerLogJob('RQ-PHX-EXAMPLE1'));
  expect(result.current).toBe('RQ-PHX-EXAMPLE1');
  act(() => { takeRequestedWorkerLogJob(); });
  expect(result.current).toBeNull();
});
