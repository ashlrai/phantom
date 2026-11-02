import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { evictAll } from '../../../data/cache.js';
import type { PaneProps } from '../panes/pane-registry.js';
import { FleetSupplyPane } from './FleetSupplyPane.js';
import { supplyFixture } from './supply-fixture.js';

const props = { visible: true } as PaneProps;
beforeEach(() => evictAll());
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it('shows each lane yield and ranks spending above the supply table', async () => {
  const fixture = supplyFixture();
  const lanes = fixture.lanes.map(lane => ({ ...lane,
    tokensLastHour: lane.lane === 'held' ? 0 : 41_000,
    merged24h: lane.lane === 'over' ? 0 : 9,
    mergeRate24h: lane.lane === 'over' ? 0 : 0.4,
  }));
  vi.stubGlobal('fetch', vi.fn(async (url: string) => Response.json(url.includes('/fleet/runs') ? { ...fixture, lanes } : { lanes: [] })));
  render(<FleetSupplyPane {...props} />);
  const table = await screen.findByRole('table', { name: 'Job supply per lane' });
  expect(within(table).getAllByTestId('lane-yield')).toHaveLength(3);
  expect(within(table).getByText('41k tokens/h · 9 merged in 24 h (0.4/h) · about 100k tokens per merge')).toBeInTheDocument();
  const section = screen.getByRole('region', { name: 'Where tokens go' });
  expect(within(section).getAllByRole('listitem').map(item => item.textContent)).toEqual([
    'over: 41k tokens/h · no merges in 24 h · lower the target',
    'active: 41k tokens/h · 9 merged in 24 h (0.4/h) · about 100k tokens per merge · raise the target',
  ]);
  expect(section.compareDocumentPosition(table) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
});

it('does not show yield lines or a ranking for an older snapshot', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => Response.json(url.includes('/fleet/runs') ? supplyFixture() : { lanes: [] })));
  render(<FleetSupplyPane {...props} />);
  await screen.findByRole('table', { name: 'Job supply per lane' });
  expect(screen.queryByTestId('lane-yield')).not.toBeInTheDocument();
  expect(screen.queryByRole('region', { name: 'Where tokens go' })).not.toBeInTheDocument();
});
