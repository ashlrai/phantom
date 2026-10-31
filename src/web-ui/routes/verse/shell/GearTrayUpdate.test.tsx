import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { evictAll, getQuerySnapshot } from '../../../data/cache.js';
import { getVerseUiState, resetVerseUi } from '../verse-ui-store.js';
import { GearTray } from './GearTray.js';

const status = {
  v: 1, generatedAt: 'now', sourceState: 'healthy', installedVersion: '1.0.0', repoRoot: true,
  headSha: 'a'.repeat(40), headAt: 'now', originSha: 'b'.repeat(40), branch: 'master',
  behind: 2, ahead: 0, dirty: false, lastFetchAt: null, processStartedAt: 'now', uptimeSeconds: 1, pid: 42, canFastForward: true,
};

afterEach(() => { vi.unstubAllGlobals(); evictAll(); resetVerseUi(); });

describe('GearTray update entry', () => {
  it('puts the update first and opens Settings when chosen', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(status), { status: 200 })));
    const close = vi.fn();
    const view = render(<GearTray open anchorRef={{ current: document.createElement('button') }} onClose={close} compact={false} />);
    const item = await screen.findByRole('menuitem', { name: 'Update available · 2 commits behind' });
    expect(screen.getAllByRole('menuitem')[0]).toBe(item);
    fireEvent.click(item);
    expect(getVerseUiState().section).toBe('settings'); expect(close).toHaveBeenCalledOnce();
    view.unmount();
  });

  it('keeps Settings first and does not refetch a missing endpoint on rerender', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response('{}', { status: 404 }));
    vi.stubGlobal('fetch', fetch);
    const props = { open: true, anchorRef: { current: document.createElement('button') }, onClose: vi.fn(), compact: false };
    const view = render(<GearTray {...props} />);
    await waitFor(() => expect(getQuerySnapshot('verse-self-update-badge').status).toBe('error'));
    expect(fetch).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.getAllByRole('menuitem')[0]).toHaveTextContent('Settings'));
    view.rerender(<GearTray {...props} />);
    expect(screen.queryByRole('menuitem', { name: /Update available/ })).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(1);
    view.unmount();
  });
});
