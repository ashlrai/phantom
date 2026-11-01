import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { evictAll } from '../../../data/cache.js';
import { FleetGraphPane } from './FleetGraphPane.js';

vi.mock('../dock/dock-store.js', () => ({ openDockPane: vi.fn() }));
import { openDockPane } from '../dock/dock-store.js';

const runs = { v: 1, generatedAt: '2026-10-31T12:00:00Z', sources: { runsDir: 'healthy', workers: 'healthy', inbox: 'healthy', codex: 'healthy', merges: 'healthy' },
  lastTick: null, paused: null, memFreePct: null, diskFreeGb: null, switches: [], claudeLane: null, lanes: [], workers: [], leaders: [],
  orchestratorAgents: null, publishesLastHour: [], mergesLastHour: { count: 0, items: [] }, events: [], codexPersonal: null, inbox: [], drop: null };
const liveNode = (id: string, kind: string, state: string, usedPercent: number | null) => ({ id, kind, live: {
  state, usedPercent, resetsAtMs: null, readingAgeMs: null, stale: state === 'stale', reasons: [`${id} reason`],
} });
const live = { v: 1, live: { complete: true, issues: [], nodes: [
  liveNode('agent-fake', 'agent', 'ready', null), liveNode('engine-fake', 'engine-account', 'limited', 82),
  liveNode('mcp-fake', 'mcp', 'stale', null), liveNode('seat-fake', 'seat', 'exhausted', 100),
] } };
const path = '/api/verse/fleet/graph/live';

beforeEach(() => { evictAll(); vi.clearAllMocks(); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

it('shows live rows worst first and opens usage for a seat', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => Response.json(url === path ? live : runs)));
  render(<FleetGraphPane visible />);
  expect(await screen.findByText('0 lanes · 0 workers · 0 merges last hour')).toBeInTheDocument();
  const section = screen.getByRole('region', { name: 'Seats and engines' });
  expect(await within(section).findByText('4 nodes · 1 ready · 1 limited · 1 exhausted · 1 stale')).toBeInTheDocument();
  const rows = within(section).getAllByRole('listitem');
  expect(rows.map(row => within(row).getByText(/^(seat|mcp|engine|agent)-fake$/).textContent)).toEqual(['seat-fake', 'mcp-fake', 'engine-fake', 'agent-fake']);
  expect(rows[0]).toHaveAttribute('title', 'seat-fake reason');
  expect(within(rows[1]!).getByText('unmeasured')).toBeInTheDocument();
  expect(within(rows[1]!).getByText('reset unknown')).toBeInTheDocument();
  expect(within(rows[1]!).getByText('no dated reading')).toBeInTheDocument();
  fireEvent.click(within(rows[0]!).getByRole('button'));
  expect(openDockPane).toHaveBeenCalledWith('fleet-usage');
});

it('polls live state every 15 seconds only while visible', async () => {
  const fetcher = vi.fn(async (url: string) => Response.json(url === path ? live : runs));
  vi.stubGlobal('fetch', fetcher);
  vi.useFakeTimers();
  const view = render(<FleetGraphPane visible />);
  await act(async () => {});
  await act(async () => { vi.advanceTimersByTime(15_000); });
  expect(fetcher.mock.calls.filter(([url]) => url === path)).toHaveLength(2);
  view.rerender(<FleetGraphPane visible={false} />);
  await act(async () => { vi.advanceTimersByTime(30_000); });
  expect(fetcher.mock.calls.filter(([url]) => url === path)).toHaveLength(2);
});

it('reports a failed live read without replacing the runs graph', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => url === path ? new Response('', { status: 503 }) : Response.json(runs)));
  render(<FleetGraphPane visible />);
  expect(await screen.findByText('Live node state unavailable: The server answered HTTP 503.')).toBeInTheDocument();
  expect(screen.getByText('0 lanes · 0 workers · 0 merges last hour')).toBeInTheDocument();
});

it('keeps a missing route unavailable across polls and remounts', async () => {
  const fetcher = vi.fn(async (url: string) => url === path ? new Response('', { status: 404 }) : Response.json(runs));
  vi.stubGlobal('fetch', fetcher);
  const view = render(<FleetGraphPane visible />);
  expect(await screen.findByText('Live node state unavailable: The server answered HTTP 404.')).toBeInTheDocument();
  expect(screen.getAllByText(/Live node state unavailable:/)).toHaveLength(1);
  expect(screen.getByText('0 lanes · 0 workers · 0 merges last hour')).toBeInTheDocument();
  view.unmount();
  evictAll();
  vi.useFakeTimers();
  render(<FleetGraphPane visible />);
  await act(async () => {});
  await act(async () => { vi.advanceTimersByTime(60_000); });
  expect(fetcher.mock.calls.filter(([url]) => url === path)).toHaveLength(1);
  expect(screen.getAllByText(/Live node state unavailable:/)).toHaveLength(1);
});
