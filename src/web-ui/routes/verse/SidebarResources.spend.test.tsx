import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, within } from '@testing-library/react';
import { projectUsageSpend, spendHeadline, type SpendRow, type SpendSnapshot } from '../../../core/usage/spend.js';
import { evictAll } from '../../data/cache.js';
import { installFetch, json } from './context/context-fixtures.test-support.js';
import { resetVerseUi } from './verse-ui-store.js';
import { SidebarResources } from './SidebarResources.js';
import { SpendDown } from './resources/SpendDown.js';
import { SectionVisibilityProvider } from './shell/section-visibility.js';
import { mockViewport, type ViewportMock } from './shell/viewport.test-support.js';

// The Dot row makes its own comms-status read; this suite covers the Spend down section only.
vi.mock('./resources/DotResourceRow.js', () => ({ DotResourceRow: () => null }));

function spend(pools: SpendRow[]): SpendSnapshot {
  return { schema: 'usage.spend.v1', v: 1, asOf: '2026-11-09T16:00:00Z', headline: spendHeadline(pools), pools };
}
function row(fields: Partial<SpendRow> & { pool: string }): SpendRow {
  const verdict = fields.verdict ?? 'unknown';
  return { status: verdict === 'used-up' || verdict === 'expired' ? 'exhausted' : verdict, unit: 'percent', reason: null, usedPercent: null, resetAt: null, hoursLeft: null, burnPerHour: null,
    projectedUnusedPercent: null, projectedUsedPercent: null, remainingUsd: null, projectedUnusedUsd: null,
    verdict: 'unknown', summary: 'unknown: reading missing', resetsIn: null, ...fields };
}

beforeEach(() => { evictAll(); resetVerseUi(); });
let viewport: ViewportMock | null = null;
afterEach(() => { vi.unstubAllGlobals(); viewport?.restore(); viewport = null; });

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
    expect(screen.getByRole('status')).toHaveTextContent('claude: 59% left, resets in 3d 8h, 10% would go unused.');
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
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(screen.queryByRole('list')).not.toBeInTheDocument();
    expect(screen.queryByText('0%')).not.toBeInTheDocument();
  });

  it.each([['desktop width', 1440], ['390 px', 390]])('at %s: one sentence on top, then the projector\'s rows with the worst waste first', async (_name, width) => {
    viewport = mockViewport(width);
    const now = Date.now();
    const at = (hours: number) => new Date(now + hours * 3_600_000).toISOString();
    const snapshot = projectUsageSpend({ schema: 'dispatchd.status.v1', last_tick: at(0), budget: {
      claude: { use_it_all: { known: true, stale: false, used_pct: 41, reset_at: at(80), burn_pct_per_hour: 0.6 } },
      zai: { use_it_all: { known: true, stale: false, used_pct: 103, reset_at: at(50), burn_pct_per_hour: 1 } },
      'claude-api': { gift: { usd_remaining: 112, usd_granted: 112, as_of: at(0), expires_at: at(150), usd_burn_per_hour: 0 } },
    } }, now);
    installFetch(({ path }) => path === '/api/usage/spend' ? json(snapshot) : json({}, 404));
    render(<SpendDown />);
    expect(await screen.findByRole('status')).toHaveTextContent('claude-api gift: 112 USD left, expires in 6d 6h, nothing is using it; 1 more behind.');
    const items = screen.getAllByRole('listitem');
    expect(items.slice(0, 2).map(item => item.getAttribute('aria-label'))).toEqual(['claude-api', 'claude']);
    expect(items).toHaveLength(snapshot.pools.length);
    // Every row carries a bar, a countdown or "unknown", and one of the four status words.
    for (const item of items) {
      expect(within(item).getByRole('img')).toBeVisible();
      expect(['on pace', 'behind', 'exhausted', 'unknown']).toContain(item.querySelector('[data-verdict]:not([role])')!.textContent);
    }
    expect(within(items[0]!).getByText('behind')).toBeVisible();
    expect(within(items[0]!).getByText('in 6d 6h')).toBeVisible();
    // Balance and projected unused at expiry: all of it.
    expect(within(items[0]!).getAllByText('112 USD')).toHaveLength(2);
    expect(within(screen.getByRole('listitem', { name: 'zai' })).getByText('exhausted')).toBeVisible();
    expect(within(screen.getByRole('listitem', { name: 'local' })).getByText('reading missing')).toBeVisible();
  });

  it('cannot restore an old forecast after a visibility refresh reports stale usage', async () => {
    let finishOld!: (response: Response) => void;
    let reads = 0;
    // Only spend reads are counted; the usage-history, spend-down chart and pace reads are separate.
    installFetch(({ path }) => path === '/api/verse/leader/resources/usage-history' || path === '/api/app/pools/spenddown' || path === '/api/fleet/pace' ? json({}, 404)
      : ++reads === 1 ? new Promise<Response>(resolve => { finishOld = resolve; })
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
