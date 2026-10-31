import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDesktopUpdatesForTests } from '../../../app/desktop-updates.js';
import { evictAll } from '../../../data/cache.js';
import { SectionVisibilityProvider } from '../shell/section-visibility.js';
import { UpdateStatusRow } from './UpdateStatusRow.js';

const facts = { v: 1, sourceState: 'healthy', installedVersion: '1.0.0', headSha: 'abcdef123456', headAt: null, originSha: null, branch: 'master', behind: 2, ahead: 0, dirty: false, lastFetchAt: null, processStartedAt: null, uptimeSeconds: 120, canFastForward: true };
const state = { phase: 'staged', enabled: true, version: '2.0.0', bytesReceived: 0, bytesTotal: null, reason: null };
function server(body: unknown = facts, status = 200) {
  const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify(body), { status }));
  vi.stubGlobal('fetch', fetcher); return fetcher;
}
beforeEach(() => { evictAll(); resetDesktopUpdatesForTests(); });
afterEach(() => { cleanup(); resetDesktopUpdatesForTests(); delete (window as unknown as Record<string, unknown>)['__ASHLR_DESKTOP__']; vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('Updates row', () => {
  it('shows staged native state, build detail, and checks both sources', async () => {
    const fetcher = server(); const refresh = vi.fn(() => true);
    (window as unknown as Record<string, unknown>)['__ASHLR_DESKTOP__'] = { shell: 'tauri', version: '2.0.0', updates: { getState: () => state, refresh } };
    render(<UpdateStatusRow />);
    expect(screen.getByText(/Update 2.0.0 ready/)).toHaveAttribute('aria-live', 'polite');
    await screen.findByText(/abcdef1/);
    await userEvent.click(screen.getByRole('button', { name: 'Check now' }));
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    expect(refresh).toHaveBeenCalledOnce();
    expect(fetcher.mock.calls.every(([, init]) => !init?.method || init.method === 'GET')).toBe(true);
  });
  it.each([
    [facts, '2 commits behind master · ready to fast-forward'],
    [{ ...facts, dirty: true, canFastForward: false }, '2 behind · local changes block the update'],
  ])('renders server status in browser', async (body, text) => {
    server(body); render(<UpdateStatusRow />); expect(await screen.findByText(new RegExp(text))).toBeInTheDocument();
  });
  it('handles 404 and checks again in a browser', async () => {
    const fetcher = server({}, 404); render(<UpdateStatusRow />);
    expect(await screen.findByText(/Update status is not in this build yet/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Check now' }));
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
  });
  it('rejects malformed data and never renders paths as shas', async () => {
    server({ ...facts, headSha: '/private/path' }); render(<UpdateStatusRow />);
    await waitFor(() => expect(screen.getByText(/Update status unavailable/)).toBeInTheDocument());
    expect(screen.queryByText(/private/)).not.toBeInTheDocument();
  });
  it('polls while visible and catches up when shown', async () => {
    vi.useFakeTimers(); const fetcher = server();
    const view = render(<SectionVisibilityProvider visible><UpdateStatusRow /></SectionVisibilityProvider>);
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(fetcher).toHaveBeenCalledTimes(2);
    view.rerender(<SectionVisibilityProvider visible={false}><UpdateStatusRow /></SectionVisibilityProvider>);
    await act(async () => { await vi.advanceTimersByTimeAsync(120_000); });
    expect(fetcher).toHaveBeenCalledTimes(2);
    view.rerender(<SectionVisibilityProvider visible><UpdateStatusRow /></SectionVisibilityProvider>);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(fetcher.mock.calls.length).toBeGreaterThanOrEqual(3);
  });
});
