import { render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SPENDDOWN_SCHEMA, type SpendDownRow, type SpendDownV1 } from '../../../../core/fleet/pools-spenddown.js';
import { evictAll } from '../../../data/cache.js';
import { renderMobile, stubFetch } from '../mobile/mobile.test-support.js';
import { SpendDownCard } from '../mobile/SpendDownCard.js';
import { SpendDownChart } from './SpendDownChart.js';

const row = (patch: Partial<SpendDownRow> & Pick<SpendDownRow, 'id' | 'label' | 'state' | 'verdict'>): SpendDownRow => ({
  used_frac: null, reset_at: null, resets_in_h: null, as_of: null, reading_age_min: null, even_pace_frac: null, projected_at_reset: null, projected_empty_at: null, reason: null, ...patch,
});
// One plan in each state, as `phm pools spenddown --json` prints them.
const FIXTURE: SpendDownV1 = {
  schema: SPENDDOWN_SCHEMA, generated_at: '2026-11-19T10:00:00.000Z',
  pools: [
    row({ id: 'claude', label: 'Claude', state: 'under', used_frac: 0.72, even_pace_frac: 0.815, projected_at_reset: 0.88, resets_in_h: 22, verdict: 'will leave 12% unused: add work' }),
    row({ id: 'codex-cmp', label: 'Codex Cmp', state: 'on-pace', used_frac: 0.5, even_pace_frac: 0.5, projected_at_reset: 1, verdict: 'on pace' }),
    row({ id: 'zai', label: 'Zai', state: 'drained', used_frac: 1, even_pace_frac: 0.4, projected_at_reset: 1, verdict: 'drained until Fri 6 PM' }),
    row({ id: 'grok', label: 'Grok', state: 'unknown', verdict: 'unknown: no fresh reading (3 h old)', reading_age_min: 180, reason: 'no reading since earlier' }),
  ],
};

afterEach(() => { evictAll(); vi.unstubAllGlobals(); });

describe('SpendDownChart', () => {
  it('renders an under-spending, an on-pace, a drained and an unknown plan from the JSON alone', () => {
    const { container } = render(<SpendDownChart data={FIXTURE} />);
    for (const words of ['will leave 12% unused: add work', 'on pace', 'drained until Fri 6 PM', 'unknown: no fresh reading (3 h old)']) expect(screen.getByText(words)).toBeVisible();
    const bars = screen.getAllByRole('img');
    expect(bars.map(bar => bar.getAttribute('aria-label'))).toEqual([
      'Claude: 72% used, even pace 82%, ends near 88% at reset. will leave 12% unused: add work',
      'Codex Cmp: 50% used, even pace 50%, ends near 100% at reset. on pace',
      'Zai: 100% used, even pace 40%, ends near 100% at reset. drained until Fri 6 PM',
      'Grok: unknown: no fresh reading (3 h old)',
    ]);
    const marks = (index: number, kind: string) => bars[index]!.querySelector<HTMLElement>(`[data-mark="${kind}"]`);
    expect(bars[0]!.querySelector<HTMLElement>('span')!.style.width).toBe('72%');
    expect(marks(0, 'even-pace')!.style.left).toBe('81.5%');
    expect(marks(0, 'projected')!.style.left).toBe('88%');
    // An unknown plan draws an empty track: no fill, tick or marker.
    expect(bars[3]!.children).toHaveLength(0);
    expect(container.querySelectorAll('[data-state]').length).toBe(4);
    expect(screen.getByText('resets in 22 h')).toBeVisible();
  });

  it('draws nothing for an empty list', () => {
    const { container } = render(<SpendDownChart data={{ ...FIXTURE, pools: [] }} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe('phone Home spend down card', () => {
  it('shows the chart from GET /api/app/pools/spenddown', async () => {
    stubFetch({ 'GET /api/app/pools/spenddown': FIXTURE });
    renderMobile(<SpendDownCard />);
    const claude = (await screen.findByText('will leave 12% unused: add work')).closest('[data-state]') as HTMLElement;
    expect(within(claude).getByText('Claude')).toBeVisible();
    expect(screen.getByText('unknown: no fresh reading (3 h old)')).toBeVisible();
  });

  it('stays quiet when there are no plans', async () => {
    stubFetch({ 'GET /api/app/pools/spenddown': { ...FIXTURE, pools: [] } });
    const { container } = renderMobile(<SpendDownCard />);
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(container).toBeEmptyDOMElement();
  });
});
