import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { evictAll } from '../../../data/cache.js';
import { setVerseSection } from '../verse-ui-store.js';
import { AboutPanel } from './AboutPanel.js';

const status = {
  v: 1, sourceState: 'healthy', installedVersion: '3.30.0', headSha: 'abcdef1234567',
  headAt: '2026-10-31T10:00:00Z', originSha: '123456789abc', branch: 'master',
  behind: 0, ahead: 0, dirty: false, lastFetchAt: '2026-10-31T11:55:00Z',
  processStartedAt: '2026-10-31T11:00:00Z', uptimeSeconds: 3600, canFastForward: true,
};

beforeEach(() => {
  evictAll();
  setVerseSection('settings');
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(status), { status: 200 })));
});
afterEach(() => { cleanup(); evictAll(); vi.unstubAllGlobals(); });

describe('About copy diagnostics', () => {
  it('puts the diagnostics block on the clipboard', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    render(<AboutPanel />);
    await screen.findByText('abcdef1');
    fireEvent.click(screen.getByRole('button', { name: 'Copy diagnostics' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining('Interface: v'));
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining('Running commit: abcdef1'));
    expect(await screen.findByRole('button', { name: 'Copied' })).toBeInTheDocument();
  });

  it('reports clipboard failure', async () => {
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText: vi.fn().mockRejectedValue(new Error()) } });
    render(<AboutPanel />);
    await screen.findByText('abcdef1');
    fireEvent.click(screen.getByRole('button', { name: 'Copy diagnostics' }));
    expect(await screen.findByRole('button', { name: 'Copy failed' })).toBeInTheDocument();
  });
});
