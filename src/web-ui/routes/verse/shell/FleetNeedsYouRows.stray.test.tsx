import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { evictAll } from '../../../data/cache.js';
import { FleetNeedsYouRows } from './FleetNeedsYouRows.js';

const { openDockPane } = vi.hoisted(() => ({ openDockPane: vi.fn() }));
vi.mock('../dock/dock-store.js', async importOriginal => ({ ...await importOriginal<typeof import('../dock/dock-store.js')>(), openDockPane }));
beforeEach(() => { localStorage.clear(); evictAll(); openDockPane.mockClear(); });
afterEach(() => { cleanup(); evictAll(); vi.unstubAllGlobals(); });
const path = '/api/verse/fleet/control/stray-slots';
const report = { v: 1, generatedAt: '2026-11-03T00:00:00Z', source: 'ok',
  lanes: [{ lane: 'fake-lane', slotsLost: 1, strays: [{ job: 'fake-job', pid: 4242, ageSeconds: 60 }] }] };

it('shows lost slots and opens the existing Lanes stop controls without posting', async () => {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => String(input) === path
    ? Response.json(report) : new Response('', { status: 404 })));
  render(<FleetNeedsYouRows split="all" nowMs={0} onResult={() => {}} />);
  expect(await screen.findByText('1 lane slot lost to leftover processes')).toBeInTheDocument();
  expect(screen.getByText('fake-lane: 1')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Open Lanes' }));
  expect(openDockPane).toHaveBeenCalledWith('fleet-lanes');
  expect(vi.mocked(fetch).mock.calls.every(([, init]) => !init?.method || init.method === 'GET')).toBe(true);
});

it('treats an absent route as not in this build', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 404 })));
  render(<FleetNeedsYouRows split="fleet" nowMs={0} onResult={() => {}} />);
  await waitFor(() => expect(vi.mocked(fetch).mock.calls.some(([input]) => String(input) === path)).toBe(true));
  expect(screen.queryByText(/lost to leftover processes/)).toBeNull();
});
