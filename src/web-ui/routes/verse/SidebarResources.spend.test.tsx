import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, within } from '@testing-library/react';
import type { SpendRow } from '../../../core/usage/spend.js';
import { evictAll } from '../../data/cache.js';
import { installFetch, json } from './context/context-fixtures.test-support.js';
import { resetVerseUi } from './verse-ui-store.js';
import { SidebarResources } from './SidebarResources.js';
import { SpendDown } from './resources/SpendDown.js';
import { SectionVisibilityProvider } from './shell/section-visibility.js';

// The Dot row makes its own comms-status read; this suite covers the Spend down section only.
vi.mock('./resources/DotResourceRow.js', () => ({ DotResourceRow: () => null }));

function spend(pools: SpendRow[]) {
  return { v: 1, asOf: '2026-11-09T16:00:00Z', pools };
}
function row(fields: Partial<SpendRow> & { pool: string }): SpendRow {
  return { unit: 'percent', reason: null, usedPercent: null, resetAt: null, hoursLeft: null, burnPerHour: null,
    projectedUnusedPercent: null, projectedUsedPercent: null, remainingUsd: null, projectedUnusedUsd: null,
    verdict: 'unknown', summary: 'unknown: reading missing', resetsIn: null, ...fields };
}

beforeEach(() => { evictAll(); resetVerseUi(); });
afterEach(() => { vi.unstubAllGlobals(); });

