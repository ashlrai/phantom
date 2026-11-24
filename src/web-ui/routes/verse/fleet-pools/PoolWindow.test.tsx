/** The window chart on a Pools card: the plot's coordinates from stored readings, its words, and every state that draws no chart. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { buildPoolsView, POOLS_PATH } from '../../../../core/fleet/pools-view.js';
import type { ResourceLaneRow, ResourceLedgerV1 } from '../../../../core/fleet/runs-resource-ledger.js';
import { poolUsageSeries, type PoolUsageSeries, type UsageHistoryV1, type UsageReading } from '../../../../core/fleet/usage-history.js';
import { evictAll } from '../../../data/cache.js';
import type { PaneProps } from '../panes/pane-registry.js';
import { FleetPoolsPane } from './FleetPoolsPane.js';
import { windowDay } from './PoolWindow.js';
import { gapWords, poolWindow } from './pool-window-model.js';
import { POOL_WINDOWS_PATH } from './pool-window-query.js';

const NOW = Date.parse('2026-11-17T12:00:00.000Z');
const at = (hours: number) => new Date(NOW + hours * 3_600_000).toISOString();
const lane = (name: string, patch: Partial<ResourceLaneRow>): ResourceLaneRow => ({
  lane: name, running: 1, target: 2, held: false, window: 'weekly', usedPct: 50, creditsRemaining: null, resetAt: at(60),
  burnPctPerHour: null, tokensPerHour6h: null, projectedExhaustion: null, source: null, deadSignal: null,
  observation: { source: 'claude-native-usage', asOf: at(-0.1) }, ...patch,
});
const view = (...lanes: ResourceLaneRow[]) => buildPoolsView({ v: 1, generatedAt: at(0), asOf: at(0), lanes, apiSpend: null, jobsMalformedRows: null,
  sources: { status: 'healthy', apiSpend: 'missing', jobs: 'missing' } } satisfies ResourceLedgerV1, NOW);
const reading = (pool: string, hours: number, used: number, reset: number | null = 60): UsageReading =>
  ({ pool, used_pct: used, observed_at: at(hours), reset_at: reset === null ? null : at(reset), source: 'claude-native-usage' });
// The series goes through the route's own projection, so the chart is tested against what the server sends.
const series = (pool: string, ...rows: UsageReading[]): PoolUsageSeries => poolUsageSeries(pool, rows, NOW);
const history = (...pools: PoolUsageSeries[]): UsageHistoryV1 => ({ schema: 'fleet.usage-history.v1', v: 1, generated_at: at(0), source_state: 'healthy', pools });
/** A week's window ending 60 h from now began 108 h ago. Three readings: 12 h, 60 h and 107 h into it. */
const CLAUDE = [reading('claude', -96, 5), reading('claude', -48, 30), reading('claude', -1, 60)];

let asked: string[] = [];
function serve(pools: unknown, windows: unknown | 'pending', status = 200) {
  asked = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    asked.push(url);
    if (url.includes(POOL_WINDOWS_PATH)) return windows === 'pending' ? new Promise<Response>(() => undefined) : Response.json(windows, { status });
    return url.includes(POOLS_PATH) ? Response.json(pools) : Response.json({}, { status: 404 });
  }));
}
const card = (name: string) => screen.findByRole('listitem', { name: `${name} pool` });
const lines = (row: HTMLElement, kind: string) => [...row.querySelectorAll<SVGElement>(`[data-line="${kind}"]`)];
const props = { visible: true } as PaneProps;

