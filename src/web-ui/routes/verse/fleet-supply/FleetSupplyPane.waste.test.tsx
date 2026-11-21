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

it('draws a row per weekly window in descending waste order, each on the shared bar', async () => {
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
  expect(lines.map(line => line.getAttribute('data-lane'))).toEqual(['Devin', 'claude', 'watch', 'codex-personal']);
  expect(lines.map(line => line.querySelector('strong')?.textContent)).toEqual(['Devin', 'claude', 'watch', 'codex-personal']);
  expect(lines.map(line => line.querySelector('[data-figure]')?.textContent)).toEqual([
    '100% unused at reset', 'up to 60% unused at reset', '20% unused at reset', '0% unused at reset',
  ]);
  expect(lines.map(line => within(line).getByText(/^(High|Watch|On track)$/).textContent)).toEqual(['High', 'High', 'Watch', 'On track']);
  expect(lines[0]!.querySelector('[data-facts]')).toHaveTextContent('resets in 9 h · needs 11.1%/h to use it all · burning 0%/h · 95% of the window gone, use is 95 points behind an even spend');
  expect(lines[1]).toHaveTextContent('burning unknown');
  // One meter per window, the same bar Pools and Home draw.
  expect(within(section).getAllByRole('meter')).toHaveLength(4);
  const devin = within(lines[0]!).getByRole('meter', { name: 'Devin weekly window' });
  expect(devin).toHaveAttribute('aria-valuetext', '0% used, 0% more by reset at the current burn, 100% unused; 95% of the window gone');
  expect(devin.querySelector('[data-part="unused"]')).toHaveStyle({ width: '100%' });
  expect(devin.querySelector('[data-part="elapsed"]')).toHaveStyle({ left: '94.6%' });
  // No measured burn: the used share and the time mark only, nothing projected.
  const claude = within(lines[1]!).getByRole('meter', { name: 'claude weekly window' });
  expect([...claude.querySelectorAll('[data-part]')].map(part => part.getAttribute('data-part'))).toEqual(['used', 'elapsed']);
  expect(claude).toHaveAttribute('aria-valuenow', '40');
  expect(claude).toHaveAttribute('aria-valuetext', '40% used, burn unknown, up to 60% unused; 88% of the window gone');
  const spent = within(lines[3]!).getByRole('meter', { name: 'codex-personal weekly window' });
  expect(spent.querySelector('[data-part="used"]')).toHaveStyle({ width: '62%' });
  expect(spent.querySelector('[data-part="more"]')).toHaveStyle({ width: '38%' });
  expect(spent.querySelector('[data-part="unused"]')).toBeNull();
  const key = section.querySelector('[data-waste-key]')!;
  expect(key).toHaveTextContent('used so far');
  expect(key).toHaveTextContent('left unused at the reset');
  expect(key).toHaveTextContent('time gone, counting seven days back from the reset');
  expect(key).toHaveTextContent('phm resources ledger');
  expect(within(section).queryByText(/cmp:/)).not.toBeInTheDocument();
});

it('omits the section when the ledger has no weekly forecasts', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => Response.json(url.includes('/fleet/runs') ? supplyFixture() : ledger([lane({ lane: 'active', window: 'credits', creditsRemaining: 25 }), lane({ lane: 'uncapped', window: 'none' })]))));
  render(<FleetSupplyPane {...props} />);
  await screen.findByText('credits: 25 left');
  expect(screen.queryByRole('region', { name: 'Waste forecast' })).not.toBeInTheDocument();
});