describe('Spend down section in the Resources sidebar', () => {
  it('shows each pool with a plain verdict, a used-now over projected bar and the reset countdown, behind first', async () => {
    const { calls } = installFetch(({ path }) => path === '/api/usage/spend' ? json(spend([
      row({ pool: 'claude', usedPercent: 41, burnPerHour: 0.61, projectedUnusedPercent: 10, resetAt: '2026-11-13T00:00:00Z', projectedUsedPercent: 90, verdict: 'behind', summary: 'behind: 10% would go unused', resetsIn: '3d 8h' }),
      row({ pool: 'codex-personal', usedPercent: 65, projectedUsedPercent: 100, verdict: 'on-pace', summary: 'on pace', resetsIn: '4d 4h' }),
    ])) : json({}, 404));
    render(<SidebarResources />);
    expect(await screen.findByRole('region', { name: 'Spend down' })).toBeVisible();
    const items = await screen.findAllByRole('listitem');
    expect(items.map(item => item.getAttribute('aria-label'))).toEqual(['claude', 'codex-personal']);
    expect(within(items[0]!).getByText('behind')).toBeVisible();
    expect(within(items[0]!).getByRole('img', { name: '41% used now, 90% projected at reset' })).toBeVisible();
    for (const text of ['Used', '41%', 'Burn per hour', '0.61 %/h', 'Unused at reset', '10%', 'Resets', 'in 3d 8h']) {
      expect(within(items[0]!).getByText(text)).toBeVisible();
    }
    expect(items[0]!.querySelector('time')).toHaveAttribute('datetime', '2026-11-13T00:00:00Z');
    expect(within(items[1]!).getByText('on pace')).toBeVisible();
    // Spend down reads once on mount (the sidebar's runtime-identity row makes its own read).
    expect(calls.filter(({ path }) => path.startsWith('/api/usage')).map(({ path, method }) => ({ path, method })))
      .toEqual([{ path: '/api/usage/spend', method: 'GET' }]);
  });

  it('renders a gift pool by its USD balance and expiry', async () => {
    installFetch(({ path }) => path === '/api/usage/spend' ? json(spend([
      row({ pool: 'claude-api', unit: 'usd', usedPercent: 0, remainingUsd: 112, verdict: 'unknown', summary: 'unknown: no spend rate', resetsIn: '8d 0h', reason: 'no spend rate' }),
    ])) : json({}, 404));
    render(<SidebarResources />);
    expect(await screen.findByText('claude-api gift')).toBeVisible();
    for (const text of ['112 USD', 'in 8d 0h', 'no spend rate', '0%', 'Expires', 'Unused at expiry']) {
      expect(screen.getByText(text)).toBeVisible();
    }
    expect(screen.getByRole('img', { name: '0% used now, unknown projected at reset' })).toBeVisible();
  });

  it('reads "unknown (status unavailable)" when the read fails', async () => {
    installFetch(() => json({ error: 'unavailable' }, 503));
    render(<SidebarResources />);
    expect(await screen.findByText('unknown (status unavailable)')).toBeVisible();
  });

  it('renders unknown pools as unknown, never as zero', async () => {
    installFetch(({ path }) => path === '/api/usage/spend' ? json(spend([
      row({ pool: 'gemini', reason: 'reading missing', summary: 'unknown: reading missing' }),
    ])) : json({}, 404));
    render(<SidebarResources />);
    expect(await screen.findByText('reading missing')).toBeVisible();
    expect(screen.getByText('gemini')).toBeVisible();
    // Unknown is never drawn or written as zero.
    expect(screen.getByRole('img', { name: 'unknown used now, unknown projected at reset' })).toBeVisible();
    expect(screen.getAllByText('unknown')).toHaveLength(5);
    expect(screen.queryByText('0%')).not.toBeInTheDocument();
  });

  it('renders each required pool once with a short status and keeps stale values unknown', async () => {
    const pools = ['codex-personal', 'codex-cmp', 'claude', 'claude-api', 'devin', 'zai', 'local'];
    installFetch(({ path }) => path === '/api/usage/spend' ? json(spend(pools.map(pool => row({ pool,
      ...(pool === 'claude' ? { verdict: 'used-up', usedPercent: 100 } : {}),
      ...(pool === 'claude-api' ? { unit: 'usd', verdict: 'expired', reason: 'expired' } : {}),
      ...(pool === 'codex-cmp' ? { reason: 'reading stale' } : {}),
    })))) : json({}, 404));
    render(<SidebarResources />);
    const items = await screen.findAllByRole('listitem');
    expect(items.map(item => item.getAttribute('aria-label'))).toEqual(pools);
    expect(within(items[1]!).getByText('reading stale')).toBeVisible();
    expect(within(items[1]!).getAllByText('unknown')).toHaveLength(5);
    expect(within(items[2]!).getByText('exhausted')).toBeVisible();
    expect(within(items[3]!).getByText('exhausted')).toBeVisible();
  });

  it('shows an explicit empty state without an empty list or invented readings', async () => {
    installFetch(({ path }) => path === '/api/usage/spend' ? json(spend([])) : json({}, 404));
    render(<SidebarResources />);
    expect(await screen.findByText('No usage readings yet.')).toBeVisible();
    expect(screen.queryByRole('list')).not.toBeInTheDocument();
    expect(screen.queryByText('0%')).not.toBeInTheDocument();
  });

  it('cannot restore an old forecast after a visibility refresh reports stale usage', async () => {
    let finishOld!: (response: Response) => void;
    let reads = 0;
    installFetch(() => ++reads === 1 ? new Promise<Response>(resolve => { finishOld = resolve; })
      : json(spend([row({ pool: 'codex-personal', reason: 'reading stale' })])));
    const view = (visible: boolean) => <SectionVisibilityProvider visible={visible}><SpendDown /></SectionVisibilityProvider>;
    const { rerender } = render(view(true));
    rerender(view(false));
    rerender(view(true));
    expect(await screen.findByText('reading stale')).toBeVisible();
    await act(async () => { finishOld(json(spend([row({ pool: 'codex-personal', usedPercent: 65, verdict: 'on-pace' })]))); });
    expect(screen.getByText('reading stale')).toBeVisible();
    expect(screen.queryByText('65%')).not.toBeInTheDocument();
    expect(reads).toBe(2);
  });
});
