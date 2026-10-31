import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { evictAll } from '../data/cache.js';
import { UpdateReloadBanner } from './UpdateReloadBanner.js';

beforeEach(() => { evictAll(); window.sessionStorage.clear(); });
afterEach(() => { vi.unstubAllGlobals(); });

it('shows the reload prompt immediately on a chunk error and refetches', async () => {
  const fetchMock = vi.fn(async () => new Response('not found', { status: 404 }));
  vi.stubGlobal('fetch', fetchMock);
  render(<UpdateReloadBanner />);
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
  act(() => { window.dispatchEvent(new Event('vite:preloadError', { cancelable: true })); });
  expect(screen.getByRole('status')).toHaveTextContent('Phantom updated while this window was open — reload to finish');
  expect(screen.getByRole('button', { name: 'Reload' })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Later' })).toBeNull();
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
});

it('shows a chunk failure even after a null-sha update was dismissed', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({
    sourceState: 'healthy', installedVersion: 'different', headSha: null,
  })));
  render(<UpdateReloadBanner />);
  await screen.findByRole('status');
  fireEvent.click(screen.getByRole('button', { name: 'Later' }));
  await waitFor(() => expect(screen.queryByRole('status')).toBeNull());
  act(() => { window.dispatchEvent(new Event('vite:preloadError', { cancelable: true })); });
  expect(screen.getByRole('status')).toHaveTextContent('Phantom updated while this window was open — reload to finish');
});
