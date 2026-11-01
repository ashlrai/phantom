import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OpsSelfUpdateV1 } from '../../core/verse/ops-types.js';
import { evictAll } from '../data/cache.js';
import { APP_VERSION } from '../routes/verse/sections/app-version.js';
import { SIDECAR_RESTARTED_EVENT } from './sidecar-restart.js';
import { UpdateReloadBanner } from './UpdateReloadBanner.js';

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const SHA_C = 'c'.repeat(40);
const DISMISSED_KEY = 'ashlr.verse.update-reload.dismissed';

const status = (over: Partial<OpsSelfUpdateV1> = {}): OpsSelfUpdateV1 => ({
  v: 1, generatedAt: '2026-10-31T00:00:00.000Z', sourceState: 'healthy',
  installedVersion: APP_VERSION, repoRoot: true, headSha: SHA_A, processHeadSha: SHA_A, headAt: null,
  originSha: SHA_A, branch: 'master', behind: 0, ahead: 0, dirty: false,
  lastFetchAt: null, processStartedAt: '2026-10-31T00:00:00.000Z',
  uptimeSeconds: 30, pid: 4242, canFastForward: false, ...over,
});

/** fetch stub: serves `payload`, which tests may swap mid-flight via set(). */
function serve(initial: OpsSelfUpdateV1 | Response | (() => OpsSelfUpdateV1 | Response)) {
  let payload = initial;
  const fetchMock = vi.fn(async () => {
    const value = typeof payload === 'function' ? payload() : payload;
    return value instanceof Response ? value : Response.json(value);
  });
  vi.stubGlobal('fetch', fetchMock);
  return {
    calls: () => fetchMock.mock.calls.length,
    set: (next: typeof payload) => { payload = next; },
  };
}

/** Flush the fetch->cache->render microtask chain. */
const flush = async () => { await act(async () => { for (let i = 0; i < 10; i += 1) await Promise.resolve(); }); };

beforeEach(() => { evictAll(); window.sessionStorage.clear(); });
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('UpdateReloadBanner', () => {
  it('shows a reload banner when the server build is newer than the page build', async () => {
    serve(status({ installedVersion: '3.30.1' }));
    render(<UpdateReloadBanner />);
    const banner = await screen.findByRole('status');
    expect(banner).toHaveTextContent('Phantom updated to 3.30.1 — reload to use the new interface');
    expect(screen.getByRole('button', { name: 'Reload' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Later' })).toBeInTheDocument();
  });

  it('stays hidden while versions and commit match the page', async () => {
    const { calls } = serve(status());
    render(<UpdateReloadBanner />);
    await waitFor(() => expect(calls()).toBe(1));
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('flags a sidecar restart onto new code even at the same version', async () => {
    const { calls, set } = serve(status());
    render(<UpdateReloadBanner />);
    await waitFor(() => expect(calls()).toBe(1));
    expect(screen.queryByRole('status')).toBeNull();
    set(status({ headSha: SHA_B }));
    act(() => { window.dispatchEvent(new Event(SIDECAR_RESTARTED_EVENT)); });
    expect(await screen.findByRole('status'))
      .toHaveTextContent('Phantom restarted on new code — reload');
    expect(calls()).toBeGreaterThanOrEqual(2);
  });

  it('"Later" silences that build only — a further change asks again', async () => {
    const { calls, set } = serve(status({ installedVersion: '3.30.1', headSha: SHA_B }));
    render(<UpdateReloadBanner />);
    await screen.findByRole('status');
    fireEvent.click(screen.getByRole('button', { name: 'Later' }));
    expect(screen.queryByRole('status')).toBeNull();
    expect(window.sessionStorage.getItem(DISMISSED_KEY)).toBe(SHA_B);
    set(status({ installedVersion: '3.30.1', headSha: SHA_C }));
    act(() => { window.dispatchEvent(new Event(SIDECAR_RESTARTED_EVENT)); });
    expect(await screen.findByRole('status'))
      .toHaveTextContent('Phantom updated to 3.30.1 — reload to use the new interface');
    expect(calls()).toBeGreaterThanOrEqual(2);
  });

  it('re-checks at once on the restart event and again five seconds later', async () => {
    vi.useFakeTimers();
    const { calls } = serve(status());
    render(<UpdateReloadBanner />);
    await flush();
    expect(calls()).toBe(1);
    act(() => { window.dispatchEvent(new Event(SIDECAR_RESTARTED_EVENT)); });
    await flush();
    expect(calls()).toBe(2);
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    expect(calls()).toBe(3);
  });

  it('polls once a minute', async () => {
    vi.useFakeTimers();
    const { calls } = serve(status());
    render(<UpdateReloadBanner />);
    await flush();
    expect(calls()).toBe(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(calls()).toBe(2);
  });

  it('renders nothing when the route 404s', async () => {
    const { calls } = serve(() => new Response('not found', { status: 404 }));
    render(<UpdateReloadBanner />);
    await waitFor(() => expect(calls()).toBe(1));
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('renders nothing when the server reports the source unavailable', async () => {
    const { calls } = serve(status({ sourceState: 'unavailable', installedVersion: '3.30.1', headSha: null, repoRoot: false }));
    render(<UpdateReloadBanner />);
    await waitFor(() => expect(calls()).toBe(1));
    expect(screen.queryByRole('status')).toBeNull();
  });
});
