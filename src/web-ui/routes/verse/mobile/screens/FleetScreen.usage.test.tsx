import { screen, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { evictAll } from '../../../../data/cache.js';
import type { ResourceLedgerV1 } from '../../usage/fleet-ledger-model.js';
import { renderMobile, stubFetch } from '../mobile.test-support.js';
import { FleetScreen, refreshFleetScreen } from './FleetScreen.js';

it('shows the usage section and includes its ledger in pull-to-refresh', async () => {
  const now = Date.now();
  const lane = {
    lane: 'Codex', running: 2, target: 4, held: false, window: 'weekly' as const,
    usedPct: 72, creditsRemaining: null, resetAt: null, burnPctPerHour: 1.4,
    tokensPerHour6h: null, projectedExhaustion: new Date(now + 3_600_000).toISOString(), source: 'status',
  };
  const ledger: ResourceLedgerV1 = {
    v: 1, generatedAt: new Date(now).toISOString(), sources: { status: 'healthy', apiSpend: 'missing' },
    asOf: new Date(now).toISOString(), lanes: [lane, { ...lane, lane: 'Claude' }], apiSpend: null,
  };
  const stub = stubFetch({ 'GET /api/verse/leader/resources': ledger });
  renderMobile(<FleetScreen />);

  const section = screen.getByRole('region', { name: 'Usage' });
  expect(await within(section).findByText('Codex')).toBeInTheDocument();
  expect(within(section).getByText('Claude')).toBeInTheDocument();
  await refreshFleetScreen();
  expect(stub.calls.filter((call) => call.url === '/api/verse/leader/resources')).toHaveLength(2);
});

afterEach(() => {
  evictAll();
  vi.unstubAllGlobals();
});
