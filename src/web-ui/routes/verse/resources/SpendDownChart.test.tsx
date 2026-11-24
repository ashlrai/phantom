import { render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildFleetPace } from '../../../../core/fleet/pace-verdict.js';
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
    row({ id: 'claude', label: 'Claude', state: 'under', used_frac: 0.72, even_pace_frac: 0.815, projected_at_reset: 0.88, resets_in_h: 22, verdict: 'behind: will waste ~12%' }),
    row({ id: 'codex-cmp', label: 'Codex Cmp', state: 'on-pace', used_frac: 0.5, even_pace_frac: 0.5, projected_at_reset: 1, verdict: 'spending on pace' }),
    row({ id: 'zai', label: 'Zai', state: 'drained', used_frac: 1, even_pace_frac: 0.4, projected_at_reset: 1, verdict: 'exhausted until Fri 6 PM' }),
    row({ id: 'grok', label: 'Grok', state: 'unknown', verdict: 'unknown: no fresh reading (3 h old)', reading_age_min: 180, reason: 'no reading since earlier' }),
  ],
};

afterEach(() => { evictAll(); vi.unstubAllGlobals(); });

describe('SpendDownChart', () => {
  it('renders an under-spending, an on-pace, a drained and an unknown plan from the JSON alone', () => {
    const { container } = render(<SpendDownChart data={FIXTURE} />);
    // One plain sentence per row, built here from the same fields when an older payload has none.
    expect(screen.getAllByTestId('spenddown-sentence').map(el => el.textContent)).toEqual([
      'Claude: 72% used, 22 hours left, behind: will leave 12% unused',
      'Codex Cmp: 50% used, reset time unknown, on pace',
      expect.stringMatching(/^Zai: 100% used, reset time unknown, spent$/),
      'Grok: unknown',
    ]);
    const bars = screen.getAllByRole('img');
    expect(bars.map(bar => bar.getAttribute('aria-label'))).toEqual([
      'Claude: 72% used, even pace 82%, ends near 88% at reset. behind: will waste ~12%',
      'Codex Cmp: 50% used, even pace 50%, ends near 100% at reset. spending on pace',
      'Zai: 100% used, even pace 40%, ends near 100% at reset. exhausted until Fri 6 PM',
      'Grok: unknown: no fresh reading (3 h old)',
    ]);
    const marks = (index: number, kind: string) => bars[index]!.querySelector<HTMLElement>(`[data-mark="${kind}"]`);
    expect(bars[0]!.querySelector<HTMLElement>('span')!.style.width).toBe('72%');
    expect(marks(0, 'even-pace')!.style.left).toBe('81.5%');
    expect(marks(0, 'projected')!.style.left).toBe('88%');
    // An unknown plan draws an empty track: no fill, tick or marker.
    expect(bars[3]!.children).toHaveLength(0);
    expect(container.querySelectorAll('[data-state]').length).toBe(4);
  });

  it('draws nothing for an empty list', () => {
    const { container } = render(<SpendDownChart data={{ ...FIXTURE, pools: [] }} />);
    expect(container).toBeEmptyDOMElement();
  });
});

// Queue and sign-in fields are optional: known hours, unknown hours, a sign-in block, and an older payload without them.
const QUEUE_FIXTURE: SpendDownV1 = {
  ...FIXTURE,
  pools: [
    row({ id: 'claude', label: 'Claude', state: 'on-pace', used_frac: 0.5, even_pace_frac: 0.5, projected_at_reset: 1, verdict: 'spending on pace', queued_hours: 3.5, blocked: null, blocked_fix: null }),
    row({ id: 'zai', label: 'Zai', state: 'on-pace', used_frac: 0.5, even_pace_frac: 0.5, projected_at_reset: 1, verdict: 'spending on pace', queued_hours: null }),
    row({ id: 'gemini', label: 'Gemini', state: 'under', used_frac: 0.2, verdict: 'blocked: sign-in', queued_hours: 0, blocked: 'sign-in', blocked_fix: 'sign in to Gemini once: run gemini in a terminal' }),
    row({ id: 'grok', label: 'Grok', state: 'on-pace', used_frac: 0.5, verdict: 'spending on pace' }),
  ],
};

describe('queued hours and sign-in block', () => {
  it('desktop chart shows hours, unknown, nothing queued and the sign-in step; older rows show no queue line', () => {
    render(<SpendDownChart data={QUEUE_FIXTURE} />);
    expect(screen.getAllByTestId('spenddown-queued').map(el => el.textContent)).toEqual(['3.5 h queued', 'queued: unknown', 'nothing queued']);
    expect(screen.getByText('blocked: sign-in')).toBeVisible();
    expect(screen.getByTestId('spenddown-blocked')).toHaveTextContent('sign in to Gemini once: run gemini in a terminal');
  });

  it('phone card shows the same words from the JSON', async () => {
    stubFetch({ 'GET /api/app/pools/spenddown': QUEUE_FIXTURE });
    renderMobile(<SpendDownCard />);
    expect(await screen.findByText('3.5 h queued')).toBeVisible();
    expect(screen.getByText('queued: unknown')).toBeVisible();
    expect(screen.getByText('blocked: sign-in')).toBeVisible();
  });
});

