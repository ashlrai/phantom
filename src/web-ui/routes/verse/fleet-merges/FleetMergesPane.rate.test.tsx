import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { evictAll } from '../../../data/cache.js';
import type { PaneProps } from '../panes/pane-registry.js';
import { FleetMergesPane } from './FleetMergesPane.js';

const props = { visible: true } as PaneProps;

beforeEach(() => evictAll());
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it('renders normalized merge rates and omits a zero rate when there were no merges', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({
    mergesLastHour: { count: 0, items: [] },
    publishesLastHour: [],
    lanes: [
      { lane: 'fraction', merged24h: 42, mergeRate24h: 0.627 },
      { lane: 'percent', merged24h: 4, mergeRate24h: 75 },
      { lane: 'empty', merged24h: 0, mergeRate24h: 0 },
      { lane: 'zero-rate', merged24h: 1, mergeRate24h: 0 },
    ],
    sources: { merges: 'healthy' },
  })));
  render(<FleetMergesPane {...props} />);
  const lanes = within(await screen.findByRole('list', { name: 'Lane throughput' }));
  expect(lanes.getByText('fraction').closest('li')).toHaveTextContent('42 merged · 62.7%');
  expect(lanes.getByText('percent').closest('li')).toHaveTextContent('4 merged · 75.0%');
  expect(lanes.getByText('empty').closest('li')).toHaveTextContent('0 merged · —');
  expect(lanes.getByText('zero-rate').closest('li')).toHaveTextContent('1 merged · 0.0%');
});
