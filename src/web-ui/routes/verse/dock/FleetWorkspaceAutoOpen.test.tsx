import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '../../../components/primitives/Toast.js';
import { evictAll } from '../../../data/cache.js';
import { ApiError, apiGet } from '../../../data/client.js';
import { getDockState, hydrateDockState, openFleetWorkspace, resetDockStore } from './dock-store.js';
import { resetAutoOpenForTests, STORAGE_KEY } from './fleet-workspace-auto.js';
import { FleetWorkspaceAutoOpen } from './FleetWorkspaceAutoOpen.js';

vi.mock('../../../data/client.js', async importOriginal => {
  const original = await importOriginal<typeof import('../../../data/client.js')>();
  return { ...original, apiGet: vi.fn() };
});
vi.mock('./dock-store.js', async importOriginal => {
  const original = await importOriginal<typeof import('./dock-store.js')>();
  return { ...original, openFleetWorkspace: vi.fn(original.openFleetWorkspace) };
});

const renderAuto = () => render(<ToastProvider><FleetWorkspaceAutoOpen /></ToastProvider>);
const running = { workers: [{ job: 'worker' }], leaders: [] };

beforeEach(() => {
  localStorage.clear();
  evictAll();
  resetDockStore();
  resetAutoOpenForTests();
  vi.mocked(apiGet).mockReset();
  vi.mocked(openFleetWorkspace).mockClear();
});

describe('FleetWorkspaceAutoOpen', () => {
  it('opens once and Undo restores the previous layout', async () => {
    hydrateDockState({ open: false, tabs: ['terminal'], active: 'terminal', width: 480 });
    const previous = getDockState();
    vi.mocked(apiGet).mockResolvedValue(running);
    const view = renderAuto();
    await screen.findByText('Fleet is running on this Mac. Opened the fleet workspace.');
    expect(openFleetWorkspace).toHaveBeenCalledOnce();
    expect(openFleetWorkspace).toHaveBeenCalledWith(['fleet-hub', 'fleet-lanes', 'fleet-merges', 'fleet-inbox']);
    expect(getDockState()).toMatchObject({ open: true, active: 'fleet-hub', splitWith: 'fleet-lanes' });
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(getDockState()).toEqual(previous);
    view.unmount();
    renderAuto();
    await waitFor(() => expect(openFleetWorkspace).toHaveBeenCalledOnce());
  });

  it('allows opting out from the toast', async () => {
    vi.mocked(apiGet).mockResolvedValue(running);
    renderAuto();
    fireEvent.click(await screen.findByRole('button', { name: "Don't do this again" }));
    expect(localStorage.getItem(STORAGE_KEY)).toBe('off');
  });

  it('does not open when opted out', async () => {
    localStorage.setItem(STORAGE_KEY, 'off');
    vi.mocked(apiGet).mockResolvedValue(running);
    renderAuto();
    await waitFor(() => expect(apiGet).toHaveBeenCalled());
    await waitFor(() => expect(getDockState().open).toBe(false));
    expect(openFleetWorkspace).not.toHaveBeenCalled();
  });

  it('does nothing when the endpoint is missing', async () => {
    vi.mocked(apiGet).mockRejectedValue(new ApiError('missing', 404, '/api/verse/fleet/runs'));
    renderAuto();
    await waitFor(() => expect(apiGet).toHaveBeenCalled());
    expect(openFleetWorkspace).not.toHaveBeenCalled();
    expect(screen.queryByText(/Fleet is running on this Mac/)).not.toBeInTheDocument();
  });
});
