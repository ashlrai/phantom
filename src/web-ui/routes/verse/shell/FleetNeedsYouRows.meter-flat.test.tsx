import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { evictAll } from '../../../data/cache.js';
import { FleetNeedsYouRows } from './FleetNeedsYouRows.js';

const { openDockPane } = vi.hoisted(() => ({ openDockPane: vi.fn() }));
vi.mock('../dock/dock-store.js', async importOriginal => ({ ...await importOriginal<typeof import('../dock/dock-store.js')>(), openDockPane }));
beforeEach(() => { localStorage.clear(); evictAll(); openDockPane.mockClear(); });
afterEach(() => { cleanup(); evictAll(); vi.unstubAllGlobals(); });

const text = 'fake-provider meter flat 62 min while 4 jobs run';
const status = { v: 1, source: 'available', retainedCount: 1, retainedBytes: 100, liveCount: 1, expiredCount: 0, maxMessages: 1000, maxBytes: 1_000_000 };
const page = { v: 1, status: 'ok', nextCursor: 1, messages: [{ cursor: 1, receivedAt: Date.now(), envelope: {
  id: 'fake-1', from: 'fleet', to: 'all', priority: 'P1', ttl: 60_000,
  body: { kind: 'meter-flat', provider: 'fake-provider', running: 4, observedMinutes: 62, firstUsedPercent: 10, lastUsedPercent: 10, text } } }] };

it('shows a flat-meter incident from the bus and opens the Lanes pane', async () => {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === '/api/verse/agent-bus/status') return Response.json(status);
    if (url.startsWith('/api/verse/agent-bus?')) return Response.json(page);
    return new Response('', { status: 404 });
  }));
  render(<FleetNeedsYouRows split="all" nowMs={Date.now()} onResult={() => {}} />);
  expect(await screen.findByText(text)).toBeInTheDocument();
  expect(screen.getByText('used 10% → 10% over 62 min')).toBeInTheDocument();
  fireEvent.click(screen.getByText(text));
  expect(openDockPane).toHaveBeenCalledWith('fleet-lanes');
});
