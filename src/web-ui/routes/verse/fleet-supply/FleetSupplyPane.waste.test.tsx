import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { evictAll } from '../../../data/cache.js';
import type { ResourceLaneRow } from '../usage/fleet-ledger-model.js';
import type { PaneProps } from '../panes/pane-registry.js';
import { FleetSupplyPane } from './FleetSupplyPane.js';
import { supplyFixture } from './supply-fixture.js';

const now = Date.parse('2026-10-31T23:30:00Z');
const iso = (hours: number) => new Date(now + hours * 3_600_000).toISOString();
const lane = (overrides: Partial<ResourceLaneRow>): ResourceLaneRow => ({
  lane: 'Devin', running: 0, target: 1, held: false, window: 'weekly', usedPct: 0,
  creditsRemaining: null, resetAt: iso(9), burnPctPerHour: 0, tokensPerHour6h: null,
  projectedExhaustion: null, source: null, ...overrides,
});
const ledger = (lanes: ResourceLaneRow[]) => ({
  v: 1, generatedAt: iso(0), sources: { status: 'healthy', apiSpend: 'healthy' }, asOf: null, apiSpend: null, lanes,
});
const props = { visible: true } as PaneProps;
beforeEach(() => { evictAll(); vi.spyOn(Date, 'now').mockReturnValue(now); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('renders forecast lines in descending waste order with their tones', async () => {
  const data = ledger([
    lane({ lane: 'codex-personal', usedPct: 62, resetAt: iso(160), burnPctPerHour: 4 }),
    lane({ lane: 'claude', usedPct: 40, resetAt: iso(20), burnPctPerHour: null }),
    lane({ lane: 'cmp', window: 'credits' }),
    lane({}),
    lane({ lane: 'watch', usedPct: 80 }),
  ]);
  vi.stubGlobal('fetch', vi.fn(async (url: string) => Response.json(url.includes('/fleet/runs') ? supplyFixture() : data)));
  render(<FleetSupplyPane {...props} />);
  const section = await screen.findByRole('region', { name: 'Waste forecast' });
  expect(within(section).getByRole('heading')).toHaveTextContent('Waste forecast: 180 points unused across 3 lanes');
  const lines = within(section).getAllByRole('listitem');
  expect(lines.map(line => line.getAttribute('data-tone'))).toEqual(['bad', 'bad', 'warn', 'ok']);
  expect(lines.map(line => line.textContent)).toEqual([
    expect.stringContaining('Devin: 100% unused'), expect.stringContaining('claude: 60% unused'),
    expect.stringContaining('watch: 20% unused'), expect.stringContaining('codex-personal: 0% unused'),
  ]);
  expect(lines[1]).toHaveTextContent('burning unknown');
  expect(within(section).queryByText(/cmp:/)).not.toBeInTheDocument();
});

it('omits the section when the ledger has no weekly forecasts', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => Response.json(url.includes('/fleet/runs') ? supplyFixture() : ledger([lane({ lane: 'active', window: 'credits', creditsRemaining: 25 }), lane({ lane: 'uncapped', window: 'none' })]))));
  render(<FleetSupplyPane {...props} />);
  await screen.findByText('credits: 25 left');
  expect(screen.queryByRole('region', { name: 'Waste forecast' })).not.toBeInTheDocument();
});
