import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDesktopUpdatesForTests } from '../../../app/desktop-updates.js';
import { evictAll } from '../../../data/cache.js';
import { ToastProvider } from '../../../components/primitives/Toast.js';
import { UpdateStatusRow } from './UpdateStatusRow.js';

const facts = { v: 1, sourceState: 'healthy', installedVersion: '1.0.0', headSha: 'abcdef123456', headAt: null, originSha: null, branch: 'master', behind: 2, ahead: 0, dirty: false, lastFetchAt: null, processStartedAt: null, uptimeSeconds: 120, canFastForward: true };
function server(body: unknown = facts, status = 200) {
  const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify(body), { status }));
  vi.stubGlobal('fetch', fetcher); return fetcher;
}
beforeEach(() => { evictAll(); resetDesktopUpdatesForTests(); });
afterEach(() => { cleanup(); resetDesktopUpdatesForTests(); delete (window as unknown as Record<string, unknown>)['__ASHLR_DESKTOP__']; vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('Updates row commit subjects', () => {
  it('shows newest subject and opens a disclosure with up to five subjects', async () => {
    const subjects = ['bridge(RQ-PHX-FAKE): newest', 'second', 'third', 'fourth', 'fifth'];
    server({ ...facts, behind: 12, behindSubjects: subjects });
    render(<ToastProvider><UpdateStatusRow /></ToastProvider>);
    expect(await screen.findByText('Newest: bridge(RQ-PHX-FAKE): newest (+11 more)')).toBeInTheDocument();
    const summary = screen.getByText('Show all');
    expect(summary.closest('details')).not.toHaveAttribute('open');
    await userEvent.click(summary);
    expect(summary.closest('details')).toHaveAttribute('open');
    expect(screen.getByRole('list')).toBeVisible();
    expect(screen.getAllByRole('listitem').map(item => item.textContent)).toEqual(subjects);
  });
  it('preserves the row for older server replies', async () => {
    server(); render(<ToastProvider><UpdateStatusRow /></ToastProvider>);
    expect(await screen.findByText(/2 commits behind master · ready to fast-forward/)).toBeInTheDocument();
    expect(screen.queryByText(/Newest:/)).not.toBeInTheDocument();
    expect(screen.queryByText('Show all')).not.toBeInTheDocument();
  });
});
