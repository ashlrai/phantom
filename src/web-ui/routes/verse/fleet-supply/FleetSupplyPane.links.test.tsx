import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { evictAll } from '../../../data/cache.js';
import { openDockPane } from '../dock/dock-store.js';
import type { PaneProps } from '../panes/pane-registry.js';
import { FleetSupplyPane } from './FleetSupplyPane.js';
import { supplyFixture } from './supply-fixture.js';

vi.mock('../dock/dock-store.js', () => ({ openDockPane: vi.fn() }));

const now = new Date(2026, 10, 4, 7, 30).getTime();
const ledger = {
  v: 1, generatedAt: new Date(now).toISOString(), sources: { status: 'healthy', apiSpend: 'healthy' }, asOf: null, apiSpend: null,
  lanes: [{ lane: 'active', running: 3, target: 8, held: false, window: 'weekly', usedPct: 77, creditsRemaining: null, resetAt: null, burnPctPerHour: 5, tokensPerHour6h: null, projectedExhaustion: new Date(now + 4 * 3_600_000).toISOString(), source: null }],
};
const props = { visible: true } as PaneProps;
beforeEach(() => { evictAll(); vi.spyOn(Date, 'now').mockReturnValue(now); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function showSupply(fixture = supplyFixture()) {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => Response.json(url.includes('/fleet/runs') ? fixture : ledger)));
  render(<FleetSupplyPane {...props} />);
}

it('opens Lanes when a lane name is clicked', async () => {
  showSupply();
  fireEvent.click(await screen.findByRole('button', { name: 'Open Lanes pane (active)' }));
  expect(openDockPane).toHaveBeenCalledExactlyOnceWith('fleet-lanes');
});

it('opens Usage when an exhaustion tag is clicked', async () => {
  showSupply();
  const button = await screen.findByRole('button', { name: /^runs out ≈ 11:30 .* \(in 4 h\)$/ });
  expect(button).toHaveAttribute('data-tone', 'warn');
  fireEvent.click(button);
  expect(openDockPane).toHaveBeenCalledExactlyOnceWith('fleet-usage');
});

it('shows the total shortfall in the heading', async () => {
  showSupply();
  expect(await screen.findByRole('heading', { name: /Shortfall 5 slots/ })).toBeInTheDocument();
});

it('shows seven slots when seven are short', async () => {
  const fixture = supplyFixture();
  fixture.drop.pending = [];
  showSupply(fixture);
  expect(await screen.findByRole('heading', { name: /Shortfall 7 slots/ })).toBeInTheDocument();
});

it('omits the shortfall when all lanes are supplied', async () => {
  const fixture = supplyFixture();
  fixture.lanes = fixture.lanes.map(lane => ({ ...lane, queued: 20 }));
  showSupply(fixture);
  expect(await screen.findByRole('heading', { name: /^Lanes are supplied/ })).not.toHaveTextContent('Shortfall');
});
