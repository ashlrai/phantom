import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resetDesktopUpdatesForTests, type DesktopUpdateState } from '../../../app/desktop-updates.js';
import { evictAll } from '../../../data/cache.js';
import { nativeUpdateLabel, useSelfUpdateBadge } from './self-update-badge.js';

const state: DesktopUpdateState = { phase: 'idle', enabled: true, version: '3.30.1', bytesReceived: 42, bytesTotal: 100, reason: null };
const git = { v: 1, generatedAt: 'now', sourceState: 'healthy', installedVersion: '3.30.0', repoRoot: true,
  headSha: null, headAt: null, originSha: null, branch: null, behind: 2, ahead: 0, dirty: false,
  lastFetchAt: null, processStartedAt: 'now', uptimeSeconds: 1, pid: 42, canFastForward: true };
const publish = (next: DesktopUpdateState) => act(() => window.dispatchEvent(new CustomEvent('ashlr:update-state', { detail: next })));

afterEach(() => { resetDesktopUpdatesForTests(); vi.unstubAllGlobals(); evictAll(); });

describe('native update badge', () => {
  it.each<[DesktopUpdateState['phase'], string | null]>([
    ['uncommissioned', null], ['disabled', null], ['checking', null], ['idle', null],
    ['available', 'Phantom 3.30.1 available'], ['downloading', 'Downloading Phantom 3.30.1 · 42%'],
    ['staged', 'Phantom 3.30.1 ready · installs when idle'],
    ['waiting-for-idle', 'Phantom 3.30.1 ready · installs when idle'],
    ['waiting-for-app-quit', 'Phantom 3.30.1 ready · installs when idle'],
    ['adoption-held', 'Update held · open Settings'], ['installing', 'Installing Phantom 3.30.1…'],
    ['installed', 'Phantom 3.30.1 installed · restarts when idle'], ['current', null],
    ['failed', 'Update failed · open Settings'],
  ])('labels phase %s', (phase, label) => expect(nativeUpdateLabel({ ...state, phase })).toBe(label));

  it('rounds progress and omits it without a positive total', () => {
    expect(nativeUpdateLabel({ ...state, phase: 'downloading', bytesReceived: 2, bytesTotal: 3 })).toBe('Downloading Phantom 3.30.1 · 67%');
    expect(nativeUpdateLabel({ ...state, phase: 'downloading', bytesTotal: null })).toBe('Downloading Phantom 3.30.1');
    expect(nativeUpdateLabel({ ...state, phase: 'downloading', bytesTotal: 0 })).toBe('Downloading Phantom 3.30.1');
  });

  it.each<[DesktopUpdateState['phase'], string]>([
    ['available', 'update available'], ['downloading', 'Downloading update · 42%'],
    ['staged', 'update ready · installs when idle'], ['installing', 'Installing update…'],
    ['installed', 'update installed · restarts when idle'],
  ])('uses the version fallback for %s', (phase, label) => expect(nativeUpdateLabel({ ...state, phase, version: null })).toBe(label));

  it('prefers native updates and returns to git when the native state is idle', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(git))));
    const view = renderHook(() => useSelfUpdateBadge());
    await waitFor(() => expect(view.result.current?.label).toBe('Update available · 2 commits behind'));
    publish({ ...state, phase: 'staged' });
    expect(view.result.current?.label).toBe('Phantom 3.30.1 ready · installs when idle');
    publish(state);
    expect(view.result.current?.label).toBe('Update available · 2 commits behind');
    view.unmount();
  });

  it('shows native updates after the git endpoint returns 404 and stays quiet when both are absent', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response('{}', { status: 404 }));
    vi.stubGlobal('fetch', fetch);
    const view = renderHook(() => useSelfUpdateBadge());
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    await act(async () => {});
    expect(view.result.current).toBeNull();
    publish({ ...state, phase: 'downloading' });
    expect(view.result.current?.label).toBe('Downloading Phantom 3.30.1 · 42%');
    view.unmount();
    const again = renderHook(() => useSelfUpdateBadge());
    await act(async () => {});
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(again.result.current?.label).toBe('Downloading Phantom 3.30.1 · 42%');
    again.unmount();
  });
});
