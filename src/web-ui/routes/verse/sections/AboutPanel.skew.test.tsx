import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { evictAll } from '../../../data/cache.js';
import { setVerseSection } from '../verse-ui-store.js';
import { AboutPanel } from './AboutPanel.js';

vi.mock('./app-version.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('./app-version.js')>(), APP_VERSION: '3.30.0',
}));

const status = {
  v: 1, sourceState: 'healthy', installedVersion: '3.30.0', headSha: null,
  headAt: null, originSha: null, branch: 'master', behind: 0, ahead: 0,
  dirty: false, lastFetchAt: null, processStartedAt: null, uptimeSeconds: null, canFastForward: true,
};

beforeEach(() => {
  evictAll();
  setVerseSection('settings');
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(status), { status: 200 })));
});
afterEach(() => { cleanup(); evictAll(); vi.unstubAllGlobals(); });

describe('About version skew', () => {
  it('shows a warning and action for an older desktop', async () => {
    vi.stubGlobal('__ASHLR_DESKTOP__', { shell: 'tauri', version: '3.29.15' });
    render(<AboutPanel />);
    const note = await screen.findByText('Desktop 3.29.15 is older than Phantom 3.30.0 · install the desktop update when offered');
    expect(note.parentElement).toHaveAttribute('data-tone', 'warning');
  });
  it('shows no skew note when versions agree', async () => {
    vi.stubGlobal('__ASHLR_DESKTOP__', { shell: 'tauri', version: '3.30.0' });
    const { container } = render(<AboutPanel />);
    await screen.findByText('Up to date with origin/master');
    expect(container.querySelector('[data-tone]')).toBeNull();
  });
});
