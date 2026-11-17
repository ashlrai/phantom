import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import type { SpendRow } from '../../../core/usage/spend.js';
import { evictAll } from '../../data/cache.js';
import { installFetch, json } from './context/context-fixtures.test-support.js';
import { resetVerseUi } from './verse-ui-store.js';
import { SidebarResources } from './SidebarResources.js';

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
      row({ pool: 'claude', usedPercent: 41, projectedUsedPercent: 90, verdict: 'behind', summary: 'behind: 10% would go unused', resetsIn: '3d 8h' }),
      row({ pool: 'codex-personal', usedPercent: 65, projectedUsedPercent: 100, verdict: 'on-pace', summary: 'on pace', resetsIn: '4d 4h' }),
    ])) : json({}, 404));
    render(<SidebarResources />);
    expect(await screen.findByRole('region', { name: 'Spend down' })).toBeVisible();
    const items = await screen.findAllByRole('listitem');
    expect(items.map(item => item.getAttribute('aria-label'))).toEqual(['claude', 'codex-personal']);
    expect(within(items[0]!).getByText('behind: 10% would go unused')).toBeVisible();
    expect(within(items[0]!).getByRole('img', { name: '41% used now, 90% projected at reset' })).toBeVisible();
    expect(within(items[0]!).getByText('41% used · 90% by reset · resets in 3d 8h')).toBeVisible();
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
    expect(await screen.findByText('112 USD left · expires in 8d 0h')).toBeVisible();
    expect(screen.getByText('unknown: no spend rate')).toBeVisible();
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
    expect(await screen.findByText('unknown: reading missing')).toBeVisible();
    expect(screen.getByText('gemini')).toBeVisible();
    // Unknown is never drawn or written as zero.
    expect(screen.getByRole('img', { name: 'unknown used now, unknown projected at reset' })).toBeVisible();
    expect(screen.getByText('unknown used · unknown by reset · resets unknown')).toBeVisible();
  });
});
