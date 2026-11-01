import { screen, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { evictAll } from '../../../../data/cache.js';
import type { ResourceLaneRow, ResourceLedgerV1 } from '../../usage/fleet-ledger-model.js';
import { json, renderMobile, stubFetch } from '../mobile.test-support.js';
import { FleetScreen } from './FleetScreen.js';

function ledger(window: ResourceLaneRow['window']): ResourceLedgerV1 {
  const now = Date.now();
  return {
    v: 1, generatedAt: new Date(now).toISOString(), sources: { status: 'healthy', apiSpend: 'missing' }, asOf: null, apiSpend: null,
    lanes: [{
      lane: 'codex-personal', window, usedPct: 10, resetAt: new Date(now + 6 * 3_600_000).toISOString(),
      burnPctPerHour: 0, held: false, running: null, target: null, creditsRemaining: null,
      tokensPerHour6h: null, projectedExhaustion: null, source: 'status',
    }],
  };
}

afterEach(() => {
  evictAll();
  vi.unstubAllGlobals();
});

it('shows the shared forecast and tone for a weekly lane', async () => {
  stubFetch({ 'GET /api/verse/leader/resources': ledger('weekly') });
  renderMobile(<FleetScreen />);
  const section = screen.getByRole('region', { name: 'Waste forecast' });
  const row = await within(section).findByText(/codex-personal: 90% unused at reset/);
  expect(row.closest('[data-tone]')).toHaveAttribute('data-tone', 'bad');
  expect(within(section).getByText('Waste forecast: 90 points unused across 1 lane')).toBeInTheDocument();
});

it('shows an empty state when no weekly windows are reported', async () => {
  stubFetch({ 'GET /api/verse/leader/resources': ledger('credits') });
  renderMobile(<FleetScreen />);
  const section = screen.getByRole('region', { name: 'Waste forecast' });
  expect(await within(section).findByText('No weekly windows reported')).toBeInTheDocument();
});

it('reports a failed ledger read', async () => {
  stubFetch({ 'GET /api/verse/leader/resources': () => json({ error: 'ledger store offline' }, 500) });
  renderMobile(<FleetScreen />);
  const section = screen.getByRole('region', { name: 'Waste forecast' });
  expect(await within(section).findByText('Couldn’t read waste forecast')).toBeInTheDocument();
  expect(within(section).getByText('ledger store offline')).toBeInTheDocument();
});
