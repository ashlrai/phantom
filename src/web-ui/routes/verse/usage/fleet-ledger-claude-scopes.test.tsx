import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { evictAll } from '../../../data/cache.js';
import { SectionVisibilityProvider } from '../shell/section-visibility.js';
import { FleetLedgerCard } from './FleetLedgerCard.js';
import { claudeScopeRows, isResourceLedger, laneAsOf, sourceLabel, type ResourceLaneRow, type ResourceLedgerV1 } from './fleet-ledger-model.js';

const now = Date.parse('2026-01-01T12:00:00Z');
const at = (minutes: number) => new Date(now - minutes * 60_000).toISOString();
const iso = (ms: number) => new Date(ms).toISOString();

const lane = (overrides: Partial<ResourceLaneRow> = {}): ResourceLaneRow => ({
  lane: 'Codex', running: 8, target: 24, held: false, window: 'weekly', usedPct: 72,
  creditsRemaining: null, resetAt: null, burnPctPerHour: 1.4, tokensPerHour6h: null,
  projectedExhaustion: null, source: 'status', ...overrides,
});
const claudeLane = (overrides: Partial<ResourceLaneRow> = {}): ResourceLaneRow => lane({
  lane: 'Claude', source: 'claude-native-usage', usedPct: 41,
  observation: { source: 'claude-native-usage', asOf: at(5) },
  quotaScopes: [
    { id: 'seven_day_sonnet', usedPct: 62, resetAt: iso(now + 2 * 86_400_000) },
    { id: 'seven_day_fable', usedPct: 41, resetAt: iso(now + 3 * 86_400_000 + 2 * 3_600_000) },
    { id: 'seven_day_opus', usedPct: 55, resetAt: null },
  ],
  ...overrides,
});
const fixture = (lanes: ResourceLaneRow[]): ResourceLedgerV1 => ({
  v: 1, generatedAt: iso(now), sources: { status: 'healthy', apiSpend: 'missing' }, asOf: at(1), lanes, apiSpend: null,
});
const mount = (data: unknown) => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(data), { status: 200 })));
  return render(<SectionVisibilityProvider visible><FleetLedgerCard now={now} /></SectionVisibilityProvider>);
};
beforeEach(() => { evictAll(); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('claude native usage in the fleet ledger', () => {
  it('labels the claude-native-usage source', () => {
    expect(sourceLabel('claude-native-usage')).toBe('Claude native usage');
  });
  it('dates the claude lane by its observation, never the ledger tick', () => {
    const row = claudeLane({ observation: { source: 'claude-native-usage', asOf: at(20) } });
    expect(laneAsOf(row, at(1))).toBe(at(20));
    expect(laneAsOf({ ...row, observation: { source: 'codex-personal-sessions', asOf: at(20) } }, at(1))).toBeNull();
    expect(laneAsOf({ ...row, observation: null }, at(1))).toBeNull();
  });
  it('projects Fable, Opus and Sonnet in that fixed order', () => {
    expect(claudeScopeRows(claudeLane(), now)).toEqual([
      { label: 'Fable', usage: '41 % of weekly', resets: 'resets in 3 d 2 h', usedPct: 41 },
      { label: 'Opus', usage: '55 % of weekly', resets: null, usedPct: 55 },
      { label: 'Sonnet', usage: '62 % of weekly', resets: 'resets in 2 d', usedPct: 62 },
    ]);
  });
  it('returns nothing without a scope list and skips malformed scopes', () => {
    expect(claudeScopeRows(claudeLane({ quotaScopes: undefined }), now)).toEqual([]);
    expect(claudeScopeRows(claudeLane({ quotaScopes: 'bogus' as never }), now)).toEqual([]);
    expect(claudeScopeRows(claudeLane({
      quotaScopes: [
        'nope',
        { id: 'seven_day_haiku', usedPct: 10, resetAt: null },
        { id: 'seven_day_fable', usedPct: 100.5, resetAt: null },
        { id: 'seven_day_opus', usedPct: -1, resetAt: null },
        { id: 'seven_day_opus', usedPct: Number.NaN, resetAt: null },
        { id: 'seven_day_sonnet', usedPct: '62', resetAt: null },
        { id: 'seven_day_fable', usedPct: 41, resetAt: 'not a date' },
        { id: 'seven_day_fable', usedPct: 41, resetAt: 42 },
        { id: 'seven_day_opus', usedPct: 55, resetAt: iso(now + 3_600_000) },
      ] as never,
    }), now)).toEqual([
      { label: 'Opus', usage: '55 % of weekly', resets: 'resets in 1 h', usedPct: 55 },
    ]);
  });
  it('accepts a ledger whose quotaScopes are malformed', () => {
    expect(isResourceLedger(fixture([claudeLane({ quotaScopes: 'bogus' as never })]))).toBe(true);
    expect(isResourceLedger(fixture([claudeLane({ quotaScopes: [{ id: 'x'.repeat(60), usedPct: 'high', resetAt: 5 }] as never })]))).toBe(true);
    expect(isResourceLedger(fixture([claudeLane()]))).toBe(true);
  });
  it('renders scope lines with meters for the claude lane and none for codex', async () => {
    mount(fixture([lane(), claudeLane()]));
    expect(await screen.findByText('Fable 41 % of weekly · resets in 3 d 2 h')).toBeInTheDocument();
    expect(screen.getByText('Opus 55 % of weekly')).toBeInTheDocument();
    expect(screen.getByText('Sonnet 62 % of weekly · resets in 2 d')).toBeInTheDocument();
    for (const label of ['Fable', 'Opus', 'Sonnet']) {
      expect(screen.getByRole('meter', { name: `Claude ${label} used` })).toBeInTheDocument();
    }
    const codexHeader = screen.getByRole('rowheader', { name: /Codex/ });
    expect(within(codexHeader).queryByText(/Fable|Opus|Sonnet/)).not.toBeInTheDocument();
    expect(within(codexHeader).queryByRole('meter')).not.toBeInTheDocument();
    expect(within(screen.getByRole('rowheader', { name: /Claude/ })).getByText('Weekly window only. No 5-hour limit.')).toBeInTheDocument();
  });
  it('marks an old claude observation stale even when the ledger tick is fresh', async () => {
    mount(fixture([claudeLane({ observation: { source: 'claude-native-usage', asOf: at(20) } })]));
    expect(await screen.findByText('source: Claude native usage · as of 06:40 ET · stale')).toBeInTheDocument();
    expect(screen.getByText('ledger as of 1 min ago')).toBeInTheDocument();
  });
});