describe('running and queued', () => {
  const idle = row({ id: 'claude', label: 'Claude', state: 'idle', used_frac: 0.05, even_pace_frac: 0.05, projected_at_reset: 0.9, verdict: 'refilled, lane idle', running: 0, target: 2, queued_rows: 5 });
  const unread = row({ id: 'zai', label: 'Zai', state: 'on-pace', used_frac: 0.5, verdict: 'spending on pace', running: null, target: null, queued_rows: null });
  const data = { ...FIXTURE, pools: [idle, unread, row({ id: 'grok', label: 'Grok', state: 'unknown', verdict: 'unknown' })] };

  it('desktop shows the verdict with running slots and queued rows; unreported is unknown, older rows show no line', () => {
    render(<SpendDownChart data={data} />);
    expect(screen.getByText('refilled, lane idle')).toBeVisible();
    expect(screen.getAllByTestId('spenddown-slots').map(el => el.textContent)).toEqual(['0 running of 2 slots, 5 queued', 'running unknown, queue unknown']);
  });

  it('phone Pools card shows the same words', async () => {
    stubFetch({ 'GET /api/app/pools/spenddown': data });
    renderMobile(<SpendDownCard />);
    expect(await screen.findByText('0 running of 2 slots, 5 queued')).toBeVisible();
    expect(screen.getByText('Pools')).toBeVisible();
  });
});

describe('phone Home spend down card', () => {
  it('shows the chart from GET /api/app/pools/spenddown', async () => {
    stubFetch({ 'GET /api/app/pools/spenddown': FIXTURE });
    renderMobile(<SpendDownCard />);
    const claude = (await screen.findByText('Claude: 72% used, 22 hours left, behind: will leave 12% unused')).closest('[data-state]') as HTMLElement;
    expect(within(claude).getByRole('img')).toBeVisible();
    expect(screen.getByText('Grok: unknown')).toBeVisible();
  });

  it('stays quiet when there are no plans', async () => {
    stubFetch({ 'GET /api/app/pools/spenddown': { ...FIXTURE, pools: [] } });
    const { container } = renderMobile(<SpendDownCard />);
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(container).toBeEmptyDOMElement();
  });
});

describe('pace verdict under each row (fleet.pace.v1)', () => {
  const NOW = Date.parse('2026-11-19T10:00:00Z');
  const p = (id: string, usedPct: number | null, hoursLeft: number | null, burn: number | null) =>
    ({ id, usedPct, hoursLeft, burnPctPerHour: burn, resetAt: hoursLeft === null ? null : new Date(NOW + hoursLeft * 3_600_000).toISOString() });
  const pace = buildFleetPace({ generatedAt: FIXTURE.generated_at, pools: [p('claude', 64, 100, 2), p('codex-cmp', 50, 50, 1), p('zai', 30, 100, 0.1), p('grok', null, null, null)] }, NOW);

  it('desktop shows the word and one sentence for ahead, behind, on pace and unknown', () => {
    render(<SpendDownChart data={FIXTURE} pace={pace} />);
    const lines = screen.getAllByTestId('pace-sentence');
    expect(lines.map(el => el.getAttribute('data-pace'))).toEqual(['ahead', 'on-pace', 'behind', 'unknown']);
    expect(lines.map(el => el.querySelector('strong')!.textContent)).toEqual(['over', 'over', 'ok', 'unknown']);
    expect(lines[0]).toHaveTextContent('Claude: 64% used, 100 h left, spending 2/h, safe is 0.31/h. Over pace, empty in about 18 h.');
    expect(lines[0]).toHaveAttribute('data-over', 'true');
    expect(lines[3]!.textContent).toBe('unknown Grok: unknown% used, unknown h left, spending unknown/h, safe is unknown/h. Pace unknown, empty time unknown.');
  });

  it('shows no verdict line when the pace read is missing', () => {
    render(<SpendDownChart data={FIXTURE} pace={null} />);
    expect(screen.queryAllByTestId('pace-sentence')).toHaveLength(0);
  });

  it('phone card shows the same sentences from GET /api/fleet/pace', async () => {
    stubFetch({ 'GET /api/app/pools/spenddown': FIXTURE, 'GET /api/fleet/pace': pace });
    renderMobile(<SpendDownCard />);
    expect(await screen.findByText(/Claude: 64% used.*Over pace/u)).toHaveAttribute('data-over', 'true');
    expect(screen.getByText(/Zai: 30% used.*On pace/u)).toBeVisible();
    expect(screen.getByText(/Grok: unknown% used.*Pace unknown/u)).toBeVisible();
  });
});
