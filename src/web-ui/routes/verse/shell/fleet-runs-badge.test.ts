import { createElement } from 'react';
import { act, render, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { evictAll, getQuerySnapshot } from '../../../data/cache.js';
import { describeRailCapacity, RailBadgeMark, railBadgeFor } from './RailStatus.js';
import { activity } from './shell-fixtures.test-support.js';
import { describeFleetRuns, fleetRunsBadge, useFleetRunsBadge } from './fleet-runs-badge.js';

const fixture = {
  v: 1, workers: [{ job: 'one' }, { job: 'two' }, { job: 'three' }],
  leaders: [{ name: 'leader' }], mergesLastHour: { count: 12 }, switches: ['HOLD'], sources: { workers: 'local' },
};
const runs = { workers: 3, merges: 12, switchesOn: ['HOLD'] };

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); evictAll(); });

describe('fleet runs badge', () => {
  it('validates the local wire contract and counts workers', () => {
    expect(fleetRunsBadge(fixture)).toEqual(runs);
    expect(fleetRunsBadge({ ...fixture, mergesLastHour: { count: null } })).toEqual({ ...runs, merges: null });
    for (const bad of [null, {}, { ...fixture, v: 2 }, { ...fixture, workers: [{}] },
      { ...fixture, mergesLastHour: { count: -1 } }, { ...fixture, switches: [1] }, { ...fixture, sources: { a: 1 } }]) {
      expect(fleetRunsBadge(bad)).toBeNull();
    }
  });

  it('describes known and unknown merges and switches', () => {
    expect(describeFleetRuns({ ...runs, switchesOn: [] })).toBe('3 workers running · 12 merged last hour');
    expect(describeFleetRuns({ ...runs, merges: null, switchesOn: [] })).toBe('3 workers running · merges unknown');
    expect(describeFleetRuns(runs)).toBe('3 workers running · 12 merged last hour · switches on: HOLD');
  });

  it('preserves autonomy and adds an accessible count and warning', () => {
    const autonomy = { mode: 'propose' as const, paused: false, stopped: false, label: 'Propose' };
    const data = activity({ autonomy });
    expect(railBadgeFor('fleet', data)).toEqual({ kind: 'autonomy', spoken: ', Propose', autonomy, tone: 'info' });
    expect(railBadgeFor('fleet', data, { ...runs, switchesOn: [] })).toEqual({
      kind: 'count', spoken: ', Propose, 3 workers running', autonomy, count: 3, tone: 'running',
    });
    const badge = railBadgeFor('fleet', data, runs)!;
    expect(badge.tone).toBe('warning');
    const { container } = render(createElement(RailBadgeMark, { badge }));
    expect(container.querySelector('[data-badge="autonomy"]')).not.toBeNull();
    expect(container.querySelector('[data-badge="count"]')).toHaveTextContent('3');
    expect(railBadgeFor('fleet', data, { ...runs, workers: 0, switchesOn: [] })?.kind).toBe('autonomy');
    expect(railBadgeFor('fleet', null, runs)?.spoken).toBe(', 3 workers running');
  });

  it('appends the fleet description to the capacity name', () => {
    expect(describeRailCapacity({ seatId: 'a', label: 'Seat', windowLabel: 'weekly', usedPercent: 50,
      limitReached: false, resetText: null, word: 'ok', runs }))
      .toBe('Seat: weekly 50% used · 3 workers running · 12 merged last hour · switches on: HOLD');
  });

  it('polls only while visible and refreshes after returning', async () => {
    let visibility: DocumentVisibilityState = 'visible';
    const spy = vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility);
    const fetch = vi.fn().mockImplementation(async () => new Response(JSON.stringify(fixture), { status: 200 }));
    vi.stubGlobal('fetch', fetch);
    vi.useFakeTimers();
    const view = renderHook(() => useFleetRunsBadge());
    await act(async () => {});
    expect(view.result.current).toEqual(runs);
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(fetch).toHaveBeenCalledTimes(2);
    visibility = 'hidden';
    act(() => document.dispatchEvent(new Event('visibilitychange')));
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(view.result.current).toEqual(runs);
    visibility = 'visible';
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
    expect(fetch).toHaveBeenCalledTimes(3);
    view.unmount();
    spy.mockRestore();
  });

  it('stops polling a missing route, including after remount and visibility changes', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response('{}', { status: 404 }));
    vi.stubGlobal('fetch', fetch);
    vi.useFakeTimers();
    const view = renderHook(() => useFleetRunsBadge());
    await act(async () => {});
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(getQuerySnapshot('verse-fleet-runs-badge').status).toBe('error');
    expect(view.result.current).toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    view.unmount();
    const again = renderHook(() => useFleetRunsBadge());
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); await vi.advanceTimersByTimeAsync(30_000); });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(again.result.current).toBeNull();
  });
});
