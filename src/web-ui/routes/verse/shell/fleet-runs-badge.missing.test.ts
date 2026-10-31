import { act, renderHook } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { evictAll } from '../../../data/cache.js';
import { describeFleetRuns, fleetReadsFailingText, fleetRunsBadge, useFleetRunsBadge } from './fleet-runs-badge.js';

const response = { v: 1, workers: [{ job: 'fake-job' }], leaders: [], mergesLastHour: { count: 7 }, switches: [] };
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); evictAll(); });

it('hides a missing fleet even with public merges, and accepts healthy or degraded sources', () => {
  expect(fleetRunsBadge({ ...response, sources: { runsDir: 'missing' } })).toBeNull();
  for (const runsDir of ['ok', 'degraded']) {
    expect(fleetRunsBadge({ ...response, sources: { runsDir } })).toEqual({ workers: 1, merges: 7, switchesOn: [] });
  }
});

it('describes failed reads in whole minutes after the first minute', () => {
  const badge = fleetRunsBadge(response)!;
  expect(fleetReadsFailingText(badge)).toBeNull();
  for (const [staleSeconds, text] of [[59, null], [60, 'fleet reads failing 1 min'], [10_800, 'fleet reads failing 180 min']] as const) {
    const stale = { ...badge, staleSeconds };
    expect(fleetReadsFailingText(stale)).toBe(text);
    expect(describeFleetRuns(stale)).toBe(`1 worker running · 7 merged last hour${text ? ` · ${text}` : ''}`);
  }
});

it('ages the last successful read on failures and clears staleness on recovery', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
  const fetch = vi.fn().mockImplementation(async () => new Response(JSON.stringify(response)));
  vi.stubGlobal('fetch', fetch);
  const view = renderHook(() => useFleetRunsBadge());
  await act(async () => {});
  expect(view.result.current?.staleSeconds).toBeUndefined();
  fetch.mockRejectedValue(new Error('fake sidecar unavailable'));
  await act(async () => { await vi.advanceTimersByTimeAsync(180_000); });
  expect(view.result.current?.staleSeconds).toBe(180);
  expect(Object.keys(view.result.current!)).not.toContain('staleSeconds');
  expect(describeFleetRuns(view.result.current!)).toContain(' · fleet reads failing 3 min');
  fetch.mockImplementation(async () => new Response(JSON.stringify(response)));
  await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
  expect(view.result.current?.staleSeconds).toBeUndefined();
  fetch.mockImplementation(async () => new Response(JSON.stringify({ ...response, sources: { runsDir: 'missing' } })));
  await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
  expect(view.result.current).toBeNull();
  view.unmount();
});
