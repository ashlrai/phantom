import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import { FleetSection } from '../sections/FleetSection.js';
import { evictAll } from '../../../data/cache.js';
import { clearMutationToken } from '../../../data/auth-store.js';
import { stubSurfaceFetch } from '../command/fetch-stub.test-support.js';
import { fleetControl } from '../command/fixtures.test-support.js';
import { resetCommandBus } from '../shell/command-bus.js';
import { mockWideViewport, type ViewportMock } from '../shell/viewport.test-support.js';
import { resetVerseUi } from '../verse-ui-store.js';
let vp: ViewportMock | null = null;
beforeEach(() => {
  evictAll();
  resetCommandBus();
  resetVerseUi();
  clearMutationToken();
  vp = mockWideViewport();
});
afterEach(() => {
  vi.unstubAllGlobals();
  clearMutationToken();
  vp?.restore();
  delete (window as unknown as { __ASHLR_DESKTOP__?: unknown }).__ASHLR_DESKTOP__;
});

async function control(): Promise<HTMLElement> {
  const region = await screen.findByRole('region', { name: 'Fleet control' });
  await waitFor(() => expect(region).not.toHaveAttribute('data-state', 'unknown'));
  return region;
}


it.each([false, true])('dispatchd reading failure=%s preserves the appropriate headline', async fail => {
    const now = Date.now();
    const preparing = fleetControl('live', now, { working: 0 });
    preparing.state = 'running';
    preparing.headline = 'Running · preparing work: selection and dispatch · stage shadow';
    preparing.daemon.tickProgress = { phase: 'selection and dispatch', detail: null,
      tickStartedAt: new Date(now - 60_000).toISOString(), phaseStartedAt: new Date(now - 30_000).toISOString(),
      summary: 'tick in progress: selection and dispatch for 30s' };
    preparing.daemon.lastTickAt = new Date(now - 2 * 86_400_000).toISOString();
    stubSurfaceFetch({ kind: 'live', now, routes: { '/api/verse/fleet/control': preparing, '/api/verse/fleet/runs': () => fail ? new Response('failed', { status: 500 }) : new Response(JSON.stringify({ v: 1, lastTick: new Date(now - 60_000).toISOString(), claudeLane: null, switches: [], lanes: [{ lane: 'codex', running: 22, target: 22, queued: 0, held: false }], mergesLastHour: { count: 0 }, codexPersonal: null }), { headers: { 'Content-Type': 'application/json' } }) } });
    render(<FleetSection />);
    const region = await control();
    const header = within(region).getByText('Preparing work').closest('p')!;
    await waitFor(() => expect(header).toHaveTextContent(fail ? '0 agents working · selection and dispatch' : 'Phantom daemon idle · dispatchd 22 working · selection and dispatch'));
    if (!fail) {
      expect(header).not.toHaveTextContent('0 agents working');
      expect(region).toHaveTextContent('dispatchd · 22 workers on 1 lane · read 1 m ago');
    }
});
