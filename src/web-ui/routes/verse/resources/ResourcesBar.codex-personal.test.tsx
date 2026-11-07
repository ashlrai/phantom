import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { evictAll } from '../../../data/cache.js';
import { installFetch, json } from '../context/context-fixtures.test-support.js';
import { SectionVisibilityProvider } from '../shell/section-visibility.js';
import { capacity, nativeSeat } from '../seat-fixtures.test-support.js';
import { useCapacityData } from '../usage/CapacityStrip.js';
import { ResourcesBar } from './ResourcesBar.js';
import { RESOURCE_ORDER_KEY, reloadResourceOrderForTest } from './resource-order.js';
import { closeResources, reloadResourcesUiForTest, RESOURCES_STORAGE_KEY, setResourcesBar } from './resources-store.js';

vi.mock('../usage/CapacityStrip.js', async (original) => ({
  ...await original<typeof import('../usage/CapacityStrip.js')>(), useCapacityData: vi.fn(),
}));

const NOW = Date.parse('2026-10-31T12:00:00.000Z');
const reading = { usedPct: 87, resetsAt: '2026-11-04T12:00:00.000Z', asOf: '2026-10-31T11:57:00.000Z' };

beforeEach(() => {
  evictAll(); localStorage.removeItem(RESOURCE_ORDER_KEY); reloadResourceOrderForTest();
  localStorage.removeItem(RESOURCES_STORAGE_KEY); reloadResourcesUiForTest(); closeResources();
  vi.mocked(useCapacityData).mockReturnValue({ seats: [nativeSeat(capacity(), { id: 'codex-seat', engine: 'codex', label: 'Codex seat' })],
    health: null, budget: null, loading: false, refreshing: false, readFailed: false, rosterUnavailable: false, pendingSeatIds: [] });
});
afterEach(() => {
  cleanup(); evictAll(); vi.restoreAllMocks(); vi.unstubAllGlobals();
  localStorage.removeItem(RESOURCE_ORDER_KEY); reloadResourceOrderForTest();
  localStorage.removeItem(RESOURCES_STORAGE_KEY); reloadResourcesUiForTest(); closeResources();
});

function mount(value: unknown, state = 'healthy', visible = true) {
  const fetch = installFetch(call => call.path === '/api/verse/fleet/runs'
    ? json({ sources: { codex: state }, codexPersonal: value }) : json({}));
  const view = render(<SectionVisibilityProvider visible={visible}><ResourcesBar expanded now={NOW} /></SectionVisibilityProvider>);
  // Session readings are supporting evidence, opened explicitly beside the account rows.
  fireEvent.click(screen.getByRole('button', { name: /Usage sources and budgets/ }));
  return { ...view, calls: fetch.calls };
}

describe('personal Codex session log resource', () => {
  it.each(['observation expiry', 'reset'])('invalidates at the exact %s between display polls without restamping or fetching', async kind => {
    const value = { ...reading,
      asOf: new Date(NOW - (kind === 'observation expiry' ? 15 * 60_000 - 1000 : 60_000)).toISOString(),
      resetsAt: new Date(NOW + (kind === 'reset' ? 1000 : 86_400_000)).toISOString() };
    const warm = mount(value);
    await warm.findByRole('button', { name: /Personal Codex weekly · 87% used/ });
    warm.unmount();
    vi.useFakeTimers(); vi.setSystemTime(NOW);
    try {
      const view = render(<SectionVisibilityProvider visible><ResourcesBar expanded /></SectionVisibilityProvider>);
      fireEvent.click(within(view.container).getByRole('button', { name: /Usage sources and budgets/ }));
      const row = view.container.querySelector('[data-resource-id="codex-personal:sessions"]')!;
      expect(row).toHaveTextContent('87% used');
      const reads = warm.calls.length;
      await act(async () => { await vi.advanceTimersByTimeAsync(999); });
      expect(row.querySelector('button')).toHaveAttribute('data-level', 'low');
      await act(async () => { await vi.advanceTimersByTimeAsync(1); });
      expect(row.querySelector('button')).toHaveAttribute('data-level', 'unknown');
      expect(row).toHaveTextContent('87% used · last');
      expect(row.querySelector('button')).toHaveAccessibleName(/Last session reading · current usage unconfirmed/);
      expect(warm.calls).toHaveLength(reads);
      expect(value.asOf).toBe(new Date(NOW - (kind === 'observation expiry' ? 15 * 60_000 - 1000 : 60_000)).toISOString());
    } finally { vi.useRealTimers(); }
  });

  it('shows the weekly reading, its provenance, remaining capacity and the existing seat', async () => {
    const view = mount(reading);
    const row = await waitFor(() => {
      const element = view.container.querySelector('[data-resource-id="codex-personal:sessions"]') as HTMLElement;
      expect(element).toHaveTextContent('87% used'); return element;
    });
    const ids = [...view.container.querySelectorAll('[data-resource-id]')].map(element => element.getAttribute('data-resource-id'));
    expect(ids.slice(0, 2)).toEqual(['account:codex-seat', 'codex-personal:sessions']);
    expect(row.querySelector('[data-level="low"]')).toBeInTheDocument();
    expect(row.querySelector('[class*="cell"]')).toHaveStyle({ '--fill': '13%' });
    fireEvent.focus(within(row).getByRole('button', { name: /Codex personal · session logs:/ }));
    expect(screen.getByRole('tooltip')).toHaveTextContent(/Personal Codex weekly · 87% used · resets .* · as of 3 min ago · from this Mac's session logs/);
  });

  it.each([[null, 'healthy'], [reading, 'degraded']] as const)('shows no reading for missing or unhealthy data (%s, %s)', async (value, state) => {
    const view = mount(value, state);
    await waitFor(() => expect(view.calls.some(call => call.path === '/api/verse/fleet/runs')).toBe(true));
    const row = view.container.querySelector('[data-resource-id="codex-personal:sessions"]') as HTMLElement;
    await waitFor(() => expect(within(row).getByRole('button', { name: new RegExp(`no session-log reading yet · source ${state}`) })).toBeInTheDocument());
    expect(row.querySelector('[data-unknown]')).toBeInTheDocument();
    expect(view.container.querySelector('[data-resource-id="account:codex-seat"]')).toBeInTheDocument();
  });

  it('does not fetch while the bar or section is hidden and fetches when shown', async () => {
    setResourcesBar(false);
    const view = mount(reading, 'healthy', false);
    await act(async () => { await Promise.resolve(); });
    expect(view.calls.filter(call => call.path === '/api/verse/fleet/runs')).toHaveLength(0);
    act(() => setResourcesBar(true));
    view.rerender(<SectionVisibilityProvider visible><ResourcesBar expanded now={NOW} /></SectionVisibilityProvider>);
    await waitFor(() => expect(view.calls.filter(call => call.path === '/api/verse/fleet/runs')).toHaveLength(1));
  });
});
