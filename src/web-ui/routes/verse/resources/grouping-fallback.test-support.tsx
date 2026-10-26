import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { evictAll } from '../../../data/cache.js';
import { clearMutationToken, setMutationToken } from '../../../data/auth-store.js';
import { capacity, nativeSeat, seatWindow } from '../seat-fixtures.test-support.js';
import { resetGuard } from '../shell/guarded-action.js';
import { resetVerseUi } from '../verse-ui-store.js';
import { reloadResourcesUiForTest } from './resources-store.js';
import { ResourcesBar } from './ResourcesBar.js';
import { ResourcesDrawer } from './ResourcesDrawer.js';

const NOW = Date.parse('2026-10-13T12:00:00.000Z');
const observedAt = new Date(NOW - 14_000).toISOString();
const quotaExpiresAt = new Date(NOW + 46_000).toISOString();

/** All evidence is synthetic. Exercise the real cache, clock and caller renderers. */
export function groupingFallbackRegression(label: string, warning: RegExp, releaseGrouping?: () => Promise<void>) {
  let reads: string[];
  const quotaWindow = seatWindow({ id: 'synthetic_week', usedPercent: 37, resetsAt: null });
  const seat = nativeSeat(capacity({ planType: 'pro', windows: [quotaWindow], binding: quotaWindow, usability: 'ready', observedAt, quotaExpiresAt,
    creditsExpiresAt: new Date(NOW + 120_000).toISOString(),
    credits: { hasCredits: true, unlimited: false, balance: '7.0000', spendControlReached: false } }),
  { id: 'synthetic-account', accountId: 'synthetic-reference', label, engine: 'codex' });
  const source = JSON.stringify(seat);
  const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
  const pair = (now?: number) => <><ResourcesBar expanded now={now} /><ResourcesDrawer mode="docked" now={now} /></>;
  const rows = () => ({
    bar: screen.getByRole('group', { name: 'Resources at a glance' }).querySelector('button[data-account-row]')!,
    card: document.querySelector('[data-seat="synthetic-account"]')!,
  });
  beforeEach(() => {
    localStorage.clear(); evictAll(); resetGuard(); resetVerseUi(); reloadResourcesUiForTest(); setMutationToken('synthetic-token');
    reads = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.method ?? 'GET').toBe('GET');
      const url = String(input); reads.push(url);
      if (url === '/api/verse/bootstrap') return json({ seats: [seat], projects: [], sessions: [], dispatchEnabled: false, localRuntime: {} });
      if (url === '/api/verse/seats') return json({ sampledAt: observedAt, seats: [seat], localRuntime: {} });
      return json({ error: 'Synthetic unavailable source' }, 404);
    }));
  });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); clearMutationToken(); evictAll(); });
  it('retains ordinary rows and controls after grouping failure, preserves selection, and expires original quota independently of credits', async () => {
    const warm = render(pair(NOW));
    await screen.findByRole('heading', { name: new RegExp(`^${label}`) });
    await act(async () => { await Promise.resolve(); });
    warm.unmount();
    vi.useFakeTimers(); vi.setSystemTime(NOW);
    render(pair());
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    const readsBeforeGrouping = reads.length;
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Group by provider' }));
      fireEvent.click(screen.getByRole('button', { name: 'By provider' }));
    });
    expect(rows().bar).toBeVisible(); expect(rows().card).toBeVisible();
    expect(reads.slice(readsBeforeGrouping)).toEqual([]);
    if (releaseGrouping) {
      const pendingRows = rows();
      fireEvent.click(screen.getByRole('button', { name: 'Show account view' }));
      fireEvent.click(screen.getByRole('button', { name: 'By tier' }));
      await act(async () => { await releaseGrouping(); await vi.advanceTimersByTimeAsync(0); });
      expect(screen.getByRole('button', { name: 'Group by provider' })).toHaveAttribute('aria-pressed', 'false');
      expect(screen.getByRole('button', { name: 'By tier' })).toHaveAttribute('aria-pressed', 'true');
      expect(screen.getByRole('button', { name: 'By provider' })).toHaveAttribute('aria-pressed', 'false');
      expect(screen.queryAllByText(warning)).toHaveLength(0);
      expect(rows().bar).toBe(pendingRows.bar); expect(rows().card).toBe(pendingRows.card);
      expect(rows().bar).toBeVisible(); expect(rows().card).toBeVisible();
      expect(reads.slice(readsBeforeGrouping)).toEqual([]);
      expect(JSON.stringify(seat)).toBe(source);
      fireEvent.click(screen.getByRole('button', { name: 'Group by provider' }));
      fireEvent.click(screen.getByRole('button', { name: 'By provider' }));
    }
    await vi.waitFor(() => expect(screen.getAllByText(warning)).toHaveLength(2));
    const selected = () => {
      expect(screen.getByRole('button', { name: 'Show account view' })).toHaveAttribute('aria-pressed', 'true');
      expect(screen.getByRole('button', { name: 'By provider' })).toHaveAttribute('aria-pressed', 'true');
    };
    selected();
    expect(document.querySelectorAll('button[data-account-row]')).toHaveLength(1);
    expect(document.querySelectorAll('[data-seat="synthetic-account"]')).toHaveLength(1);
    expect(rows().bar).toBeVisible(); expect(rows().card).toBeVisible();
    expect(rows().bar).toHaveTextContent('37% used');
    expect(rows().card).toHaveTextContent('37%');
    expect(screen.getByRole('button', { name: `Move ${label} up` })).toBeInTheDocument();
    const details = within(rows().card as HTMLElement).getByText('Usage details');
    fireEvent.click(details); expect(details.closest('details')).toHaveAttribute('open');
    expect(reads.slice(readsBeforeGrouping)).toEqual([]);
    await act(async () => { await vi.advanceTimersByTimeAsync(Date.parse(quotaExpiresAt) - Date.now() - 1); });
    expect(rows().bar).toHaveAttribute('data-usage-state', 'current');
    const readsBeforeExpiry = reads.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    for (const element of Object.values(rows())) {
      expect(element).toHaveAttribute('data-usage-state', 'retained');
      expect(element).toHaveAttribute('data-usage-observed-at', observedAt);
      expect(element).toHaveTextContent('37%');
    }
    expect(rows().bar).toHaveTextContent('37% used · last');
    expect(rows().card).toHaveTextContent('37% · last');
    expect(within(rows().card as HTMLElement).getAllByText('7 credits available').length).toBeGreaterThan(0);
    expect(reads).toHaveLength(readsBeforeExpiry);
    expect(JSON.stringify(seat)).toBe(source); selected();
    const readsBeforeFocus = reads.length;
    vi.setSystemTime(NOW + 120_000);
    await act(async () => { window.dispatchEvent(new Event('focus')); });
    expect(within(rows().card as HTMLElement).queryByText('Credits available')).toBeNull();
    expect(within(rows().card as HTMLElement).queryByText('7 credits available')).toBeNull();
    expect(within(rows().card as HTMLElement).getByRole('button', { name: `Check again: ${label}` })).toBeEnabled();
    expect(rows().bar).not.toHaveTextContent(/Credits ≈/);
    expect(rows().bar).toHaveAttribute('data-usage-observed-at', observedAt);
    expect(reads).toHaveLength(readsBeforeFocus); expect(JSON.stringify(seat)).toBe(source); selected();
    fireEvent.click(screen.getByRole('button', { name: 'Show account view' }));
    fireEvent.click(screen.getByRole('button', { name: 'By tier' }));
    expect(rows().bar).toBeVisible(); expect(rows().card).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Group by provider' }));
    fireEvent.click(screen.getByRole('button', { name: 'By provider' }));
    expect(rows().bar).toBeVisible(); expect(rows().card).toBeVisible(); selected();
    expect(reads).toHaveLength(readsBeforeFocus);
  });
}
