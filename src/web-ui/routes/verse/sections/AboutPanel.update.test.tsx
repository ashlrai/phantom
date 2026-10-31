import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { evictAll } from '../../../data/cache.js';
import { getDockState, resetDockStore } from '../dock/dock-store.js';
import { getVerseUiState, setVerseSection } from '../verse-ui-store.js';
import { AboutPanel } from './AboutPanel.js';

const status = {
  v: 1, sourceState: 'healthy', installedVersion: '3.30.0', headSha: 'abcdef123456',
  headAt: '2026-10-31T10:00:00Z', originSha: '123456789abc', branch: 'master',
  behind: 3, ahead: 0, dirty: false, lastFetchAt: '2026-10-31T11:55:00Z',
  processStartedAt: '2026-10-31T11:00:00Z', uptimeSeconds: 3600, canFastForward: true,
};

beforeEach(() => { evictAll(); resetDockStore(); setVerseSection('settings'); });
afterEach(() => { cleanup(); evictAll(); resetDockStore(); vi.unstubAllGlobals(); });

describe('About update status', () => {
  it('shows the running server details and opens Releases in Chat', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(status), { status: 200 })));
    render(<AboutPanel />);
    expect(await screen.findByText('3 commits behind origin/master · Fast-forward ready')).toBeInTheDocument();
    expect(screen.getByText('abcdef1')).toBeInTheDocument();
    expect(screen.getByText('1234567')).toBeInTheDocument();
    expect(screen.getByText('Installed Phantom')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Open Releases pane' }));
    expect(getVerseUiState().section).toBe('chat');
    expect(getDockState()).toMatchObject({ open: true, active: 'fleet-releases' });
  });
  it('explains when the endpoint is absent in this build', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 404 })));
    render(<AboutPanel />);
    expect(await screen.findByText('Self-update status is not in this build.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open Releases pane' })).toBeInTheDocument();
  });
});
