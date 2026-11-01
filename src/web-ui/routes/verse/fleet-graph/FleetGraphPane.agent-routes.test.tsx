import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { evictAll } from '../../../data/cache.js';
import { FleetGraphPane } from './FleetGraphPane.js';

const path = '/api/verse/fleet/graph/live';
const runs = { v: 1, generatedAt: '2026-10-31T12:00:00Z', sources: { runsDir: 'healthy', workers: 'healthy', inbox: 'healthy', codex: 'healthy', merges: 'healthy' },
  lastTick: null, paused: null, memFreePct: null, diskFreeGb: null, switches: [], claudeLane: null, lanes: [], workers: [], leaders: [],
  orchestratorAgents: null, publishesLastHour: [], mergesLastHour: { count: 0, items: [] }, events: [], codexPersonal: null, inbox: [], drop: null };
const live = (state: string) => ({ state, usedPercent: null, resetsAtMs: null, readingAgeMs: null, stale: false, reasons: [] });
const agent = (agentId: string) => ({ id: `agent:${agentId}`, kind: 'agent', agentId, live: live('ready') });
const nodes = [agent('fake/leader'), agent('bad id'), agent('empty'), agent('old'), { id: 'model:fake', kind: 'model', live: live('held') }, { id: 'mcp:fake', kind: 'mcp', live: live('untracked') }];
const edge = (to: string) => ({ id: `edge:${to}`, kind: 'routes-to', from: 'agent:fake/leader', to, source: 'fleet' });
const global = { v: 1, live: { nodes } };

beforeEach(() => evictAll());
afterEach(() => vi.unstubAllGlobals());

it('fetches the selected agent once, shows states, and clears without refetching the graph', async () => {
  const fetcher = vi.fn(async (url: string) => Response.json(url === path ? global
    : url === `${path}?agent=fake%2Fleader` ? { ...global, scope: { kind: 'agent', agentId: 'fake/leader' }, edges: [edge('model:fake'), edge('mcp:fake')] } : runs));
  vi.stubGlobal('fetch', fetcher);
  render(<FleetGraphPane visible />);
  await screen.findByRole('option', { name: 'fake/leader' });
  fireEvent.change(screen.getByRole('combobox', { name: 'Agent' }), { target: { value: 'fake/leader' } });
  const section = screen.getByRole('region', { name: 'Agent routes' });
  expect(await within(section).findByText('fake/leader reaches 2 resources · 1 held')).toBeInTheDocument();
  expect(within(section).getByText(/held · unmeasured/)).toBeInTheDocument();
  expect(within(section).getByText(/untracked · unmeasured/)).toBeInTheDocument();
  expect(fetcher.mock.calls.filter(([url]) => url === `${path}?agent=fake%2Fleader`)).toHaveLength(1);
  fireEvent.change(screen.getByRole('combobox', { name: 'Agent' }), { target: { value: '' } });
  expect(within(section).queryByRole('list')).not.toBeInTheDocument();
  await waitFor(() => expect(fetcher.mock.calls.filter(([url]) => url === path)).toHaveLength(1));
});

it('refuses invalid agent ids without a request', async () => {
  const fetcher = vi.fn(async (url: string) => Response.json(url === path ? global : runs));
  vi.stubGlobal('fetch', fetcher);
  render(<FleetGraphPane visible />);
  await screen.findByRole('option', { name: 'bad id' });
  fireEvent.change(screen.getByRole('combobox', { name: 'Agent' }), { target: { value: 'bad id' } });
  expect(screen.getByText('Invalid agent identifier.')).toBeInTheDocument();
  expect(fetcher.mock.calls.filter(([url]) => url.startsWith(`${path}?`))).toHaveLength(0);
});

it('shows an empty scoped result and hides results from an older server', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => Response.json(url === path || url === `${path}?agent=old` ? global
    : url === `${path}?agent=empty` ? { ...global, scope: { kind: 'agent', agentId: 'empty' }, edges: [] } : runs)));
  render(<FleetGraphPane visible />);
  await screen.findByRole('option', { name: 'empty' });
  const select = screen.getByRole('combobox', { name: 'Agent' });
  fireEvent.change(select, { target: { value: 'empty' } });
  expect(await screen.findByText('no routes recorded for this agent')).toBeInTheDocument();
  fireEvent.change(select, { target: { value: 'old' } });
  await waitFor(() => expect(fetch).toHaveBeenCalledWith(`${path}?agent=old`, expect.anything()));
  expect(screen.queryByText('no routes recorded for this agent')).not.toBeInTheDocument();
});