beforeEach(() => { evictAll(); vi.spyOn(Date, 'now').mockReturnValue(NOW); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('poolWindow', () => {
  type Row = Parameters<typeof poolWindow>[1];
  const row: Row = { usedPct: 60, projectedEmptyAt: null, projectedUnusedPct: 0 };

  it('places each stored reading by its share of the window and its used share', () => {
    const window = poolWindow(series('claude', ...CLAUDE), row, NOW);
    if (window.kind !== 'chart') throw new Error('expected a chart');
    expect(window.chart.points).toEqual([{ x: 7.14, y: 5 }, { x: 35.71, y: 30 }, { x: 63.69, y: 60 }]);
    expect(window.chart.nowX).toBe(64.29);
    expect(window.chart.days).toEqual([14.29, 28.57, 42.86, 57.14, 71.43, 85.71]);
    expect([window.chart.startMs, window.chart.endMs]).toEqual([Date.parse(at(-108)), Date.parse(at(60))]);
    expect(window.chart).toMatchObject({ latest: { usedPct: 60, atMs: Date.parse(at(-1)) }, evenPct: 63.7, gap: -3.7 });
    expect(gapWords(window.chart)).toBe('60% used against 63.7% on the even line: 3.7 points under.');
  });

  it('ends the line ahead where the card says this burn ends, and draws none without a current reading', () => {
    const ahead = (patch: Partial<Row>) => {
      const window = poolWindow(series('claude', ...CLAUDE), { ...row, ...patch }, NOW);
      return window.kind === 'chart' ? window.chart.ahead?.to ?? null : 'no chart';
    };
    expect(ahead({})).toEqual({ x: 100, y: 100 });
    expect(ahead({ projectedUnusedPct: 25 })).toEqual({ x: 100, y: 75 });
    // Empty 30 h from now is 138 h into the 168 h window.
    expect(ahead({ projectedEmptyAt: at(30), projectedUnusedPct: 0 })).toEqual({ x: 82.14, y: 100 });
    // A burn of zero is a flat line to the reset, not a missing one.
    expect(ahead({ projectedUnusedPct: 40 })).toEqual({ x: 100, y: 60 });
    expect(ahead({ projectedUnusedPct: null })).toBeNull();
    expect(ahead({ usedPct: null })).toBeNull();
  });

  it('says over, under or on the even line, and only the used share when there is no line', () => {
    const base = { latest: { usedPct: 70, atMs: NOW } };
    expect(gapWords({ ...base, evenPct: 63.7, gap: 6.3 })).toBe('70% used against 63.7% on the even line: 6.3 points over.');
    expect(gapWords({ ...base, evenPct: 69, gap: 1 })).toBe('70% used against 69% on the even line: 1 point over.');
    expect(gapWords({ ...base, evenPct: 70, gap: 0 })).toBe('70% used against 70% on the even line: on it.');
    expect(gapWords({ ...base, evenPct: null, gap: null })).toBe('70% used.');
  });

  it('draws nothing it was not given: no readings, or readings without a reset time', () => {
    expect(poolWindow(undefined, row, NOW)).toEqual({ kind: 'none', why: 'No stored readings for this window yet.' });
    expect(poolWindow(series('claude'), row, NOW)).toEqual({ kind: 'none', why: 'No stored readings for this window yet.' });
    expect(poolWindow(series('claude', reading('claude', -5, 20, null), reading('claude', -1, 22, null)), row, NOW))
      .toEqual({ kind: 'none', why: 'Reset time unknown, so the window cannot be drawn (2 readings stored).' });
  });
});

describe('the Pools board', () => {
  const POOLS = () => view(
    lane('claude', { usedPct: 60, burnPctPerHour: 0.5 }),
    lane('codex-personal', { usedPct: 20 }),
    lane('devin', { window: 'credits', usedPct: null, creditsRemaining: 120, resetAt: null }),
  );

  it('draws a plan pool its window so far from the usage-history route, and asks that route once', async () => {
    const pools = POOLS();
    serve(pools, history(series('claude', ...CLAUDE)));
    render(<FleetPoolsPane {...props} />);
    const claude = await card('claude');
    const start = windowDay(Date.parse(at(-108)));
    const plot = await within(claude).findByRole('img', { name: `claude window so far: 3 readings since ${start}. 60% used against 63.7% on the even line: 3.7 points under.` });
    expect(plot.closest('figure')).toHaveAttribute('data-risk', pools.pools.find(row => row.id === 'claude')!.wasteRisk);
    expect(lines(claude, 'measured').map(line => line.getAttribute('points'))).toEqual(['7.14,95 35.71,70 63.69,40']);
    expect(lines(claude, 'even')).toHaveLength(1);
    expect(lines(claude, 'day')).toHaveLength(6);
    expect(lines(claude, 'now').map(line => line.getAttribute('x1'))).toEqual(['64.29']);
    // 60% used and 0.5%/h for 60 h ends at 90%: the card says 10% unused at reset, and the dotted line ends there.
    expect(within(claude).getByText('Unused at reset').nextElementSibling?.textContent).toBe('10%');
    expect(lines(claude, 'ahead').map(line => ['x1', 'y1', 'x2', 'y2'].map(name => line.getAttribute(name)))).toEqual([['63.69', '40', '100', '10']]);
    expect(claude.querySelector<HTMLElement>('[data-point="latest"]')?.style).toMatchObject({ left: '63.69%', bottom: '60%' });
    expect(within(claude).getByText(`3 readings since ${start}. 60% used against 63.7% on the even line: 3.7 points under. Dotted: where this burn leads.`)).toBeInTheDocument();
    // A plan pool the history does not hold says so; a credit balance has no window at all.
    expect(within(await card('codex-personal')).getByText('No stored readings for this window yet.')).toBeInTheDocument();
    expect((await card('devin')).querySelector('[data-window]')).toBeNull();
    expect(asked.filter(url => url.includes(POOL_WINDOWS_PATH))).toHaveLength(1);
    expect(screen.getByText(/^Chart: every stored reading/)).toBeInTheDocument();
  });

  it('draws one reading as a dot with no line, and repeats the route’s reason', async () => {
    serve(view(lane('claude', { usedPct: 60 })), history(series('claude', reading('claude', -1, 60))));
    render(<FleetPoolsPane {...props} />);
    const claude = await card('claude');
    await within(claude).findByRole('img', { name: /^claude window so far: 1 reading since / });
    expect(lines(claude, 'measured')).toEqual([]);
    expect(lines(claude, 'ahead')).toEqual([]);
    expect(claude.querySelector('[data-point="latest"]')).not.toBeNull();
    expect(within(claude).getByText(/ on the even line: 3\.7 points under\. Only one reading in this window\.$/)).toBeInTheDocument();
  });

  it('keeps the readings of a pool whose latest reading is stale, with no line ahead', async () => {
    serve(view(lane('claude', { usedPct: 60, burnPctPerHour: 0.5, observation: { source: 'claude-native-usage', asOf: at(-2) } })), history(series('claude', ...CLAUDE)));
    render(<FleetPoolsPane {...props} />);
    const claude = await card('claude');
    await within(claude).findByRole('img', { name: /^claude window so far: 3 readings/ });
    expect(within(claude).getByText('Used').nextElementSibling?.textContent).toBe('unknown');
    expect(lines(claude, 'measured')).toHaveLength(1);
    expect(lines(claude, 'ahead')).toEqual([]);
    expect(within(claude).queryByText(/Dotted: where this burn leads/)).toBeNull();
  });

  it('holds the plot’s place while the readings are read', async () => {
    serve(POOLS(), 'pending');
    render(<FleetPoolsPane {...props} />);
    const claude = await card('claude');
    expect(claude.querySelector('[data-window="loading"]')).not.toBeNull();
    expect((await card('devin')).querySelector('[data-window]')).toBeNull();
    expect(screen.queryByText(/could not be read/)).toBeNull();
  });

  it('says once that the readings could not be read, for a failed read and for a drifted payload, and draws no chart', async () => {
    for (const [body, status] of [[{ error: 'down' }, 500], [{ schema: 'fleet.usage-history.v2', pools: [] }, 200]] as const) {
      serve(POOLS(), body, status);
      const mounted = render(<FleetPoolsPane {...props} />);
      expect(await screen.findByText('The stored readings could not be read, so no card draws its window. Each card still shows its latest reading.')).toBeInTheDocument();
      expect(mounted.container.querySelector('[data-window]')).toBeNull();
      expect(within(await card('claude')).getByText('Used').nextElementSibling?.textContent).toBe('60%');
      mounted.unmount(); evictAll();
    }
    // With only a credit balance on the board there is no window to miss, so nothing is said.
    serve(view(lane('devin', { window: 'credits', usedPct: null, creditsRemaining: 120, resetAt: null })), { error: 'down' }, 500);
    render(<FleetPoolsPane {...props} />);
    await card('devin');
    await vi.waitFor(() => expect(asked.some(url => url.includes(POOL_WINDOWS_PATH))).toBe(true));
    expect(screen.queryByText(/could not be read/)).toBeNull();
  });
});
