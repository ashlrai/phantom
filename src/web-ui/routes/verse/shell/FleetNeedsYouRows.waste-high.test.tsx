import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { evictAll } from '../../../data/cache.js';
import { FleetNeedsYouRows } from './FleetNeedsYouRows.js';

const { openDockPane } = vi.hoisted(() => ({ openDockPane: vi.fn() }));
vi.mock('../dock/dock-store.js', async importOriginal => ({ ...await importOriginal<typeof import('../dock/dock-store.js')>(), openDockPane }));
beforeEach(() => { localStorage.clear(); evictAll(); openDockPane.mockClear(); });
afterEach(() => { cleanup(); evictAll(); vi.unstubAllGlobals(); });

const wasteText = 'fake-lane: 42% projected unused at reset in 9.5 h';
const meterText = 'fake-provider meter flat 62 min while 4 jobs run';
const status = { v: 1, source: 'available', retainedCount: 2, retainedBytes: 100, liveCount: 2, expiredCount: 0, maxMessages: 1000, maxBytes: 1_000_000 };
const envelope = (id: string, body: Record<string, unknown>) => ({ id, from: 'fleet', to: 'all', priority: 'P1', ttl: 60_000, body });
const page = { v: 1, status: 'ok', nextCursor: 2, messages: [
  { cursor: 1, receivedAt: Date.now(), envelope: envelope('fake-1', { kind: 'meter-flat', provider: 'fake-provider', running: 4,
    observedMinutes: 62, firstUsedPercent: 10, lastUsedPercent: 10, text: meterText }) },
  { cursor: 2, receivedAt: Date.now(), envelope: envelope('fake-2', { kind: 'waste-high', lane: 'fake-lane', projectedUnusedPct: 42,
    hoursToReset: 9.5, text: wasteText }) },
] };

it('shows a waste-high row beside the meter-flat row and opens the Lanes pane', async () => {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === '/api/verse/agent-bus/status') return Response.json(status);
    if (url.startsWith('/api/verse/agent-bus?')) return Response.json(page);
    return new Response('', { status: 404 });
  }));
  render(<FleetNeedsYouRows split="all" nowMs={Date.now()} onResult={() => {}} />);
  expect(await screen.findByText(wasteText)).toBeInTheDocument();
  expect(screen.getByText(meterText)).toBeInTheDocument();
  expect(screen.getByText('42% unused at reset · 9.5 h left')).toBeInTheDocument();
  expect(screen.getAllByRole('button', { name: 'Open Lanes' })).toHaveLength(2);
  fireEvent.click(screen.getByText(wasteText));
  expect(openDockPane).toHaveBeenCalledWith('fleet-lanes');
});
