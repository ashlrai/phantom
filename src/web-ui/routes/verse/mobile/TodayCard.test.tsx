import { screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HomeSummary } from '../../../../core/fleet/home.js';
import { buildAskBatch } from '../../../../core/fleet/asks-batch.js';
import { clearMutationToken, setMutationToken } from '../../../data/auth-store.js';
import { evictAll } from '../../../data/cache.js';
import { renderMobile, stubFetch, TOKEN } from './mobile.test-support.js';
import { TodayCard } from './TodayCard.js';

const ok = <T,>(value: T) => ({ state: 'ok' as const, value });
const home: HomeSummary = {
  schema: 'home.v1', asOf: '2026-11-21T14:00:00.000Z', health: 'healthy', headline: 'Healthy',
  mergedLastHour: ok(14), merged24h: ok(120), medianMergeSeconds: ok(300), main: ok([]),
  running: ok([{ lane: 'claude', running: 4, target: 8 }, { lane: 'codex', running: 5, target: 7 }]),
  atRisk: ok(null), worklog: ok([]), unreadLeaderReplies: ok(0), needsYou: ok([]),
};
const pools = { schema: 'pools.v1', generatedAt: '2026-11-21T14:00:00.000Z', staleAfterMinutes: 60, gaps: [], pools: [{
  id: 'codex-personal', kind: 'subscription', usedPct: 100, state: 'measured', resetAt: '2026-11-21T15:30:00Z', hoursLeft: 1.5, elapsedPct: null, burnPctPerHour: null,
  burnBasis: null, burn: { samples: 0, window_h: 0, method: 'none' }, projectedUnusedPct: null, projectedEmptyAt: null, verdict: 'fully used', wasteRisk: 'low',
  creditsRemaining: null, held: null, running: null, target: null, source: null, scopes: [], asOf: null, reason: null, summary: '' }] };
const asks = buildAskBatch([{ id: 'nm-credit', question: 'Use the gifted API credit before it ends?', kind: 'yes-no', askedAt: '2026-11-20T00:00:00.000Z', hardLimit: 'money' }]);

beforeEach(() => { vi.stubGlobal('innerWidth', 390); setMutationToken(TOKEN); });
afterEach(() => { evictAll(); clearMutationToken(); vi.unstubAllGlobals(); });

describe('TodayCard at 390 px', () => {
  it('shows the sentence, lanes, the empty pool with its return time and the ask with one-tap answers', async () => {
    stubFetch({
      'GET /api/app/pools': pools,
      'GET /api/verse/agent-bus/needs-mason/asks/batch': asks,
    });
    const { container } = renderMobile(<div style={{ width: 390 }}><TodayCard home={home} /></div>);
    expect(await screen.findByText(/14 PRs merged in the last hour; 9 jobs running; Codex personal is back/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open Live runs for claude' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open Live runs for codex' })).toBeInTheDocument();
    expect(screen.getByText('Codex personal')).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: /^Yes: Use the gifted API credit/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^No: Use the gifted API credit/ })).toBeInTheDocument();
    // No fixed-width element wider than the phone, and nothing sets a horizontal scroll.
    for (const el of Array.from(container.querySelectorAll<HTMLElement>('[style]'))) {
      const width = parseInt(el.style.width, 10);
      if (Number.isFinite(width)) expect(width).toBeLessThanOrEqual(390);
      expect(el.style.overflowX).not.toBe('scroll');
    }
  });
});
