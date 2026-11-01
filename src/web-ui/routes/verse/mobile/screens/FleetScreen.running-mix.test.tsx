import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { evictAll } from '../../../../data/cache.js';
import { renderMobile, stubFetch } from '../mobile.test-support.js';
import { FleetScreen } from './FleetScreen.js';

function fixture(filler: number, total = 16) {
  return {
    v: 1, generatedAt: '2026-10-31T00:00:00Z',
    sources: { runsDir: 'healthy', workers: 'healthy', inbox: 'healthy', codex: 'healthy', merges: 'healthy' },
    lastTick: null, paused: false, memFreePct: null, diskFreeGb: null, host: null,
    switches: [], claudeLane: null, lanes: [],
    workers: Array.from({ length: total }, (_, i) => ({
      job: i < filler ? `RQ-ABC${i}A20261031Q8` : `RQ-PHX-job-${i}`,
      repo: 'example/fake', lane: 'codex-personal', tier: 'fake', ageSeconds: null,
    })),
    claimed: [{ job: 'RQ-ABC9A20261031Q8', lane: 'codex-personal', tier: 'fake', at: '2026-10-31T00:00:00Z' }],
    leaders: [], orchestratorAgents: null, publishesLastHour: [], mergesLastHour: { count: 0, items: [] },
    events: [], codexPersonal: null, inbox: [], drop: null,
  };
}

afterEach(() => {
  evictAll();
  vi.unstubAllGlobals();
  document.head.querySelector('meta[name="ashlr-remote-gateway"]')?.remove();
});

it.each([['local', 6, 'warning'], ['remote', 6, 'warning'], ['remote', 2, 'neutral']])(
  'shows the same running mix in %s mode with %i filler workers', async (mode, filler, tone) => {
    if (mode === 'remote') {
      const marker = document.createElement('meta');
      marker.name = 'ashlr-remote-gateway';
      marker.content = 'v1';
      document.head.appendChild(marker);
    }
    const fetch = stubFetch({ 'GET /api/verse/fleet/runs': fixture(filler) });
    renderMobile(<FleetScreen />);
    const section = await screen.findByRole('region', { name: 'Running mix' });
    expect(within(section).getByText('codex-personal')).toBeInTheDocument();
    expect(within(section).getByText(`16 running · ${filler} filler`)).toBeInTheDocument();
    const text = `${16 - filler} Phantom · ${filler} filler (${filler === 6 ? '37.5' : '12.5'}%)`;
    expect(within(section).getByText(text).closest('[data-tone]')).toHaveAttribute('data-tone', tone);
    expect(fetch.calls.filter((call) => call.url === '/api/verse/fleet/runs').length).toBeGreaterThanOrEqual(1);
    expect(fetch.calls.every((call) => call.method === 'GET')).toBe(true);
    const paths = new Set(fetch.calls.map((call) => call.url.split('?')[0]));
    const existingPaths = new Set([
      '/api/verse/control', '/api/verse/fleet/live', '/api/verse/fleet/runs',
      '/api/verse/leader/resources', '/api/verse/authority', '/api/verse/budget',
      '/api/verse/authority/ledger', '/api/verse/fleet/live/queue',
      '/api/verse/fleet/control/switches', '/api/verse/release-pr',
    ]);
    expect([...paths].filter((path) => !existingPaths.has(path!))).toEqual([]);
  },
  20_000,
);

it('omits the section when there are no workers, even with claims', async () => {
  const fetch = stubFetch({ 'GET /api/verse/fleet/runs': fixture(0, 0) });
  renderMobile(<FleetScreen />);
  await waitFor(() => expect(fetch.calls.some((call) => call.url === '/api/verse/fleet/runs')).toBe(true));
  await screen.findByText('Mac host numbers unavailable');
  expect(screen.queryByRole('region', { name: 'Running mix' })).not.toBeInTheDocument();
});
