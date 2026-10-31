import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { evictAll } from '../../../data/cache.js';
import { SectionVisibilityProvider } from '../shell/section-visibility.js';
import { FleetLedgerCard } from './FleetLedgerCard.js';
import type { ResourceLedgerV1 } from './fleet-ledger-model.js';

const now = Date.parse('2026-01-01T12:00:00Z');
const at = (minutes: number) => new Date(now - minutes * 60_000).toISOString();
const fixture: ResourceLedgerV1 = {
  v: 1, generatedAt: at(0), sources: { status: 'healthy', apiSpend: 'missing' }, asOf: at(1), apiSpend: null,
  lanes: [{ lane: 'codex-personal', running: null, target: null, held: false, window: 'weekly', usedPct: 42,
    creditsRemaining: null, resetAt: null, burnPctPerHour: null, tokensPerHour6h: null, projectedExhaustion: null,
    source: 'codex-personal-sessions', observation: { source: 'codex-personal-sessions', asOf: at(20) } }],
};
const mount = (data: ResourceLedgerV1) => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(data), { status: 200 })));
  return render(<SectionVisibilityProvider visible><FleetLedgerCard now={now} /></SectionVisibilityProvider>);
};
beforeEach(() => { evictAll(); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('FleetLedgerCard source age', () => {
  it('marks an old personal observation stale even when the status tick is fresh', async () => {
    mount(fixture);
    const source = await screen.findByText('source: personal Codex session logs · as of 06:40 ET · stale');
    expect(source).toHaveAttribute('data-tone', 'warn');
    expect(screen.getByText('ledger as of 1 min ago')).toBeInTheDocument();
  });
  it('shows a fresh source without a stale marker', async () => {
    mount({ ...fixture, lanes: [{ ...fixture.lanes[0]!, observation: { source: 'codex-personal-sessions', asOf: at(5) } }] });
    const source = await screen.findByText('source: personal Codex session logs · as of 06:55 ET');
    expect(source).not.toHaveAttribute('data-tone');
    expect(screen.queryByText(/stale/i)).not.toBeInTheDocument();
  });
  it('does not claim a status tick is the personal observation time', async () => {
    mount({ ...fixture, lanes: [{ ...fixture.lanes[0]!, observation: null }] });
    expect(await screen.findByText('source: personal Codex session logs · age unknown')).toBeInTheDocument();
  });
});
