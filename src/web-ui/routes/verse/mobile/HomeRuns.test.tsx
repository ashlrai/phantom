import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { evictAll } from '../../../data/cache.js';
import { SectionVisibilityProvider } from '../shell/section-visibility.js';
import { HomeRuns } from './HomeRuns.js';
import { homeRunsQuery } from './home-runs-query.js';
import { json, renderMobile, stubFetch } from './mobile.test-support.js';

const now = Date.parse('2026-10-31T12:00:00Z');
const fixture = {
  v: 1, lastTick: '2026-10-31T11:59:20Z', claudeLane: 'down: quota', switches: ['HOLD'],
  lanes: [{ lane: 'codex', running: 8, target: 24, queued: 4, held: false }],
  mergesLastHour: { count: 2 }, codexPersonal: { usedPct: 46, resetsAt: '2026-10-31T15:00:00Z' },
};
afterEach(() => { evictAll(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('HomeRuns', () => {
  it('renders the fleet rows and navigates from the headline', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(now);
    stubFetch({ 'GET /api/verse/fleet/runs': fixture });
    const { context } = renderMobile(<HomeRuns />);
    const headline = await screen.findByRole('button', { name: /8 running · 24 target/ });
    expect(screen.getByRole('heading', { name: 'Fleet now' })).toBeInTheDocument();
    expect(screen.getByText('Claude lane down')).toBeInTheDocument();
    expect(screen.getByText('tick 40 s ago')).toBeInTheDocument();
    expect(screen.getByText('codex')).toBeInTheDocument();
    expect(screen.getByText('8/24 · 4 queued')).toBeInTheDocument();
    expect(screen.getByText('2 merged last hour')).toBeInTheDocument();
    expect(screen.getByText('Personal Codex 46 % used · resets in 3 h')).toBeInTheDocument();
    fireEvent.click(headline);
    expect(context.navigate).toHaveBeenCalledWith({ screen: 'fleet' });
  });
  it('renders nothing after a 404 and accepts a later successful read', async () => {
    let available = false;
    stubFetch({ 'GET /api/verse/fleet/runs': () => available ? json(fixture) : json({}, 404) });
    const { container } = renderMobile(<HomeRuns />);
    await waitFor(() => expect(container).toBeEmptyDOMElement());
    available = true;
    expect(await homeRunsQuery.fetch()).toEqual(fixture);
  });
  it('shows a skeleton while loading', () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));
    renderMobile(<HomeRuns />);
    expect(screen.getByLabelText('Loading fleet numbers')).toBeInTheDocument();
  });
  it('shows a readable error for a failed or malformed response', async () => {
    stubFetch({ 'GET /api/verse/fleet/runs': json({ error: 'Fleet unavailable.' }, 503) });
    renderMobile(<HomeRuns />);
    expect(await screen.findByText('Fleet numbers unavailable: Fleet unavailable.')).toBeInTheDocument();
    stubFetch({ 'GET /api/verse/fleet/runs': { v: 1 } });
    await expect(homeRunsQuery.fetch()).rejects.toThrow('Invalid live runs response.');
  });
  it('polls only while visible', async () => {
    vi.useFakeTimers();
    try {
      const stub = stubFetch({ 'GET /api/verse/fleet/runs': fixture });
      const { rerender, context } = renderMobile(<SectionVisibilityProvider visible={false}><HomeRuns /></SectionVisibilityProvider>);
      await vi.advanceTimersByTimeAsync(20_000);
      expect(stub.calls).toHaveLength(1);
      const { MobileContext } = await import('./mobile-context.js');
      rerender(<MobileContext.Provider value={context}><SectionVisibilityProvider visible><HomeRuns /></SectionVisibilityProvider></MobileContext.Provider>);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(stub.calls.length).toBeGreaterThanOrEqual(3);
    } finally { vi.useRealTimers(); }
  });
});
