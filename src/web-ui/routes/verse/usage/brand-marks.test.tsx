/**
 * brand-marks.test.tsx: every place the Usage section names an account, a lane, a backend or a resource leads
 * the name with that provider's mark (components/primitives/BrandMark over the brand registry), a name the
 * registry does not know gets a monogram and never a guessed logo, and the mark stays decoration: the name
 * beside it is what is read aloud, so no accessible name changes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { evictAll } from '../../../data/cache.js';
import { USAGE_RESOURCES } from '../../../../core/usage/resource-usage-types.js';
import { SectionVisibilityProvider } from '../shell/section-visibility.js';
import { CLAUDE_TIGHT_SEAT, GROK_SEAT, LOCAL_SEAT_V2 } from '../seat-fixtures.test-support.js';
import { AccountCard } from './AccountCard.js';
import { AccountDetail } from './AccountDetail.js';
import { CapacityStrip } from './CapacityStrip.js';
import { EfficiencyPanel } from './EfficiencyPanel.js';
import { FleetLedgerCard } from './FleetLedgerCard.js';
import { LimitsPanel } from './LimitsPanel.js';
import { LocalCloudPanel } from './LocalCloudPanel.js';
import { UsageResourcesPanel } from './UsageResourcesPanel.js';
import type { AccountCardModel } from './accounts-model.js';
import type { SeatEfficiencyRow } from './context-model.js';
import type { ResourceLaneRow, ResourceLedgerV1 } from './fleet-ledger-model.js';
import type { UsageLimitRow } from './usage-model.js';

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });

/** The mark that leads a name: the one svg inside the element holding that name. */
function markIn(el: HTMLElement): SVGElement {
  const marks = el.querySelectorAll('svg[data-provider]');
  expect(marks).toHaveLength(1);
  return marks[0] as SVGElement;
}

function expectMark(el: HTMLElement, provider: string): void {
  const mark = markIn(el);
  expect(mark.getAttribute('data-provider')).toBe(provider);
  // Set in the line of text, and decoration: the name beside it carries the meaning.
  expect(mark.getAttribute('data-inline')).toBe('true');
  expect(mark.getAttribute('aria-hidden')).toBe('true');
  expect(mark.hasAttribute('role')).toBe(false);
}

function card(over: Partial<AccountCardModel> & { id: string }): AccountCardModel {
  return {
    label: over.id, engine: 'claude', color: 'var(--engine-claude)', plan: 'max',
    verdict: { state: 'tight', headline: 'Running tight', detail: 'the sentence', code: null },
    allWindows: [],
    evidence: { state: 'observed', authentication: 'signed-in', health: null, reasonCode: null, observedAt: null, notes: [], unsupported: null },
    binding: null, others: [], credits: null, reconnectCommand: null, observedAt: null, rank: 2, hasDetail: true, sourceNote: null,
    ...over,
  };
}

