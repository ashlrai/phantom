import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, within } from '@testing-library/react';
import { evictAll } from '../../../data/cache.js';
import { SectionVisibilityProvider } from '../shell/section-visibility.js';
import { FleetLedgerCard } from './FleetLedgerCard.js';
import type { ResourceLaneRow, ResourceLedgerV1 } from './fleet-ledger-model.js';

const now = Date.parse('2026-01-01T12:00:00Z');
const lane = (overrides: Partial<ResourceLaneRow> = {}): ResourceLaneRow => ({ lane: 'Codex', running: 8, target: 24, held: false, window: 'weekly', usedPct: 72, creditsRemaining: null, resetAt: null, burnPctPerHour: 1.4, tokensPerHour6h: null, projectedExhaustion: null, source: 'dispatchd at 11:56', ...overrides });
const fixture: ResourceLedgerV1 = { v: 1, generatedAt: new Date(now).toISOString(), sources: { status: 'healthy', apiSpend: 'healthy' }, asOf: new Date(now - 4 * 60_000).toISOString(), lanes: [lane(), lane({ lane: 'Claude', held: true, usedPct: 90 }), lane({ lane: 'Credits', window: 'credits', usedPct: null, creditsRemaining: 6000 }), lane({ lane: 'Local', window: 'none', usedPct: null })], apiSpend: { rowsToday: 12, errorsToday: 1, tokensOutToday: 48000, tokensInToday: 2000, usdToday: 3.2, usdWeek: 5, lastAt: new Date(now).toISOString(), models: ['fake-model'] } };

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
const mount = (visible = true) => render(<SectionVisibilityProvider visible={visible}><FleetLedgerCard now={now} /></SectionVisibilityProvider>);
beforeEach(() => { evictAll(); });
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
describe('FleetLedgerCard', () => {
  it('shows four lanes with attribution, caption, held state and gift pool', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json(fixture)));
    mount();
    expect(await screen.findByText('ledger as of 4 min ago')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Fleet resource ledger' })).toBeInTheDocument();
    const table = screen.getByRole('table');
    expect(within(table).getAllByRole('row')).toHaveLength(5);
    expect(within(table).getByText('Weekly window only. No 5-hour limit.')).toBeInTheDocument();
    expect(within(table).getByText('Held')).toBeInTheDocument();
    expect(within(table).getAllByTitle('dispatchd at 11:56')).toHaveLength(4);
    expect(within(table).getByText('6 000 credits left')).toBeInTheDocument();
    expect(screen.getByText('Gift pool today: 12 runs · 1 error · 48 k tokens out · $3.20')).toBeInTheDocument();
  });
  it('explains a missing endpoint', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('missing', { status: 404 })));
    mount();
    expect(await screen.findByText('The resource ledger API has not landed in this build yet.')).toBeInTheDocument();
  });
  it('explains missing dispatchd status', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ ...fixture, sources: { ...fixture.sources, status: 'missing' }, lanes: [] })));
    mount();
    expect(await screen.findByText('dispatchd has not written queue/status.json yet.')).toBeInTheDocument();
  });
  it('polls only while the section is visible and refreshes when reopened', async () => {
    const fetcher = vi.fn(async () => json(fixture));
    vi.stubGlobal('fetch', fetcher);
    vi.useFakeTimers();
    const view = mount();
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(screen.getByText('ledger as of 4 min ago')).toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(fetcher).toHaveBeenCalledTimes(2);
    view.rerender(<SectionVisibilityProvider visible={false}><FleetLedgerCard now={now} /></SectionVisibilityProvider>);
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(fetcher).toHaveBeenCalledTimes(2);
    view.rerender(<SectionVisibilityProvider visible><FleetLedgerCard now={now} /></SectionVisibilityProvider>);
    await act(async () => { await Promise.resolve(); });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
});
