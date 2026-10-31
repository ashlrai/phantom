import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { ToastProvider } from '../../../components/primitives/Toast.js';
import { evictAll } from '../../../data/cache.js';
import { ApiError, apiGet } from '../../../data/client.js';
import { getDockState, resetDockStore } from './dock-store.js';
import { resetAutoOpenForTests } from './fleet-workspace-auto.js';
import { FleetWorkspaceAutoOpen } from './FleetWorkspaceAutoOpen.js';

vi.mock('../../../data/client.js', async importOriginal => ({
  ...await importOriginal<typeof import('../../../data/client.js')>(), apiGet: vi.fn(),
}));
beforeEach(() => {
  localStorage.clear(); evictAll(); resetDockStore(); resetAutoOpenForTests();
  vi.mocked(apiGet).mockReset();
});
it.each([
  ['empty runs', () => Promise.resolve({ v: 1, generatedAt: '2026-01-01T00:00:00Z', workers: [], leaders: [], sources: { runsDir: 'missing' } })],
  ['server error', () => Promise.reject(new ApiError('unavailable', 503, '/api/verse/fleet/runs'))],
])('leaves the dock unchanged for %s', async (_name, response) => {
  const previous = getDockState();
  vi.mocked(apiGet).mockImplementation(response);
  render(<ToastProvider><FleetWorkspaceAutoOpen /></ToastProvider>);
  await waitFor(() => expect(apiGet).toHaveBeenCalled());
  await waitFor(() => expect(getDockState()).toEqual(previous));
  expect(screen.queryByText(/Fleet is running on this Mac/)).not.toBeInTheDocument();
});
it('shows one toast when workers and leaders are present', async () => {
  vi.mocked(apiGet).mockResolvedValue({ workers: [{ job: 'worker' }], leaders: [{ job: 'leader' }] });
  render(<ToastProvider><FleetWorkspaceAutoOpen /></ToastProvider>);
  expect(await screen.findAllByText(/Fleet is running on this Mac/)).toHaveLength(1);
});
