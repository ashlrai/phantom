import { act, renderHook } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { evictAll } from '../../../data/cache.js';
import { formatWindowTitle, useWindowTitle } from './window-title.js';

const badge = { workers: 1, merges: 7, switchesOn: [], paused: false, heldLanes: [] };
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); evictAll(); });

it('appends failed read age, including when paused or held', () => {
  expect(formatWindowTitle({ badge: { ...badge, staleSeconds: 59 } })).toBe('Phantom · 1 working · 7 merged/h');
  expect(formatWindowTitle({ badge: { ...badge, staleSeconds: 180 } })).toBe('Phantom · 1 working · 7 merged/h · fleet reads failing 3 min');
  expect(formatWindowTitle({ badge: { ...badge, paused: true, staleSeconds: 60 } })).toBe('Phantom · ⏸ paused · 1 working · fleet reads failing 1 min');
  const title = formatWindowTitle({ badge: { ...badge, heldLanes: ['x'.repeat(100)], staleSeconds: 10_800 } });
  expect(title).toHaveLength(80);
  expect(title.endsWith('… · fleet reads failing 180 min')).toBe(true);
});

it('updates the title on failures, recovery, and a fleet becoming missing', async () => {
  document.title = 'Previous';
  vi.useFakeTimers();
  const response = { v: 1, workers: [{ job: 'fake-job' }], leaders: [], mergesLastHour: { count: 7 }, switches: [] };
  const fetch = vi.fn().mockImplementation(async () => new Response(JSON.stringify(response)));
  vi.stubGlobal('fetch', fetch);
  const view = renderHook(() => useWindowTitle());
  await act(async () => {});
  expect(document.title).toBe('Phantom · 1 working · 7 merged/h');
  fetch.mockRejectedValue(new Error('fake sidecar unavailable'));
  await act(async () => { await vi.advanceTimersByTimeAsync(180_000); });
  expect(document.title).toBe('Phantom · 1 working · 7 merged/h · fleet reads failing 3 min');
  fetch.mockImplementation(async () => new Response(JSON.stringify(response)));
  await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
  expect(document.title).toBe('Phantom · 1 working · 7 merged/h');
  fetch.mockImplementation(async () => new Response(JSON.stringify({ ...response, sources: { runsDir: 'missing' } })));
  await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
  expect(document.title).toBe('Phantom');
  view.unmount();
  expect(document.title).toBe('Previous');
});
