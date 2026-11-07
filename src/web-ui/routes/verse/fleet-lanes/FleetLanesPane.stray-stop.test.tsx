import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { clearMutationToken, setMutationToken } from '../../../data/auth-store.js';
import { evictAll } from '../../../data/cache.js';
import { fleetRunsFixture, withLane } from '../fleet/fleet-runs-fixtures.test-support.js';
import { FleetLanesPane } from './FleetLanesPane.js';

const path = '/api/verse/fleet/control/stray-slots';
const lane = 'devin';
const rows = [{ job: 'RQ-PHX-X', pid: 123, ageSeconds: 2520 }, { job: 'RQ-PHX-Y', pid: 124, ageSeconds: 60 }];
const runs = withLane(fleetRunsFixture({ claudeLane: null }), { lane, target: 3 });
function serve(status = 200) {
  let reads = 0;
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST') return Response.json(status === 200 ? {} : { error: 'not found' }, { status });
    if (url === path) {
      reads++;
      return Response.json({ v: 1, generatedAt: '2026-11-01T00:00:00Z', source: 'ok', lanes: [{ lane, slotsLost: 2, strays: rows }] });
    }
    return Response.json(runs);
  });
  vi.stubGlobal('fetch', fetcher);
  return { fetcher, reads: () => reads };
}
beforeEach(() => { evictAll(); clearMutationToken(); });
afterEach(() => { clearMutationToken(); vi.unstubAllGlobals(); });
it('posts the exact identity with the mutation token and refreshes strays', async () => {
  setMutationToken('a'.repeat(64));
  const server = serve(); render(<FleetLanesPane visible />);
  fireEvent.click(await screen.findByLabelText('Stop stray RQ-PHX-X'));
  await waitFor(() => expect(server.reads()).toBe(2));
  const [url, init] = server.fetcher.mock.calls.find(([, init]) => init?.method === 'POST')!;
  expect(url).toBe(path);
  expect(JSON.parse(String(init?.body))).toEqual({ action: 'stop', lane, job: rows[0].job, pid: 123 });
  expect(new Headers(init?.headers).get('x-ashlr-token')).toBe('a'.repeat(64));
});
it('stops all in sequence and refreshes after each post', async () => {
  setMutationToken('a'.repeat(64));
  const server = serve(); render(<FleetLanesPane visible />);
  fireEvent.click(await screen.findByText('Stop all 2', { selector: 'button' }));
  await waitFor(() => expect(server.fetcher.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(2));
  const posted = server.fetcher.mock.calls.filter(([, init]) => init?.method === 'POST').map(([, init]) => JSON.parse(String(init?.body)).pid);
  expect(posted).toEqual([123, 124]);
  await waitFor(() => expect(server.reads()).toBeGreaterThanOrEqual(2));
});
it('shows the locked text without posting', async () => {
  const server = serve(); render(<FleetLanesPane visible />);
  fireEvent.click(await screen.findByLabelText('Stop stray RQ-PHX-X'));
  expect(await screen.findByRole('status')).toHaveTextContent('Unlock actions with the mutation token before changing the loop.');
  expect(server.fetcher.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
});
it('shows the update message and refreshes after a rejected post', async () => {
  setMutationToken('a'.repeat(64));
  const server = serve(404); render(<FleetLanesPane visible />);
  fireEvent.click(await screen.findByLabelText('Stop stray RQ-PHX-X'));
  expect(await screen.findByRole('status')).toHaveTextContent('This Phantom server cannot stop strays yet; update the app.');
  await waitFor(() => expect(server.reads()).toBe(2));
});
