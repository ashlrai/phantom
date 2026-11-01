import { act, cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ToastProvider } from '../../../components/primitives/Toast.js';
import { evictAll } from '../../../data/cache.js';
import { setMutationToken } from '../../../data/auth-store.js';
import { useAutoSelfUpdate } from './useAutoSelfUpdate.js';
import { writeAutoUpdatePolicy } from './update-auto-model.js';
function Runner() { useAutoSelfUpdate(); return null; }
beforeEach(() => { evictAll(); localStorage.clear(); setMutationToken('fake-test-token'); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers(); });
it.each(['quiet', 'young', 'off', 'applying'])('automatic apply: %s', async mode => {
  writeAutoUpdatePolicy({ enabled: mode !== 'off', quietMinutes: 10 });
  const fetcher = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => new Response(JSON.stringify(
    init?.method === 'POST' ? { outcome: 'updated', toCommit: 'bbbbbbb', restart: { mode: 'sidecar-supervised' } }
      : String(url).includes('/fleet/runs') ? { v: 1, generatedAt: '', workers: [{ job: 'job123', repo: 'phantom', lane: 'work', tier: '1', ageSeconds: mode === 'young' ? 120 : 900 }], publishesLastHour: [], sources: { workers: 'healthy' } }
        : { v: 1, sourceState: 'healthy', installedVersion: null, headSha: 'aaaaaaa', headAt: null, originSha: 'bbbbbbb', branch: 'master', behind: 3, ahead: 0, dirty: false, lastFetchAt: null, processStartedAt: null, uptimeSeconds: 0, canFastForward: true, applying: mode === 'applying' ? { startedAt: '2026-01-01T00:00:00Z' } : null }
  ), { status: 200 }));
  vi.stubGlobal('fetch', fetcher);
  const view = render(<ToastProvider><Runner /></ToastProvider>);
  if (mode !== 'off') await waitFor(() => expect(fetcher.mock.calls.length).toBeGreaterThanOrEqual(2));
  await act(async () => {});
  const posts = () => fetcher.mock.calls.filter(([, init]) => init?.method === 'POST');
  if (mode === 'quiet') {
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(JSON.parse(String(posts()[0]?.[1]?.body))).toEqual({ action: 'apply' });
    vi.useFakeTimers(); await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    view.rerender(<ToastProvider><Runner /></ToastProvider>);
    expect(posts()).toHaveLength(1);
    expect(view.getAllByText('Phantom updated itself to bbbbbbb; restarting')).toHaveLength(1);
    view.unmount(); render(<ToastProvider><Runner /></ToastProvider>);
    await act(async () => {}); expect(posts()).toHaveLength(1);
  } else expect(posts()).toHaveLength(0);
});
