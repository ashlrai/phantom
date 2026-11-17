import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LaneAllowanceCard, LaneAllowanceCards } from './LaneAllowanceCards.js';
import type { LaneAllowanceRow } from '../../../../core/usage/lane-allowance.js';
import { apiGet } from '../../../data/client.js';

vi.mock('../../../data/client.js', () => ({ apiGet: vi.fn() }));
const now = Date.parse('2026-12-02T00:00:00.000Z');
const row = (changes: Partial<LaneAllowanceRow> = {}): LaneAllowanceRow => ({ lane: 'claude', label: 'Claude', used: 62, limit: 100,
  left: 38, unit: 'percent', usedPct: 62, resetAt: new Date(now + 3_600_000).toISOString(), resetsInHours: 1,
  measuredAt: new Date(now - 240_000).toISOString(), ageSeconds: 240, freshness: 'live', posture: 'balanced', postureReason: 'fixture',
  costClass: 'included', projectedUnusedPct: null, history: null, reason: null, devin: null, ...changes });
afterEach(() => vi.resetAllMocks());
describe('lane allowance cards', () => {
  it('shows measured allowance, reset and age', () => {
    render(<LaneAllowanceCard row={row()} now={now} />);
    expect(screen.getByText('62% used · 38% left')).toBeVisible();
    expect(screen.getByText('Balanced')).toBeVisible();
    expect(screen.getByText('Included')).toBeVisible();
    expect(screen.getByText('Resets in 1h 0m')).toBeVisible();
    expect(screen.getByText('measured 4m ago')).toBeVisible();
  });
  it('shows unknown without bar fill', () => {
    render(<LaneAllowanceCard row={row({ used: null, left: null, usedPct: null, measuredAt: null, freshness: 'unknown' })} now={now} />);
    expect(screen.getByText('unknown — not measured')).toBeVisible();
    expect(screen.getByRole('img', { name: 'Usage unknown' }).children).toHaveLength(0);
    expect(screen.getByRole('img', { name: 'Usage unknown' })).toHaveAttribute('data-unknown', 'true');
  });
  it('marks stale readings', () => {
    render(<LaneAllowanceCard row={row({ freshness: 'stale', reason: 'reading-stale' })} now={now} />);
    expect(screen.getByRole('listitem')).toHaveAttribute('data-freshness', 'stale');
    expect(screen.getByText(/ago · stale/)).toBeVisible();
    expect(screen.getByText('Last reading is stale')).toHaveAttribute('data-reason', 'reading-stale');
  });
  it.each(['burn', 'preserve'] as const)('describes %s posture accessibly', (posture) => {
    render(<LaneAllowanceCard row={row({ posture, projectedUnusedPct: 40 })} now={now} />);
    const chip = screen.getByText(posture === 'burn' ? 'Burning' : 'Preserving');
    expect(chip).toHaveAttribute('title', expect.stringContaining(posture === 'burn' ? '~40%' : 'protecting allowance'));
    expect(chip).toHaveAttribute('aria-describedby');
    expect(document.getElementById(chip.getAttribute('aria-describedby')!)).toHaveTextContent(chip.getAttribute('title')!);
  });
  it('shows Devin weekly and expired preview', () => {
    render(<LaneAllowanceCard row={row({ devin: { weeklyUsedAcu: 12, weeklyAllowanceAcu: 20, inFlightReservations: 2,
      preview: { models: ['SWE-2 Flash'], expiresAt: new Date(now - 1000).toISOString(), expired: true, free: false } } })} now={now} />);
    expect(screen.getByText('Weekly ACUs: 12 / 20')).toBeVisible();
    expect(screen.getByText('In-flight reservations: 2')).toBeVisible();
    expect(screen.getByText('Preview expired')).toBeVisible();
  });
  it('formats counted units and translates missing posture evidence', () => {
    render(<LaneAllowanceCard row={row({ used: 12, limit: 20, left: 8, unit: 'acu', usedPct: 60, posture: 'unknown', postureReason: 'posture-unmeasured', costClass: 'metered' })} now={now} />);
    expect(screen.getByText('12 / 20 ACU · 8 left')).toBeVisible();
    expect(screen.getByText('Unknown')).toBeVisible();
    expect(screen.getByText('Metered')).toBeVisible();
    expect(screen.getByText('Router posture not recorded')).toHaveAttribute('data-reason', 'posture-unmeasured');
  });
  it.each([['api-credit', 'API credit'], ['unknown', 'Cost unknown']] as const)('labels %s cost', (costClass, label) => {
    render(<LaneAllowanceCard row={row({ costClass })} now={now} />);
    expect(screen.getByText(label)).toBeVisible();
  });
  it('fetches the lane projection and handles empty results', async () => {
    vi.mocked(apiGet).mockResolvedValue({ v: 1, asOf: new Date(now).toISOString(), lanes: [] });
    render(<LaneAllowanceCards />);
    expect(await screen.findByText('No lane readings yet.')).toBeVisible();
    expect(apiGet).toHaveBeenCalledWith('/api/usage/lanes', expect.any(AbortSignal));
  });
  it('shows unavailable readings on request error', async () => {
    vi.mocked(apiGet).mockRejectedValue(new Error('offline'));
    render(<LaneAllowanceCards />);
    expect(await screen.findByText('unknown — allowance readings unavailable')).toBeVisible();
  });
});
