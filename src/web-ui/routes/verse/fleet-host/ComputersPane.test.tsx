import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { evictAll } from '../../../data/cache.js';
import { getPane } from '../panes/pane-registry.js';
import { ComputersBody, ComputersPane } from './ComputersPane.js';
import { narrowComputers } from './computers-model.js';
import './computers.pane.js';

const GIB = 1024 ** 3;
const row = (name: string, o: Record<string, unknown> = {}) => ({
  name, isSelf: false, reachable: true, lastSeen: '2026-11-17T12:00:00.000Z', phantom: 'running', freeMemoryBytes: 12 * GIB,
  cpuHeadroomPercent: 75, lanes: ['claude', 'codex'], jobsRunning: [], freeSlots: 2, stateCode: 'ready', state: 'ready for work', ...o });
const payload = (nodes: unknown[], reasons: string[] = []) => ({ v: 1, schemaVersion: 1, asOf: '2026-11-17T12:00:00.000Z', self: 'node-a', registry: 'pool-witness', nodes, reasons });
const UNKNOWN = { freeMemoryBytes: 'unknown', cpuHeadroomPercent: 'unknown', lanes: 'unknown', jobsRunning: 'unknown', freeSlots: 'unknown' };

beforeEach(() => { evictAll(); });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it('renders one card per computer with the server state words', () => {
  render(<ComputersBody view={narrowComputers(payload([
    row('node-a', { isSelf: true, jobsRunning: ['job-1'] }),
    row('node-b', { ...UNKNOWN, reachable: false, phantom: 'not-running', stateCode: 'offline', state: 'offline since 10:42' }),
    row('node-c', { ...UNKNOWN, phantom: 'not-running', stateCode: 'not-running', state: 'reachable but Phantom not running: run `phm node join` there' }),
  ]))} />);
  expect(screen.getByText('1 of 3 ready for work')).toBeTruthy();
  expect(screen.getAllByRole('listitem')).toHaveLength(3);
  const self = within(screen.getByRole('listitem', { name: 'node-a' }));
  expect(self.getByText('· this computer')).toBeTruthy();
  expect(self.getByText('ready for work')).toBeTruthy();
  expect(self.getByText('12.0 GB')).toBeTruthy();
  expect(self.getByText('75%')).toBeTruthy();
  expect(self.getByText('claude, codex')).toBeTruthy();
  expect(self.getByText('1')).toBeTruthy();
  const offline = screen.getByRole('listitem', { name: 'node-b' });
  expect(offline.getAttribute('data-state')).toBe('offline');
  expect(within(offline).getByText('offline since 10:42')).toBeTruthy();
  expect(within(offline).getAllByText('unknown')).toHaveLength(4);
  expect(within(screen.getByRole('listitem', { name: 'node-c' })).getByText('reachable but Phantom not running: run `phm node join` there')).toBeTruthy();
  expect(screen.queryByText(/your only computer/)).toBeNull();
});

it('single computer: one card, how to add another, and the reason', () => {
  render(<ComputersBody view={narrowComputers(payload(
    [row('node-a', { ...UNKNOWN, isSelf: true, phantom: 'not-running', stateCode: 'not-running', state: 'reachable but Phantom not running: run `phm node join` here', freeMemoryBytes: 8 * GIB })],
    ['tailscale unavailable or status unreadable']))} />);
  expect(screen.getAllByRole('listitem')).toHaveLength(1);
  expect(screen.getByText('0 of 1 ready for work')).toBeTruthy();
  expect(screen.getByText(/This is your only computer so far/)).toBeTruthy();
  expect(screen.getByText('phm node join')).toBeTruthy();
  expect(screen.getByText('tailscale unavailable or status unreadable')).toBeTruthy();
});

it('narrow drops malformed rows and never invents a state', () => {
  expect(narrowComputers(null)).toBeNull();
  expect(narrowComputers({ nodes: 'x' })).toBeNull();
  const view = narrowComputers(payload(['junk', { state: 'ready for work' }, { name: 'node-x', stateCode: 'great', state: 'ready for work', freeMemoryBytes: -1, lanes: 'claude' }]));
  expect(view?.computers).toEqual([{ name: 'node-x', isSelf: false, stateCode: 'unknown', state: 'unknown',
    freeMemoryBytes: 'unknown', cpuHeadroomPercent: 'unknown', lanes: 'unknown', jobsRunning: 'unknown', freeSlots: 'unknown', joined: true, joinCommand: null }]);
});

it('registers a Computers pane that loads the cards from the API', async () => {
  expect(getPane('fleet-computers')).toMatchObject({ title: 'Computers', needsSession: false });
  const fetch = vi.fn(async (_url: string) => Response.json(payload([row('node-a', { isSelf: true }), row('node-b')])));
  vi.stubGlobal('fetch', fetch);
  render(<ComputersPane visible />);
  expect(await screen.findByText('2 of 2 ready for work')).toBeTruthy();
  expect(String(fetch.mock.calls[0]?.[0])).toContain('/api/verse/fleet/runtime-identity/nodes');
});

it('says so plainly when the list cannot be read', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 404 })));
  render(<ComputersPane visible />);
  expect(await screen.findByText('Computers are unavailable right now.')).toBeTruthy();
});

it('shows a not joined computer grey with the one command to join it', () => {
  const view = narrowComputers(payload([row('node-a', { isSelf: true }), row('studio-mac', { joined: false, joinCommand: 'phm node join', stateCode: 'not-running', state: 'x' })]));
  const { container } = render(<ComputersBody view={view} />);
  expect(container.querySelector('li[aria-label="studio-mac"]')?.getAttribute('data-state')).toBe('not-joined');
  expect(screen.getByText(/Not joined\. On studio-mac, run/)).toBeTruthy();
  expect(screen.getByText('1 of 2 ready for work')).toBeTruthy();
});
