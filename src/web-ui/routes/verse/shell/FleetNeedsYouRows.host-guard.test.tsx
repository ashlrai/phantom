import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { evictAll } from '../../../data/cache.js';
import { FleetNeedsYouRows } from './FleetNeedsYouRows.js';

const { openDockPane } = vi.hoisted(() => ({ openDockPane: vi.fn() }));
vi.mock('../dock/dock-store.js', async importOriginal => ({ ...await importOriginal<typeof import('../dock/dock-store.js')>(), openDockPane }));
beforeEach(() => { localStorage.clear(); evictAll(); openDockPane.mockClear(); });
afterEach(() => { cleanup(); evictAll(); vi.unstubAllGlobals(); });
const path = '/api/verse/fleet/memory';
const report = { v: 1, generatedAt: '', memory: { schema: 'fleet.memory.v1', generatedAt: '',
  sample: { free_pct: 50, swap_gb: null, swapouts_per_min: null, disk_gb: null, sampled_at: null, age_ms: null, stale: false },
  memguard: { level: 1, stopped: ['fake-job'] } } };

it('shows stopped workers and opens Mac host without posting', async () => {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => String(input) === path
    ? Response.json(report) : new Response('', { status: 404 })));
  render(<FleetNeedsYouRows split="all" nowMs={0} onResult={() => {}} />);
  expect(await screen.findByText('Memory guard stopped 1 worker')).toBeInTheDocument();
  expect(screen.getByText('fake-job')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Open Mac host' }));
  expect(openDockPane).toHaveBeenCalledWith('fleet-host');
  expect(vi.mocked(fetch).mock.calls.every(([, init]) => !init?.method || init.method === 'GET')).toBe(true);
});

it('treats an absent route as not in this build', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 404 })));
  render(<FleetNeedsYouRows split="fleet" nowMs={0} onResult={() => {}} />);
  await waitFor(() => expect(vi.mocked(fetch).mock.calls.some(([input]) => String(input) === path)).toBe(true));
  expect(screen.queryByText(/Memory guard|Mac memory|Memory sample|Second computer/)).toBeNull();
});