beforeEach(() => evictAll());
afterEach(() => { cleanup(); evictAll(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('brand marks in the Usage section', () => {
  it('leaves the capacity strip alone: its rows already lead with the provider tile, so a seat is marked once', () => {
    const claude = { ...CLAUDE_TIGHT_SEAT, id: 'claude-a', accountId: 'claude-a' };
    render(<CapacityStrip seats={[claude, GROK_SEAT, LOCAL_SEAT_V2]} local="each" onSelectSeat={() => {}} />);
    const rows = within(screen.getByRole('list', { name: 'Seat capacity' })).getAllByRole('listitem');
    expect(rows.map((row) => markIn(row).getAttribute('data-provider'))).toEqual(['claude', 'grok', 'local']);
  });

  it('leads an account card and its detail heading with the account\'s provider', () => {
    render(<AccountCard card={card({ id: 'Codex Team', engine: 'codex' })} onOpen={() => {}} />);
    const article = screen.getByRole('article', { name: 'Codex Team usage' });
    expectMark(article, 'codex');
    expect(within(article).getByRole('button', { name: /^Codex Team/ }).querySelector('svg[data-provider="codex"]')).not.toBeNull();
    cleanup();

    render(<AccountDetail card={card({ id: 'Grok Build', engine: 'grok' })} onClose={() => {}} headingId="h" />);
    const heading = screen.getByRole('heading', { name: 'Grok Build' });
    expectMark(heading, 'grok');
  });

  it('gives each resource cell its mark by id, and a monogram where the registry knows no single owner', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => String(input) === '/api/verse/usage-resources'
      ? json({ v: 1, generatedAt: '2026-11-02T12:00:00.000Z', resources: USAGE_RESOURCES.map(({ id, label }) => ({
        id, label, state: 'no-reader', used: null, limit: null, unit: null, resetsAt: null, source: null, asOf: null, reason: null })) })
      : new Response('{}', { status: 404 })));
    render(<UsageResourcesPanel />);
    const cells = within(await screen.findByRole('list')).getAllByRole('listitem');
    const provider = (id: string): string | null => {
      const cell = cells.find((c) => c.getAttribute('data-resource') === id)!;
      return cell.querySelector('svg[data-provider]')!.getAttribute('data-provider');
    };
    expect(provider('claude-max')).toBe('claude');
    expect(provider('codex-personal')).toBe('codex');
    expect(provider('devin')).toBe('devin');
    expect(provider('gemini-workspace')).toBe('gemini');
    // "Ultra (Cursor + Grok pool)" is two companies' pool: its label must not pick one of them.
    expect(provider('ultra')).toBe('unknown');
    expect(provider('zai')).toBe('unknown');
    const zai = cells.find((c) => c.getAttribute('data-resource') === 'zai')!;
    expect(zai.querySelector('svg text')!.textContent).toBe('Z');
    for (const cell of cells) expect(cell.querySelectorAll('svg[data-provider]'), cell.getAttribute('data-resource') ?? '').toHaveLength(1);
  });

  it('leads each dispatch limit with its backend, without changing the meter\'s name', () => {
    const row = (backend: string): UsageLimitRow => ({ id: backend, backend, window: 'five_hour', max: 100, used: 40, usedPct: 40, standing: 'ok', configuredOnly: false });
    const { container } = render(<LimitsPanel rows={[row('codex'), row('mistral')]} capsNote={null} />);
    const marks = [...container.querySelectorAll('svg[data-provider]')].map((m) => m.getAttribute('data-provider'));
    expect(marks).toEqual(['codex', 'unknown']);
    expect(screen.getByRole('meter', { name: 'codex dispatches against its five_hour cap' })).toBeInTheDocument();
    expect(screen.getByText('mistral')).toBeInTheDocument();
  });

  it('leads each ledger lane with its provider and keeps the row header\'s words', async () => {
    const now = Date.parse('2026-01-01T12:00:00Z');
    const lane = (name: string): ResourceLaneRow => ({ lane: name, running: 8, target: 24, held: false, window: 'weekly', usedPct: 72, creditsRemaining: null, resetAt: null, burnPctPerHour: 1.4, tokensPerHour6h: null, projectedExhaustion: null, source: 'dispatchd at 11:56' });
    const ledger: ResourceLedgerV1 = { v: 1, generatedAt: new Date(now).toISOString(), sources: { status: 'healthy', apiSpend: 'healthy' }, asOf: new Date(now - 4 * 60_000).toISOString(),
      lanes: [lane('Codex'), lane('Claude'), lane('Credits')], apiSpend: { rowsToday: 0, errorsToday: 0, tokensOutToday: 0, tokensInToday: 0, usdToday: 0, usdWeek: 0, lastAt: null, models: [] } };
    vi.stubGlobal('fetch', vi.fn(async () => json(ledger)));
    render(<SectionVisibilityProvider visible><FleetLedgerCard now={now} /></SectionVisibilityProvider>);
    await screen.findByText('ledger as of 4 min ago');
    const heads = within(screen.getByRole('table')).getAllByRole('rowheader');
    expect(heads.map((th) => markIn(th).getAttribute('data-provider'))).toEqual(['codex', 'claude', 'unknown']);
    expect(screen.getByRole('meter', { name: 'Codex used' })).toBeInTheDocument();
  });

  it('leads each seat in the context table with its provider', () => {
    const seat = (label: string, engine: SeatEfficiencyRow['engine']): SeatEfficiencyRow => ({ seatId: label, label, engine, retired: false, sessions: 2, turns: 9,
      promptTokens: 1200, outputTokens: 300, cacheHitRatio: null, compactions: 0, expansiveSessions: 0, fullest: null });
    render(<EfficiencyPanel rows={[seat('Claude Max', 'claude'), seat('This Mac', 'local')]} unavailableReason={null} />);
    const rows = within(screen.getByRole('table')).getAllByRole('row').slice(1);
    expect(rows.map((r) => markIn(r).getAttribute('data-provider'))).toEqual(['claude', 'local']);
  });

  it('leads each provider in the local and cloud table with its mark', () => {
    const slice = (provider: string, tier: 'local' | 'cloud') => ({ provider, tier, tokens: 500, costUsd: 0, sharePct: 50 });
    const { container } = render(<LocalCloudPanel savingsNote="an estimate" split={{ window: '7d', totalTokens: 1000, totalCostUsd: 0, localSavingsUsd: 0,
      localTokens: 500, cloudTokens: 500, localCostUsd: 0, cloudCostUsd: 0, empty: false, byProvider: [slice('anthropic', 'cloud'), slice('ollama', 'local')] }} />);
    const cells = [...container.querySelectorAll('table tbody tr')].map((tr) => tr.querySelector('svg[data-provider]')?.getAttribute('data-provider') ?? null);
    expect(cells).toEqual(['claude', 'local']);
  });
});
