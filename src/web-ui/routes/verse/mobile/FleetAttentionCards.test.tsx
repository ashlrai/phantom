import { screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { evictAll } from '../../../data/cache.js';
import { SectionVisibilityProvider } from '../shell/section-visibility.js';
import { FleetAttentionCards } from './FleetAttentionCards.js';
import { json, renderMobile, stubFetch } from './mobile.test-support.js';
import { NeedsYouScreen } from './screens/NeedsYouScreen.js';

const fixture = {
  v: 1, generatedAt: new Date().toISOString(),
  sources: { runsDir: 'healthy', workers: 'healthy', inbox: 'healthy', codex: 'healthy', merges: 'healthy' },
  lastTick: new Date().toISOString(), paused: false, memFreePct: 50, diskFreeGb: 80,
  claudeLane: 'down: quota', switches: [],
  lanes: [{ lane: 'claude', running: 0, target: 1, queued: 0, held: false, heldReason: null, tokensLastHour: null, merged24h: null, mergeRate24h: null }],
  workers: [], leaders: [{ label: 'leader', ageSeconds: 30 }], orchestratorAgents: 1,
  publishesLastHour: [], mergesLastHour: { count: 1, items: [] }, events: [], codexPersonal: null, inbox: [], drop: null,
};
afterEach(() => { evictAll(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('FleetAttentionCards', () => {
  it('shows the Claude lane and its Mac fix without issuing writes', async () => {
    const stub = stubFetch({ 'GET /api/verse/fleet/runs': fixture });
    renderMobile(<FleetAttentionCards />);
    expect(await screen.findByRole('heading', { name: 'Claude lane is down: 1 slots idle' })).toBeInTheDocument();
    expect(screen.getByText('~/.ashlr-runs/bin/fix-claude-lane.sh')).toBeInTheDocument();
    expect(stub.posts()).toHaveLength(0);
  });
  it('renders nothing when the endpoint is absent', async () => {
    const stub = stubFetch({ 'GET /api/verse/fleet/runs': json({}, 404) });
    const { container } = renderMobile(<FleetAttentionCards />);
    await waitFor(() => expect(stub.calls).toHaveLength(1));
    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });
  it('does not show All clear while fleet attention is present', async () => {
    stubFetch({ 'GET /api/verse/fleet/runs': fixture });
    renderMobile(<NeedsYouScreen />);
    expect(await screen.findByRole('heading', { name: 'Claude lane is down: 1 slots idle' })).toBeInTheDocument();
    expect(screen.queryByText('All clear')).not.toBeInTheDocument();
  });
  it('fetches and polls only while visible', async () => {
    vi.useFakeTimers();
    try {
      const stub = stubFetch({ 'GET /api/verse/fleet/runs': fixture });
      const { rerender, context } = renderMobile(<SectionVisibilityProvider visible={false}><FleetAttentionCards /></SectionVisibilityProvider>);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(stub.calls).toHaveLength(0);
      const { MobileContext } = await import('./mobile-context.js');
      rerender(<MobileContext.Provider value={context}><SectionVisibilityProvider visible><FleetAttentionCards /></SectionVisibilityProvider></MobileContext.Provider>);
      await vi.advanceTimersByTimeAsync(15_000);
      expect(stub.calls.length).toBeGreaterThanOrEqual(2);
    } finally { vi.useRealTimers(); }
  });
});
