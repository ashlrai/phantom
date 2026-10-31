import { screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { evictAll } from '../../../../data/cache.js';
import { authorityStatus, budgetView, fleetLive } from '../../command/fixtures.test-support.js';
import { decisionsView } from '../../command/ladder-fixtures.test-support.js';
import { controlSnapshot } from '../../sections/section-fixtures.test-support.js';
import { json, renderMobile, stubFetch } from '../mobile.test-support.js';
import { FleetScreen, refreshFleetScreen } from './FleetScreen.js';

const NOW = Date.parse('2026-10-31T12:00:00Z');
const runs = {
  v: 1, generatedAt: new Date(NOW).toISOString(),
  sources: { runsDir: 'healthy', workers: 'healthy', inbox: 'healthy', codex: 'healthy', merges: 'healthy' },
  lastTick: new Date(NOW - 20_000).toISOString(), paused: false, memFreePct: 18, diskFreeGb: 41,
  host: { load1: 12.4, load5: 10, load15: 8, cores: 16, ratio: 0.8 },
  switches: [], claudeLane: null, lanes: [], workers: [], leaders: [], orchestratorAgents: null,
  publishesLastHour: [], mergesLastHour: { count: 0, items: [] }, events: [], codexPersonal: null, inbox: [], drop: null,
};

function mount(body: unknown = runs) {
  vi.spyOn(Date, 'now').mockReturnValue(NOW);
  const fetch = stubFetch({
    'GET /api/verse/control': controlSnapshot(),
    'GET /api/verse/fleet/live': fleetLive('live', NOW),
    'GET /api/verse/authority': authorityStatus('live', NOW),
    'GET /api/verse/budget': budgetView('live', NOW),
    'GET /api/verse/authority/ledger': decisionsView(NOW),
    'GET /api/verse/fleet/runs': body,
  });
  renderMobile(<FleetScreen />);
  return fetch;
}

afterEach(() => {
  evictAll();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('FleetScreen Mac host', () => {
  it('shows the host readings and age', async () => {
    mount();
    const card = await screen.findByRole('region', { name: 'This Mac' });
    expect(await within(card).findByText('load 12.4 · mem 18% free · disk 41 GB free · read 20 s ago')).toBeInTheDocument();
    expect(within(card).queryByText('Mac host numbers unavailable')).not.toBeInTheDocument();
  });

  it.each([
    [{ diskFreeGb: 4 }, 'disk 4 GB free'],
    [{ memFreePct: 9 }, 'mem 9% free'],
  ])('warns when a host reading is low: %s', async (override, text) => {
    mount({ ...runs, ...override });
    const value = await screen.findByText(text);
    expect(value.closest('[data-tone]')).toHaveAttribute('data-tone', 'warning');
  });

  it('does not warn at the 10 GB and 10 percent boundaries', async () => {
    mount({ ...runs, diskFreeGb: 10, memFreePct: 10 });
    const card = await screen.findByRole('region', { name: 'This Mac' });
    expect(await within(card).findByText('load 12.4 · mem 10% free · disk 10 GB free · read 20 s ago')).toBeInTheDocument();
    expect(card.querySelector('[data-tone="warning"]')).toBeNull();
  });

  it('reports unavailable readings while keeping known values visible', async () => {
    mount({ ...runs, diskFreeGb: 4, memFreePct: null, host: null, lastTick: null });
    const card = await screen.findByRole('region', { name: 'This Mac' });
    expect(await within(card).findByText('Mac host numbers unavailable')).toBeInTheDocument();
    expect(within(card).getByText('disk 4 GB free').closest('[data-tone]')).toHaveAttribute('data-tone', 'warning');
  });

  it('reports a failed read as unavailable', async () => {
    mount(json({ error: 'Unavailable' }, 500));
    const card = await screen.findByRole('region', { name: 'This Mac' });
    expect(await within(card).findByText('Mac host numbers unavailable')).toBeInTheDocument();
  });

  it('includes the runs endpoint in screen refresh', async () => {
    const fetch = mount();
    await screen.findByText('load 12.4 · mem 18% free · disk 41 GB free · read 20 s ago');
    const before = fetch.calls.filter((call) => call.url === '/api/verse/fleet/runs').length;
    await refreshFleetScreen();
    expect(fetch.calls.filter((call) => call.url === '/api/verse/fleet/runs')).toHaveLength(before + 1);
  });
});
