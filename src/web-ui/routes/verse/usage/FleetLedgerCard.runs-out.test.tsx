import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { evictAll } from '../../../data/cache.js';
import { SectionVisibilityProvider } from '../shell/section-visibility.js';
import { FleetLedgerCard } from './FleetLedgerCard.js';
import type { ResourceLaneRow, ResourceLedgerV1 } from './fleet-ledger-model.js';

const now = Date.parse('2026-10-31T12:00:00Z');
const lane: ResourceLaneRow = {
  lane: 'codex-personal', running: null, target: null, held: false, window: 'weekly',
  usedPct: 70, creditsRemaining: null, resetAt: null, burnPctPerHour: 4.1,
  tokensPerHour6h: null, projectedExhaustion: '2026-10-31T13:30:00Z', source: null,
};
const fixture: ResourceLedgerV1 = {
  v: 1, generatedAt: new Date(now).toISOString(), sources: { status: 'healthy', apiSpend: 'missing' },
  asOf: new Date(now).toISOString(), lanes: [lane, { ...lane, lane: 'other', projectedExhaustion: null, burnPctPerHour: null }], apiSpend: null,
};

beforeEach(() => { evictAll(); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('shows the soonest lane in the header and a danger-toned projection in its row', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(fixture), { status: 200 })));
  render(<SectionVisibilityProvider visible><FleetLedgerCard now={now} /></SectionVisibilityProvider>);
  expect(await screen.findByText('soonest: codex-personal ~09:30 ET')).toBeInTheDocument();
  const row = screen.getByRole('row', { name: /codex-personal/ });
  expect(within(row).getByText('runs out ~09:30 ET (1.5 h) · 4.1 %/h')).toHaveAttribute('data-tone', 'danger');
  expect(within(screen.getByRole('row', { name: /other/ })).queryByText(/runs out ~/)).not.toBeInTheDocument();
});
