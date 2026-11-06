import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { evictAll } from '../../../data/cache.js';
import { fleetRunsFixture } from '../fleet/fleet-runs-fixtures.test-support.js';
import { openInterjectDialog } from '../fleet/interject-dialog-store.js';
import type { PaneProps } from '../panes/pane-registry.js';
import { FleetDispatchPane } from './FleetDispatchPane.js';

const mocks = vi.hoisted(() => ({ runsFetch: vi.fn() }));

vi.mock('../fleet/interject-dialog-store.js', () => ({ openInterjectDialog: vi.fn() }));
vi.mock('../fleet-usage/fleet-usage-queries.js', () => ({
  fleetUsageRunsQuery: { key: 'test-running-mix', fetch: mocks.runsFetch },
}));

const props = { visible: true, roots: [], host: { openTerminal: vi.fn() } } as unknown as PaneProps;
const worker = (job: string) => ({ job, lane: 'codex-personal', repo: 'fake/repo', tier: 'mid', ageSeconds: 10 });
const jobs = (phx: number, fixup: number, filler: number) => [
  ...Array.from({ length: phx }, (_, i) => worker(`RQ-PHX-${i}`)),
  ...Array.from({ length: fixup }, (_, i) => worker(`RQ-FIXUP-${i}`)),
  ...Array.from({ length: filler }, (_, i) => worker(`RQ-ABC${i}A20261031Q8`)),
];

beforeEach(() => { evictAll(); vi.mocked(openInterjectDialog).mockClear(); mocks.runsFetch.mockReset(); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('renders the running mix without a leader button below the threshold', async () => {
  const snapshot = fleetRunsFixture({ claudeLane: null, workers: jobs(12, 2, 4) });
  mocks.runsFetch.mockResolvedValue(snapshot);
  vi.stubGlobal('fetch', vi.fn(async () => Response.json(snapshot)));
  render(<FleetDispatchPane {...props} />);
  const section = await screen.findByRole('region', { name: 'Running mix' });
  expect(within(within(section).getByRole('list')).getByText(/12 Phantom, 2 fix-ups, 4 filler \(22%\)/)).toBeInTheDocument();
  expect(within(section).queryByRole('button', { name: /Tell the leaders about filler/ })).not.toBeInTheDocument();
});

it('opens a prefilled leader handoff when filler reaches the threshold', async () => {
  const snapshot = fleetRunsFixture({ claudeLane: null, workers: jobs(10, 0, 6) });
  mocks.runsFetch.mockResolvedValue(snapshot);
  vi.stubGlobal('fetch', vi.fn(async () => Response.json(snapshot)));
  render(<FleetDispatchPane {...props} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Tell the leaders about filler on codex-personal' }));
  expect(openInterjectDialog).toHaveBeenCalledExactlyOnceWith({ prefill: 'Lane codex-personal is running 6 filler jobs of 16 (38%). Prefer Phantom drop jobs; keep 20+ PHX lines in ready.' });
});

it('shows the empty headline without rows when runs are null', async () => {
  mocks.runsFetch.mockResolvedValue(null);
  vi.stubGlobal('fetch', vi.fn(async () => Response.json(fleetRunsFixture({ claudeLane: null }))));
  render(<FleetDispatchPane {...props} />);
  const section = await screen.findByRole('region', { name: 'Running mix' });
  expect(within(section).getByText('nothing running')).toBeInTheDocument();
  expect(within(section).queryByRole('list')).not.toBeInTheDocument();
});
