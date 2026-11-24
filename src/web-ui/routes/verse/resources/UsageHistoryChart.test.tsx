import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PoolUsageSeries, UsageHistoryV1 } from '../../../../core/fleet/usage-history.js';
import type { SpendRow } from '../../../../core/usage/spend.js';
import { evictAll } from '../../../data/cache.js';
import { installFetch, json } from '../context/context-fixtures.test-support.js';
import { SpendDown } from './SpendDown.js';
import { resetLabel, UsageHistoryChart } from './UsageHistoryChart.js';

const NOW = Date.parse('2026-11-18T12:00:00.000Z');
const RESET = '2026-11-21T12:00:00.000Z';
function series(fields: Partial<PoolUsageSeries> = {}): PoolUsageSeries {
  return { pool: 'claude', pace: 'behind', reason: null, used_pct: 30, observed_at: '2026-11-18T12:00:00.000Z', reset_at: RESET,
    window_start: '2026-11-14T12:00:00.000Z', ideal_pct: 57.1, resets: [],
    runway: { verdict: 'unknown', pace_per_hour: null, pace_6h_per_hour: null, runway_hours: null, hours_to_reset: 72, hours_early: null,
      unspent_pct: null, target_pace_per_hour: null, advice: null, reason: 'only one reading', sentence: 'Claude: 30% used, unknown (only one reading)' },
    points: [{ at: '2026-11-15T12:00:00.000Z', used_pct: 10 }, { at: '2026-11-18T12:00:00.000Z', used_pct: 30 }],
    ideal: { from: { at: '2026-11-14T12:00:00.000Z', used_pct: 0 }, to: { at: RESET, used_pct: 100 } }, ...fields };
}
beforeEach(() => evictAll());
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('UsageHistoryChart', () => {
  it('draws actual use against the ideal line, with the reset in plain words and the pace word', () => {
    const { container } = render(<UsageHistoryChart series={series()} now={NOW} />);
    const img = screen.getByRole('img');
    expect(img.getAttribute('aria-label')).toBe(`claude: 30% used, ideal 57% by now. ${resetLabel(RESET, NOW)}. Pace behind.`);
    expect(container.querySelector('[data-line="ideal"]')).not.toBeNull();
    expect(container.querySelector('[data-line="actual"]')?.getAttribute('points')?.split(' ')).toHaveLength(2);
    expect(screen.getByText(/^Resets \w{3}, \w{3} \d+/)).toBeVisible();
    expect(screen.getByText('Pace: behind')).toBeVisible();
  });

  it('shows one reading as one dot with unknown pace: no line is invented', () => {
    const { container } = render(<UsageHistoryChart now={NOW} series={series({ pace: 'unknown', reason: 'Only one reading in this window.',
      points: [{ at: '2026-11-18T11:00:00.000Z', used_pct: 30 }] })} />);
    expect(container.querySelector('[data-line="actual"]')).toBeNull();
    expect(container.querySelector('[data-point="only"]')).not.toBeNull();
    expect(screen.getByText('Pace: unknown')).toBeVisible();
    expect(screen.getByText('Only one reading in this window.')).toBeVisible();
  });

  it('says "No readings yet" without a chart, unknown when the read failed, and nothing while loading', () => {
    const { container, rerender } = render(<UsageHistoryChart series={undefined} now={NOW} />);
    expect(screen.getByText('No readings yet')).toBeVisible();
    expect(container.querySelector('svg')).toBeNull();
    rerender(<UsageHistoryChart series={series({ points: [] })} now={NOW} />);
    expect(screen.getByText('No readings yet')).toBeVisible();
    rerender(<UsageHistoryChart series={undefined} status="failed" now={NOW} />);
    expect(screen.getByText('Usage history unknown')).toBeVisible();
    rerender(<UsageHistoryChart series={undefined} status="loading" now={NOW} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('labels an unknown or passed reset in plain words and draws no ideal line without a reset', () => {
    expect(resetLabel(null, NOW)).toBe('Reset time unknown');
    expect(resetLabel('2026-11-18T10:00:00.000Z', NOW)).toMatch(/^Reset passed /);
    const { container } = render(<UsageHistoryChart now={NOW} series={series({ reset_at: null, ideal: null, ideal_pct: null, pace: 'unknown', reason: 'Reset time unknown.' })} />);
    expect(container.querySelector('[data-line="ideal"]')).toBeNull();
    expect(screen.getByText('Reset time unknown')).toBeVisible();
  });
});

describe('Spend down rows', () => {
  const spendRow = (pool: string): SpendRow => ({ pool, unit: 'percent', reason: null, usedPercent: 30, resetAt: RESET, hoursLeft: 72,
    burnPerHour: 0.2, projectedUnusedPercent: 40, projectedUsedPercent: 60, remainingUsd: null, projectedUnusedUsd: null,
    verdict: 'behind', status: 'behind', summary: 'behind', resetsIn: '3d 0h' });
  it('shows each pool its own chart from the usage-history route, and "No readings yet" for a pool without history', async () => {
    const history: UsageHistoryV1 = { schema: 'fleet.usage-history.v1', v: 1, generated_at: '2026-11-18T12:00:00.000Z', source_state: 'healthy', pools: [series()] };
    const { calls } = installFetch(({ path }) => path === '/api/usage/spend'
      ? json({ schema: 'usage.spend.v1', v: 1, asOf: null, headline: 'x', pools: [spendRow('claude'), spendRow('codex-personal')] })
      : path === '/api/verse/leader/resources/usage-history' ? json(history) : json({}, 404));
    render(<SpendDown />);
    const items = await screen.findAllByRole('listitem');
    expect(await within(items[0]!).findByText('Pace: behind')).toBeVisible();
    expect(within(items[1]!).getByText('No readings yet')).toBeVisible();
    expect(calls.filter(c => c.path === '/api/verse/leader/resources/usage-history')).toHaveLength(1);
  });

  it('says unknown, not empty, when the history read fails', async () => {
    installFetch(({ path }) => path === '/api/usage/spend'
      ? json({ schema: 'usage.spend.v1', v: 1, asOf: null, headline: 'x', pools: [spendRow('claude')] }) : json({ error: 'down' }, 500));
    render(<SpendDown />);
    expect(await screen.findByText('Usage history unknown')).toBeVisible();
  });
});
