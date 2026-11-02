import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { evictAll } from '../../../data/cache.js';
import { readSelfUpdate, updateEntryLabel, useSelfUpdateBadge } from './self-update-badge.js';

const status = {
  v: 1 as const, generatedAt: 'now', sourceState: 'healthy' as const, installedVersion: '1.0.0', repoRoot: true,
  headSha: 'a'.repeat(40), headAt: 'now', originSha: 'b'.repeat(40), branch: 'master',
  behind: 2, ahead: 0, dirty: false, lastFetchAt: null, processStartedAt: 'now', uptimeSeconds: 1, pid: 42, canFastForward: true,
};

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); evictAll(); });

describe('self-update badge', () => {
  it('strictly narrows the response while tolerating extra fields and nullable values', () => {
    expect(readSelfUpdate({ ...status, extra: 1 })).toEqual({ ...status, extra: 1 });
    expect(readSelfUpdate({ ...status, installedVersion: null, headSha: null, headAt: null, originSha: null,
      branch: null, behind: null, ahead: null, dirty: null, canFastForward: null })).not.toBeNull();
    for (const bad of [null, [], {}, { ...status, v: 2 }, { ...status, generatedAt: null },
      { ...status, sourceState: 'other' }, { ...status, installedVersion: 1 }, { ...status, repoRoot: null },
      { ...status, headSha: 1 }, { ...status, headAt: false }, { ...status, originSha: [] }, { ...status, branch: {} },
      { ...status, behind: -1 }, { ...status, behind: 1.5 }, { ...status, ahead: '0' }, { ...status, dirty: 0 },
      { ...status, lastFetchAt: false }, { ...status, processStartedAt: null }, { ...status, uptimeSeconds: NaN },
      { ...status, pid: null }, { ...status, canFastForward: 'true' }]) expect(readSelfUpdate(bad)).toBeNull();
  });

  it('labels singular, plural and unknown commit counts', () => {
    expect(updateEntryLabel({ ...status, behind: 1 })).toBe('Update available · 1 commit behind');
    expect(updateEntryLabel({ ...status, behind: 3 })).toBe('Update available · 3 commits behind');
    expect(updateEntryLabel({ ...status, behind: null })).toBe('Update available');
  });

  it.each([
    [{ ...status, behind: null, dirty: true }, true],
    [{ ...status, canFastForward: false, behind: 2, dirty: false }, true],
    [{ ...status, canFastForward: false, behind: 2, dirty: true }, false],
    [{ ...status, canFastForward: false, behind: 0 }, false],
    [{ ...status, sourceState: 'unavailable' as const }, false],
  ])('applies the availability rule', (value, shown) => {
    expect(updateEntryLabel(value) !== null).toBe(shown);
  });

  it('polls every five minutes only while visible and refreshes on return', async () => {
    let visibility: DocumentVisibilityState = 'visible';
    vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility);
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify(status), { status: 200 }));
    vi.stubGlobal('fetch', fetch); vi.useFakeTimers();
    const view = renderHook(() => useSelfUpdateBadge());
    await act(async () => {});
    expect(view.result.current).toEqual({ label: 'Update available · 2 commits behind' });
    await act(async () => { await vi.advanceTimersByTimeAsync(299_999); });
    expect(fetch).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(fetch).toHaveBeenCalledTimes(2);
    visibility = 'hidden'; act(() => document.dispatchEvent(new Event('visibilitychange')));
    await act(async () => { await vi.advanceTimersByTimeAsync(600_000); });
    expect(fetch).toHaveBeenCalledTimes(2);
    visibility = 'visible'; await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
    expect(fetch).toHaveBeenCalledTimes(3);
    view.unmount();
  });

  it('remembers a 404 across polling and remounts', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response('{}', { status: 404 }));
    vi.stubGlobal('fetch', fetch); vi.useFakeTimers();
    const view = renderHook(() => useSelfUpdateBadge());
    await act(async () => {}); expect(view.result.current).toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(600_000); });
    view.unmount();
    const again = renderHook(() => useSelfUpdateBadge());
    await act(async () => { await vi.advanceTimersByTimeAsync(600_000); });
    expect(fetch).toHaveBeenCalledTimes(1); expect(again.result.current).toBeNull();
    again.unmount();
  });
});
