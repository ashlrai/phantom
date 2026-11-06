import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { evictAll } from '../../../data/cache.js';
import type { FleetRuns } from '../ops/ops-runs-model.js';
import { openDockPane, requestTerminal } from '../dock/dock-store.js';
import { FleetHostPane } from './FleetHostPane.js';

vi.mock('../dock/dock-store.js', () => ({ openDockPane: vi.fn(), requestTerminal: vi.fn() }));

const COMMAND = '~/.ashlr-runs/bin/fix-claude-lane.sh';
const base: FleetRuns = {
  v: 1, generatedAt: '2026-10-31T12:00:00Z', sources: { runsDir: 'healthy', workers: 'healthy', inbox: 'healthy', codex: 'healthy', merges: 'healthy' },
  lastTick: '2026-10-31T11:59:00Z', paused: false, memFreePct: 50, diskFreeGb: 80, switches: [], claudeLane: null,
  lanes: [], workers: [], leaders: [], orchestratorAgents: 1, publishesLastHour: [], mergesLastHour: { count: null, items: [] }, events: [], codexPersonal: null, inbox: [], drop: null,
};
const unhealthy: FleetRuns = { ...base, claudeLane: 'down: quota', host: { load1: 194, load5: 180, load15: 160, cores: 18, ratio: 10.8 } };

const serve = (data: unknown) => vi.stubGlobal('fetch', vi.fn(async () => Response.json(data)));
const stubClipboard = (writeText = vi.fn(async () => {})) =>
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
beforeEach(() => { evictAll(); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it('opens the Lanes pane from the CPU banner', async () => {
  serve(unhealthy); render(<FleetHostPane visible />);
  fireEvent.click(await screen.findByRole('button', { name: 'Open Lanes' }));
  expect(openDockPane).toHaveBeenCalledExactlyOnceWith('fleet-lanes');
});

it('copies the fix command and shows a transient Copied label', async () => {
  const writeText = vi.fn(async () => {}); stubClipboard(writeText);
  serve(unhealthy); render(<FleetHostPane visible />);
  const copy = await screen.findByRole('button', { name: 'Copy command' });
  vi.useFakeTimers();
  fireEvent.click(copy);
  await act(async () => {});
  expect(writeText).toHaveBeenCalledExactlyOnceWith(COMMAND);
  expect(screen.getByRole('button', { name: 'Copied' })).toBeInTheDocument();
  act(() => { vi.advanceTimersByTime(2_000); });
  expect(screen.getByRole('button', { name: 'Copy command' })).toBeInTheDocument();
});

it('shows Copy failed when the clipboard refuses', async () => {
  stubClipboard(vi.fn(async () => { throw new Error('denied'); }));
  serve(unhealthy); render(<FleetHostPane visible />);
  fireEvent.click(await screen.findByRole('button', { name: 'Copy command' }));
  expect(await screen.findByRole('button', { name: 'Copy failed' })).toBeInTheDocument();
});

it('copies the command and opens a terminal', async () => {
  const writeText = vi.fn(async () => {}); stubClipboard(writeText);
  serve(unhealthy); render(<FleetHostPane visible />);
  fireEvent.click(await screen.findByRole('button', { name: 'Open terminal' }));
  expect(requestTerminal).toHaveBeenCalledExactlyOnceWith({});
  await act(async () => {});
  expect(writeText).toHaveBeenCalledExactlyOnceWith(COMMAND);
});

it('renders no action buttons on a healthy host', async () => {
  serve(base); render(<FleetHostPane visible />);
  await screen.findByText('Claude lane');
  expect(screen.queryByRole('button', { name: 'Open Lanes' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Copy command' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Open terminal' })).not.toBeInTheDocument();
});
