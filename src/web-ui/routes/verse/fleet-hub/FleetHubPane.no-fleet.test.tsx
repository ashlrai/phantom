import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { evictAll } from '../../../data/cache.js';
import { apiGet } from '../../../data/client.js';
import { resetDockStore } from '../dock/dock-store.js';
import type { FleetRuns } from '../ops/ops-runs-model.js';
import { FleetHubPane } from './FleetHubPane.js';
import '../fleet-lanes/fleet-lanes.pane.js';

vi.mock('../../../data/client.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../../data/client.js')>(),
  apiGet: vi.fn(),
}));

const fixture: FleetRuns = {
  v: 1, generatedAt: '2026-10-31T12:00:00Z', sources: { runsDir: 'missing', workers: 'healthy', inbox: 'healthy', codex: 'healthy', merges: 'healthy' },
  lastTick: null, paused: null, memFreePct: null, diskFreeGb: null, switches: [], claudeLane: null,
  lanes: [], workers: [], leaders: [], orchestratorAgents: null, publishesLastHour: [], mergesLastHour: { count: 0, items: [] }, events: [], codexPersonal: null, inbox: [], drop: null,
};

beforeEach(() => {
  localStorage.clear(); resetDockStore(); evictAll(); vi.mocked(apiGet).mockReset();
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('shows the missing fleet card and copies the command instead of showing tiles', async () => {
  vi.mocked(apiGet).mockResolvedValue(fixture);
  const writeText = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal('navigator', { clipboard: { writeText } });
  render(<FleetHubPane visible />);
  const card = (await screen.findByText('No fleet on this Mac yet')).closest('[data-empty="no-fleet"]');
  expect(card).toHaveAttribute('role', 'status');
  expect(card).toHaveTextContent('~/.ashlr-runs');
  expect(within(card as HTMLElement).getByText('ashlr fleet init').tagName).toBe('CODE');
  expect(screen.queryByRole('button', { name: /^Lanes/ })).not.toBeInTheDocument();
  expect(screen.queryByText('Fleet events')).not.toBeInTheDocument();
  fireEvent.click(within(card as HTMLElement).getByRole('button', { name: 'Copy command' }));
  await waitFor(() => expect(writeText).toHaveBeenCalledWith('ashlr fleet init'));
  expect(await within(card as HTMLElement).findByRole('button', { name: 'Copied' })).toBeInTheDocument();
});

it('shows a reported runs directory when available', async () => {
  vi.mocked(apiGet).mockResolvedValue({ ...fixture, runsDir: '~/example-runs' });
  render(<FleetHubPane visible />);
  expect(await screen.findByText('~/example-runs')).toBeInTheDocument();
});

it('renders the existing tiles for a healthy fleet', async () => {
  vi.mocked(apiGet).mockResolvedValue({ ...fixture, sources: { ...fixture.sources, runsDir: 'healthy' } });
  render(<FleetHubPane visible />);
  expect(await screen.findByRole('button', { name: 'Lanes 0/0' })).toBeInTheDocument();
  expect(screen.getByText('Fleet events')).toBeInTheDocument();
  expect(screen.queryByText('No fleet on this Mac yet')).not.toBeInTheDocument();
});

it('keeps the tiles when the runs reader has not landed', async () => {
  vi.mocked(apiGet).mockResolvedValue({ ...fixture, sources: { ...fixture.sources, runsDir: 'not-landed' } });
  render(<FleetHubPane visible />);
  expect(await screen.findByRole('button', { name: 'Lanes 0/0' })).toBeInTheDocument();
  expect(screen.queryByText('No fleet on this Mac yet')).not.toBeInTheDocument();
});
