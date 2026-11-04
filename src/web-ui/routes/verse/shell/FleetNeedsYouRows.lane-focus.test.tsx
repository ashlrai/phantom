import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { evictAll } from '../../../data/cache.js';
import { resetLaneFocus, takeRequestedLane } from '../fleet-lanes/lane-focus-request.js';
import { FleetNeedsYouRows } from './FleetNeedsYouRows.js';

const { openDockPane } = vi.hoisted(() => ({ openDockPane: vi.fn() }));
vi.mock('../dock/dock-store.js', async importOriginal => ({ ...await importOriginal<typeof import('../dock/dock-store.js')>(), openDockPane }));
beforeEach(() => { localStorage.clear(); evictAll(); openDockPane.mockClear(); resetLaneFocus(); });
afterEach(() => { cleanup(); evictAll(); resetLaneFocus(); vi.unstubAllGlobals(); });

const wasteText = 'devin: 40% projected unused at reset in 9 h';
const status = { v: 1, source: 'available', retainedCount: 1, retainedBytes: 100, liveCount: 1, expiredCount: 0, maxMessages: 1000, maxBytes: 1_000_000 };
const wastePage = (lane: string) => ({ v: 1, status: 'ok', nextCursor: 1, messages: [{ cursor: 1, receivedAt: Date.now(),
  envelope: { id: 'fake-1', from: 'fleet', to: 'all', priority: 'P1', ttl: 60_000,
    body: { kind: 'waste-high', lane, projectedUnusedPct: 40, hoursToReset: 9, text: wasteText } } }] });

function setup(page: unknown) {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === '/api/verse/agent-bus/status') return Response.json(status);
    if (url.startsWith('/api/verse/agent-bus?')) return Response.json(page);
    return new Response('', { status: 404 });
  }));
  render(<FleetNeedsYouRows split="all" nowMs={Date.now()} onResult={() => {}} />);
}

it('Open on a waste-high row requests focus on its lane and opens the Lanes pane', async () => {
  setup(wastePage('devin'));
  expect(await screen.findByText(wasteText)).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Open Lanes' }));
  expect(openDockPane).toHaveBeenCalledWith('fleet-lanes');
  expect(takeRequestedLane()).toBe('devin');
});

it('a row whose lane is invalid still opens the pane and requests no lane', async () => {
  setup(wastePage('Not A Lane!'));
  expect(await screen.findByText(wasteText)).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Open Lanes' }));
  expect(openDockPane).toHaveBeenCalledWith('fleet-lanes');
  expect(takeRequestedLane()).toBeNull();
});
