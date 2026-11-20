import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { evictAll } from '../../../data/cache.js';
import { betName, LeaderActivityCard } from './LeaderActivityCard.js';

const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();
const section = { known: true, reason: null };
const brief = () => ({
  schema: 'leader.brief.v1', version: 1, generated_at: minutesAgo(0), window_hours: 24,
  jobs: { ...section, rows: [
    { id: 'RQ-GIFTOPENN21SQ8', result: 'published', pr_state: 'open', pr_url: 'https://example.test/pr/1', gap: null, reason: null, at: minutesAgo(12) },
    { id: 'RQ-MAPMINUTESN21OQ8', result: 'published', pr_state: 'merged', pr_url: 'https://example.test/pr/2', gap: null, reason: null, at: minutesAgo(90) },
    { id: 'RQ-EDGEN21QQ8', result: 'no_change', pr_state: null, pr_url: null, gap: 'nothing left to cut', reason: null, at: minutesAgo(120) },
    { id: 'RQ-LOADLOGN21CQ8', result: 'no_change', pr_state: null, pr_url: null, gap: null, reason: null, at: minutesAgo(130) },
    { id: 'RQ-SKIPVIEWN21CQ8', result: 'running', pr_state: null, pr_url: null, gap: null, reason: null, at: minutesAgo(5) },
    { id: 'RQ-BADN21CQ8', result: 'failed', pr_state: null, pr_url: 'javascript:alert(1)', gap: null, reason: null, at: minutesAgo(200) },
  ] },
  lanes: { ...section, rows: [] },
  admission: { ...section, state: 'closed', why: 'closed at the global cap (8 of 8 running)' },
  pools: { ...section, rows: [{ id: 'claude', used_pct: 40, hours_to_reset: 3.2, waste_risk: 'low', verdict: 'fine' }, { id: 'zai', used_pct: null, hours_to_reset: null, waste_risk: 'unknown', verdict: 'unknown' }] },
  gaps: { ...section, total: 0, top: [] },
  summary: 'x',
});
const unknown = (reason: string) => ({ known: false, reason });
const allUnknown = () => ({
  schema: 'leader.brief.v1', version: 1, generated_at: minutesAgo(0), window_hours: 24,
  jobs: { ...unknown('the router queue could not be read'), rows: [] },
  lanes: { ...unknown('status missing'), rows: [] },
  admission: { ...unknown('status missing'), state: 'unknown', why: null },
  pools: { ...unknown('the resource ledger could not be read'), rows: [] },
  gaps: { ...unknown('metrics missing'), total: null, top: [] },
  summary: 'unknown',
});
const serve = (body: unknown, status = 200) => vi.stubGlobal('fetch', vi.fn(async () => Response.json(body, { status })));

beforeEach(() => { evictAll(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

// jsdom does no layout, so "390px" is the phone-width box the card sits in; the wrapping itself is CSS.
const WIDTHS = [{ name: 'desktop', px: 960 }, { name: '390px phone', px: 390 }];

describe.each(WIDTHS)('Leader card at $name', ({ px }) => {
  const mount = () => render(<div style={{ width: px }}><LeaderActivityCard /></div>);

  it('shows the last pass, each bet on one line, the bottleneck and pool resets', async () => {
    serve(brief());
    mount();
    expect(await screen.findByRole('heading', { name: 'Leader · last pass 5m ago' })).toBeInTheDocument();
    expect(vi.mocked(fetch).mock.calls[0]?.[0]).toBe('/api/verse/comms/leader-brief');
    const items = screen.getAllByRole('listitem');
    expect(items).toHaveLength(6);
    expect(within(items[0]!).getByText('Giftopen')).toBeInTheDocument();
    expect(within(items[0]!).getByText('open')).toBeInTheDocument();
    expect(within(items[0]!).getByRole('link', { name: 'PR' })).toHaveAttribute('href', 'https://example.test/pr/1');
    expect(within(items[1]!).getByText('merged')).toBeInTheDocument();
    expect(within(items[2]!).getByText('no change')).toBeInTheDocument();
    expect(within(items[2]!).getByText('nothing left to cut')).toBeInTheDocument();
    expect(within(items[3]!).getByText('reason unknown')).toBeInTheDocument();
    expect(within(items[4]!).getByText('running')).toBeInTheDocument();
    expect(within(items[5]!).getByText('failed')).toBeInTheDocument();
    expect(within(items[5]!).queryByRole('link')).toBeNull();
    expect(screen.getByText('closed at the global cap (8 of 8 running)')).toBeInTheDocument();
    expect(screen.getByText('claude resets in 3 h · zai reset unknown')).toBeInTheDocument();
  });

  it('keeps an all-unknown brief unknown, with each reason', async () => {
    serve(allUnknown());
    mount();
    expect(await screen.findByRole('heading', { name: 'Leader · last pass unknown' })).toBeInTheDocument();
    expect(screen.getByText('Bets unknown: the router queue could not be read.')).toBeInTheDocument();
    expect(screen.getByText('Bottleneck unknown: status missing.')).toBeInTheDocument();
    expect(screen.getByText('Pools unknown: the resource ledger could not be read.')).toBeInTheDocument();
    expect(screen.queryByRole('listitem')).toBeNull();
    expect(screen.queryByText(/resets in/)).toBeNull();
  });

  it('shows the command when the brief is unavailable', async () => {
    serve({ schema: 'leader.brief.v1', unavailable: true });
    mount();
    expect(await screen.findByText(/Leader brief unavailable/)).toBeInTheDocument();
    expect(screen.getByText('phm leader brief --json')).toBeInTheDocument();
  });
});

it('turns a job id into a plain name', () => {
  expect(betName('RQ-GIFTOPENN21SQ8')).toBe('Giftopen');
  expect(betName('RQ-CL-DOCS-1795161183')).toBe('Cl docs 1795161183');
});
