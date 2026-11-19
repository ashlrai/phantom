import { screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { evictAll } from '../../../data/cache.js';
import { buildPoolsView, POOLS_PATH, type PoolsViewV1 } from '../../../../core/fleet/pools-view.js';
import type { ResourceLaneRow } from '../../../../core/fleet/runs-resource-ledger.js';
import { poolPaceLines } from './pool-pace-model.js';
import { PoolPaceCard } from './PoolPaceCard.js';
import { renderMobile, stubFetch } from './mobile.test-support.js';

const NOW = Date.parse('2026-11-19T09:50:00.000Z');
const at = (hours: number) => new Date(NOW + hours * 3_600_000).toISOString();
const lane = (name: string, patch: Partial<ResourceLaneRow>): ResourceLaneRow => ({
  lane: name, running: 1, target: 2, held: false, window: 'weekly', usedPct: 50, creditsRemaining: null, resetAt: at(37),
  burnPctPerHour: null, tokensPerHour6h: null, projectedExhaustion: null, source: null, deadSignal: null,
  observation: { source: 'claude-native-usage', asOf: at(-0.05) }, ...patch,
});
const view = (...lanes: ResourceLaneRow[]): PoolsViewV1 => buildPoolsView({ v: 1, generatedAt: at(0), asOf: at(0), lanes, apiSpend: null, jobsMalformedRows: null,
  sources: { status: 'healthy', apiSpend: 'missing', jobs: 'missing' } }, NOW);

afterEach(() => { evictAll(); vi.unstubAllGlobals(); });

describe('phone Home pool pace', () => {
  it('lists only the pools that need a decision, in the words phm pools prints', () => {
    const pools = view(lane('claude', { usedPct: 70, burnPctPerHour: 3.6 }), lane('zai', { usedPct: 20, burnPctPerHour: 0.1 }),
      lane('codex-cmp', { usedPct: 40, burnPctPerHour: 1.6 }), lane('grok', { usedPct: 40 }));
    const lines = poolPaceLines(pools);
    expect(lines.map(l => [l.id, l.tone])).toEqual([['claude', 'danger'], ['zai', 'warning'], ['grok', 'neutral']]);
    expect(lines[0]!.words).toBe(pools.pools[0]!.summary);
    expect(lines[0]!.words).toMatch(/: slow down$/);
    expect(lines[1]!.words).toMatch(/^Zai: \d+% will go unused: add work$/);
    expect(poolPaceLines(null)).toEqual([]);
  });

  it('shows the verdict on the card and nothing when every pool is on pace', async () => {
    stubFetch({ [`GET ${POOLS_PATH}`]: view(lane('claude', { usedPct: 70, burnPctPerHour: 3.6 })) });
    const { container } = renderMobile(<PoolPaceCard />);
    expect(await screen.findByText(/^Claude: empty about .* before reset: slow down$/)).toBeTruthy();
    expect(screen.getByText('Slow down')).toBeTruthy();
    evictAll();
    stubFetch({ [`GET ${POOLS_PATH}`]: view(lane('claude', { usedPct: 60, burnPctPerHour: 1.1 })) });
    const quiet = renderMobile(<PoolPaceCard />);
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(quiet.container.textContent).toBe('');
    expect(container).toBeTruthy();
  });
});
