import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LaneAllowanceCard, LaneAllowanceCards } from './LaneAllowanceCards.js';
import type { LaneAllowanceRow } from '../../../../core/usage/lane-allowance.js';
import { projectLaneAllowance } from '../../../../core/usage/lane-allowance.js';
import { DEVIN_FLASH_EXPIRES_AT, RESOURCE_LIVE_SCHEMA } from '../../../../core/usage/resource-live/types.js';
import { apiGet } from '../../../data/client.js';

vi.mock('../../../data/client.js', () => ({ apiGet: vi.fn() }));
const now = Date.parse('2026-12-02T00:00:00.000Z');
const row = (changes: Partial<LaneAllowanceRow> = {}): LaneAllowanceRow => ({ lane: 'claude', label: 'Claude', used: 62, limit: 100,
  left: 38, unit: 'percent', usedPct: 62, resetAt: new Date(now + 3_600_000).toISOString(), resetsInHours: 1, windowStart: null,
  measuredAt: new Date(now - 240_000).toISOString(), ageSeconds: 240, freshness: 'live', posture: 'balanced', postureReason: 'fixture',
  costClass: 'included', projectedUnusedPct: null, history: null, reason: null, devin: null, ...changes });
afterEach(() => vi.resetAllMocks());
describe('lane allowance cards', () => {
  it('shows the Gemini mark and names fresh observations, rates and projected waste', () => {
    const resource = { source: 'antigravity-agent-check', sourceTier: 'operator-entry' as const, expiresAt: null, burnPerHour: 2, projectedUnused: 24 };
    const { container } = render(<LaneAllowanceCard row={row({ lane: 'agy', label: 'Google AI Ultra · Antigravity', resource })} now={now} />);
    expect(container.querySelector('[data-provider="gemini"]')).toBeInTheDocument();
    expect(screen.getByText('Operator / agent check · antigravity-agent-check')).toBeVisible();
    expect(screen.getByText('2 %/h · 24 % projected unused')).toBeVisible();
  });
  it('renders the missing-reading ancient-receipt projection without included or free claims', () => {
    const snapshot = projectLaneAllowance({ posture: { lanes: { devin: { posture: 'burn', postureReason: 'preview',
      projectedUnusedPct: null, hoursToReset: null, costClass: 'included', freePreview: true,
      observedAt: new Date(1000).toISOString(), previewExpiresAt: new Date(now + 3_600_000).toISOString() } } } }, now);
    render(<LaneAllowanceCard row={snapshot.lanes.find(r => r.lane === 'devin')!} now={now} />);
    expect(screen.getByText('Unknown')).toBeVisible();
    expect(screen.getByText('Cost unknown')).toBeVisible();
    expect(screen.queryByText(/Burning|Included|Free preview|ends in/)).not.toBeInTheDocument();
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
  });
  it.each([1, 86_400_000])('renders negative-age model evidence as invalid (future offset %sms)', (offset) => {
    const at = Date.parse('2026-11-17T12:00:00.000Z');
    const snapshot = projectLaneAllowance({ resourceLive: { schema: RESOURCE_LIVE_SCHEMA, readings: [{ id: 'devin-flash',
      verified: true, used: null, limit: 2, unit: 'models', reset_at: null, source: 'devin-cli-models-list', source_tier: 'official',
      account_id: 'account-a', model: 'swe-2-flash', observed_at: new Date(at + offset).toISOString(),
    }] } }, at);
    render(<LaneAllowanceCard row={snapshot.lanes.find(r => r.lane === 'devin-flash')!} now={at} />);
    expect(screen.getByText('Clock skew / invalid timestamp')).toBeVisible();
    expect(screen.queryByText(/measured 0m ago|Not measured yet|Free preview|ends in/)).not.toBeInTheDocument();
    expect(screen.getByRole('listitem')).toHaveAttribute('data-freshness', 'invalid-future');
  });
  it('renders stale models after preview expiry without accepting an extended free receipt', () => {
    const observedAt = new Date(now - 3_600_000).toISOString();
    const snapshot = projectLaneAllowance({ resourceLive: { schema: RESOURCE_LIVE_SCHEMA, readings: [{ id: 'devin-flash',
      verified: true, used: null, limit: 2, unit: 'models', reset_at: null, source: 'devin-cli-models-list', source_tier: 'official',
      account_id: 'account-a', model: 'swe-2-flash', observed_at: observedAt,
    }] }, posture: { lanes: { 'devin-flash': { posture: 'burn', postureReason: 'preview', projectedUnusedPct: null,
      hoursToReset: null, observedAt, accountId: 'account-a', model: 'swe-2-flash', resetAt: DEVIN_FLASH_EXPIRES_AT,
      costClass: 'included', freePreview: true, previewExpiresAt: new Date(now + 3_600_000).toISOString(),
    } } } }, now);
    render(<LaneAllowanceCard row={snapshot.lanes.find(r => r.lane === 'devin-flash')!} now={now} />);
    expect(screen.getByText('Preview expired')).toBeVisible();
    expect(screen.getByText('Cost unknown')).toBeVisible();
    expect(screen.queryByText(/Free preview|ends in|Burning|Included/)).not.toBeInTheDocument();
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
    expect(screen.getByRole('listitem')).toHaveAttribute('data-freshness', 'stale');
  });
  it.each([0, -900_001, 1])('only counts down independently fresh preview evidence (offset %s)', (offset) => {
    render(<LaneAllowanceCard row={row({ used: null, limit: null, left: null, usedPct: null, devin: {
      weeklyUsedAcu: null, weeklyAllowanceAcu: null, inFlightReservations: null, preview: { models: ['SWE-2 Flash'],
        expiresAt: new Date(now + 3_600_000).toISOString(), expired: false, free: true,
        evidence: { observedAt: new Date(now + offset).toISOString(), accountId: 'account-a', model: 'swe-2-flash' } },
    } })} now={now} />);
    if (offset === 0) expect(screen.getByText('Free preview ends in 1h 0m')).toBeVisible();
    else expect(screen.queryByText(/Free preview|ends in/)).not.toBeInTheDocument();
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
  });
  it('never draws a bar or zero usage for missing values even with a percentage', () => {
    render(<LaneAllowanceCard row={row({ used: null, limit: null, left: null, usedPct: 0, measuredAt: null, freshness: 'unknown' })} now={now} />);
    expect(screen.getByText('unknown — not measured')).toBeVisible();
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
    expect(screen.queryByText(/0% used/)).not.toBeInTheDocument();
  });
  it('does not show a free countdown without measured or independent model evidence', () => {
    render(<LaneAllowanceCard row={row({ used: null, limit: null, left: null, usedPct: null, measuredAt: null,
      freshness: 'unknown', posture: 'unknown', costClass: 'unknown', devin: { weeklyUsedAcu: null,
        weeklyAllowanceAcu: null, inFlightReservations: null,
        preview: { models: ['SWE-2 Flash'], expiresAt: new Date(now + 3_600_000).toISOString(), expired: false, free: null } } })} now={now} />);
    expect(screen.queryByText('Burning')).not.toBeInTheDocument();
    expect(screen.queryByText('Included')).not.toBeInTheDocument();
    expect(screen.queryByText(/ends in/)).not.toBeInTheDocument();
    expect(screen.getByText('Preview free status unknown')).toBeVisible();
  });
  it('labels future timestamps as clock skew, never measured zero minutes ago', () => {
    render(<LaneAllowanceCard row={row({ used: null, limit: null, usedPct: null, left: null,
      measuredAt: new Date(now + 86_400_000).toISOString(), freshness: 'unknown', reason: 'reading-missing' })} now={now} />);
    expect(screen.getByText('Clock skew / invalid timestamp')).toBeVisible();
    expect(screen.queryByText(/measured 0m ago|Not measured yet/)).not.toBeInTheDocument();
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
  });
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
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
    expect(screen.getByText('Unknown')).toBeVisible();
    expect(screen.getByText('Cost unknown')).toBeVisible();
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
