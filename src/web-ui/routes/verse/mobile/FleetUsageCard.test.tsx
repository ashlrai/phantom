import { screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { evictAll } from '../../../data/cache.js';
import type { ResourceLedgerV1 } from '../usage/fleet-ledger-model.js';
import { FleetUsageCard } from './FleetUsageCard.js';
import { json, renderMobile, stubFetch } from './mobile.test-support.js';

function ledger(): ResourceLedgerV1 {
  const now = Date.now();
  const lane = {
    lane: 'Codex', running: 2, target: 4, held: false, window: 'weekly' as const,
    usedPct: 72, creditsRemaining: null, resetAt: null, burnPctPerHour: 1.4,
    tokensPerHour6h: null, projectedExhaustion: new Date(now + 3_600_000).toISOString(), source: 'status',
  };
  return {
    v: 1, generatedAt: new Date(now).toISOString(), sources: { status: 'healthy', apiSpend: 'healthy' },
    asOf: new Date(now - 4 * 60_000).toISOString(),
    lanes: [lane, { ...lane, lane: 'Claude', window: 'credits', usedPct: null, creditsRemaining: 600, projectedExhaustion: null, burnPctPerHour: null }],
    apiSpend: { rowsToday: 2, errorsToday: 0, tokensOutToday: 1000, tokensInToday: 200, usdToday: 1.25, usdWeek: 2, lastAt: new Date(now).toISOString(), models: ['fake-model'] },
  };
}

afterEach(() => {
  evictAll();
  vi.unstubAllGlobals();
});

describe('FleetUsageCard', () => {
  it('shows each lane, its usage, forecast, source and ledger age', async () => {
    const stub = stubFetch({ 'GET /api/verse/leader/resources': ledger() });
    renderMobile(<FleetUsageCard />);

    expect(await screen.findByText('Codex')).toBeInTheDocument();
    expect(screen.getByText('Claude')).toBeInTheDocument();
    expect(screen.getByText(/runs out ~/)).toBeInTheDocument();
    expect(screen.getByText('72 % of weekly')).toBeInTheDocument();
    expect(screen.getByText('600 credits left')).toBeInTheDocument();
    expect(screen.getByText('source: dispatchd status')).toBeInTheDocument();
    expect(screen.getByText(/ledger as of \d+ min ago/)).toHaveTextContent('Gift pool today: 2 runs · 0 errors · 1 k tokens out · $1.25');
    expect(stub.calls.map((call) => call.url)).toEqual(['/api/verse/leader/resources']);
  });

  it('shows the fallback when the ledger route returns 404', async () => {
    stubFetch({ 'GET /api/verse/leader/resources': json({ error: 'not found' }, 404) });
    renderMobile(<FleetUsageCard />);
    expect(await screen.findByText('Ledger not readable from this Mac yet')).toBeInTheDocument();
  });
});
