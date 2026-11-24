/** Reading one stored reading at a time on a Pools card's window chart: by pointer, by keyboard, and in words. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { buildPoolsView, POOLS_PATH } from '../../../../core/fleet/pools-view.js';
import type { ResourceLaneRow, ResourceLedgerV1 } from '../../../../core/fleet/runs-resource-ledger.js';
import { poolUsageSeries, type PoolUsageSeries, type UsageHistoryV1, type UsageReading } from '../../../../core/fleet/usage-history.js';
import { evictAll } from '../../../data/cache.js';
import type { PaneProps } from '../panes/pane-registry.js';
import { FleetPoolsPane } from './FleetPoolsPane.js';
import { readingTime, windowDay } from './PoolWindow.js';
import { nearestReading, poolWindow, readingAt, readingWords, stepReading, type WindowChart } from './pool-window-model.js';
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
const reading = (pool: string, hours: number, used: number): UsageReading =>
  ({ pool, used_pct: used, observed_at: at(hours), reset_at: at(60), source: 'claude-native-usage' });
// The series goes through the route's own projection, so the readings are tested against what the server sends.
const series = (pool: string, ...rows: UsageReading[]): PoolUsageSeries => poolUsageSeries(pool, rows, NOW);
const history = (...pools: PoolUsageSeries[]): UsageHistoryV1 => ({ schema: 'fleet.usage-history.v1', v: 1, generated_at: at(0), source_state: 'healthy', pools });
/** A week's window ending 60 h from now began 108 h ago. Three readings: 12 h, 60 h and 107 h into it. */
const CLAUDE = [reading('claude', -96, 5), reading('claude', -48, 30), reading('claude', -1, 60)];
const chartOf = (...rows: UsageReading[]): WindowChart => {
  const window = poolWindow(series('claude', ...rows), { usedPct: 60, projectedEmptyAt: null, projectedUnusedPct: 0 }, NOW);
  if (window.kind !== 'chart') throw new Error('expected a chart');
  return window.chart;
};

function serve(windows: UsageHistoryV1) {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => url.includes(POOL_WINDOWS_PATH) ? Response.json(windows)
    : url.includes(POOLS_PATH) ? Response.json(view(lane('claude', { usedPct: 60, burnPctPerHour: 0.5 }))) : Response.json({}, { status: 404 })));
}
const props = { visible: true } as PaneProps;
// jsdom here builds pointer events without a position, so they are sent as mouse events under the pointer names React listens for.
const pointer = (target: HTMLElement, type: string, clientX: number) => fireEvent(target, new MouseEvent(type, { bubbles: true, clientX }));
const words = (index: number, text: string) => `Reading ${index} of 3, ${readingTime(Date.parse(at([-96, -48, -1][index - 1]!)))}: ${text}`;
const FIRST = words(1, '5% used against 7.1% on the even line: 2.1 points under.');
const SECOND = words(2, '30% used against 35.7% on the even line: 5.7 points under.');
const NEWEST = words(3, '60% used against 63.7% on the even line: 3.7 points under.');

async function mount() {
  serve(history(series('claude', ...CLAUDE)));
  render(<FleetPoolsPane {...props} />);
  const claude = await screen.findByRole('listitem', { name: 'claude pool' });
  const plot = await within(claude).findByRole('slider', { name: 'claude stored readings' });
  // jsdom lays nothing out, so the plot is given a place: 200 px wide from x = 100.
  plot.getBoundingClientRect = () => ({ left: 100, width: 200, top: 0, height: 80, right: 300, bottom: 80, x: 100, y: 0, toJSON: () => ({}) });
  const picked = () => claude.querySelector<HTMLElement>('[data-point="picked"]');
  const caption = () => claude.querySelector('figcaption')!.textContent;
  return { claude, plot, picked, caption };
}

beforeEach(() => { evictAll(); vi.spyOn(Date, 'now').mockReturnValue(NOW); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('one reading of a window', () => {
  it('carries each reading’s own time and share, and the even line as it stood then', () => {
    const chart = chartOf(...CLAUDE);
    expect(chart.stored).toEqual([-96, -48, -1].map((hours, index) => ({ atMs: Date.parse(at(hours)), usedPct: [5, 30, 60][index] })));
    expect(readingAt(chart, 0)).toEqual({ index: 0, of: 3, atMs: Date.parse(at(-96)), usedPct: 5, evenPct: 7.1, gap: -2.1 });
    expect(readingAt(chart, 1)).toMatchObject({ evenPct: 35.7, gap: -5.7 });
    // The newest reading takes the route's own even-line figure, the one the caption states.
    expect(readingAt(chart, 2)).toMatchObject({ usedPct: 60, evenPct: chart.evenPct, gap: chart.gap });
    expect(readingAt(chart, 3)).toBeNull();
    expect(readingAt(chart, -1)).toBeNull();
    expect(readingWords(readingAt(chart, 1)!, () => 'then')).toBe('Reading 2 of 3, then: 30% used against 35.7% on the even line: 5.7 points under.');
  });

  it('keeps a reading above the even line over it, and the stored share when the plot clips it', () => {
    const chart = chartOf(reading('claude', -96, 40), reading('claude', -1, 104));
    expect(readingAt(chart, 0)).toMatchObject({ usedPct: 40, evenPct: 7.1, gap: 32.9 });
    expect(chart.points[1]).toMatchObject({ y: 100 });
    expect(readingAt(chart, 1)).toMatchObject({ usedPct: 104 });
  });

  it('finds the reading drawn nearest to a place on the plot', () => {
    const chart = chartOf(...CLAUDE);
    expect([0, 7.14, 21, 22, 49, 50, 63.69, 100].map(x => nearestReading(chart, x))).toEqual([0, 0, 0, 1, 1, 2, 2, 2]);
    expect(nearestReading({ points: [] }, 50)).toBe(-1);
    // Two readings drawn at one place: the later one.
    expect(nearestReading({ points: [{ x: 10, y: 1 }, { x: 10, y: 2 }] }, 10)).toBe(1);
  });

  it('steps with the arrows, stops at the ends and leaves other keys alone', () => {
    expect(['ArrowLeft', 'ArrowDown', 'ArrowRight', 'ArrowUp', 'Home', 'End'].map(key => stepReading(key, 1, 3))).toEqual([0, 0, 2, 2, 0, 2]);
    expect([stepReading('ArrowLeft', 0, 3), stepReading('ArrowRight', 2, 3)]).toEqual([0, 2]);
    expect(['a', 'Enter', '[', ']', 'Tab'].map(key => stepReading(key, 1, 3))).toEqual([null, null, null, null, null]);
    expect(stepReading('End', 0, 0)).toBeNull();
  });
});

describe('reading the chart on a Pools card', () => {
  it('says the newest reading as the slider’s value and marks none until one is picked', async () => {
    const { plot, picked, caption } = await mount();
    expect(plot).toHaveAttribute('aria-valuemin', '1');
    expect(plot).toHaveAttribute('aria-valuemax', '3');
    expect(plot).toHaveAttribute('aria-valuenow', '3');
    expect(plot).toHaveAttribute('aria-valuetext', NEWEST);
    expect(plot).toHaveAttribute('tabindex', '0');
    expect(picked()).toBeNull();
    expect(caption()).toBe(`3 readings since ${windowDay(Date.parse(at(-108)))}. 60% used against 63.7% on the even line: 3.7 points under. Dotted: where this burn leads.`);
    expect(screen.getByText(/Point at a chart, or focus it and press Left or Right, to read one reading at a time\./)).toBeInTheDocument();
  });

  it('picks the reading nearest the pointer, marks it, and lets go when the pointer leaves', async () => {
    const { claude, plot, picked, caption } = await mount();
    // 36% of the way across the plot: the second reading is drawn at 35.71%.
    pointer(plot, 'pointermove', 172);
    expect(picked()?.style).toMatchObject({ left: '35.71%', bottom: '30%' });
    expect(claude.querySelector<HTMLElement>('[data-rule="picked"]')?.style.left).toBe('35.71%');
    expect(caption()).toBe(SECOND);
    expect(claude.querySelector('figcaption')).toHaveAttribute('data-reading', '2');
    expect(plot).toHaveAttribute('aria-valuenow', '2');
    expect(plot).toHaveAttribute('aria-valuetext', SECOND);
    // The newest reading keeps its dot, and the chart itself is unchanged.
    expect(claude.querySelector('[data-point="latest"]')).not.toBeNull();
    expect(within(claude).getByRole('img', { name: /^claude window so far: 3 readings/ })).toBeInTheDocument();
    pointer(plot, 'pointermove', 101);
    expect(caption()).toBe(FIRST);
    fireEvent.pointerLeave(plot);
    expect(picked()).toBeNull();
    expect(caption()).toMatch(/^3 readings since /);
    expect(plot).toHaveAttribute('aria-valuenow', '3');
  });

  it('steps through the readings from the keyboard, starting at the newest', async () => {
    const { plot, picked, caption } = await mount();
    act(() => plot.focus());
    expect(caption()).toBe(NEWEST);
    expect(picked()?.style).toMatchObject({ left: '63.69%', bottom: '60%' });
    fireEvent.keyDown(plot, { key: 'ArrowLeft' });
    expect(caption()).toBe(SECOND);
    fireEvent.keyDown(plot, { key: 'Home' });
    expect(caption()).toBe(FIRST);
    fireEvent.keyDown(plot, { key: 'ArrowLeft' });
    expect(caption()).toBe(FIRST);
    fireEvent.keyDown(plot, { key: 'End' });
    expect(caption()).toBe(NEWEST);
    // A handled key does not scroll the board; one the chart does not take is left to the board ([ and ] change board).
    expect(fireEvent.keyDown(plot, { key: 'ArrowLeft' })).toBe(false);
    expect(fireEvent.keyDown(plot, { key: ']' })).toBe(true);
    expect(fireEvent.keyDown(plot, { key: 'ArrowLeft', metaKey: true })).toBe(true);
    expect(caption()).toBe(SECOND);
  });

  it('keeps a reading picked by the pointer while the plot has focus, and lets go on Esc or when focus leaves', async () => {
    const { plot, picked, caption } = await mount();
    const outer = vi.fn();
    document.addEventListener('keydown', outer);
    act(() => plot.focus());
    pointer(plot, 'pointerdown', 172);
    fireEvent.pointerLeave(plot);
    expect(caption()).toBe(SECOND);
    // The first Esc belongs to the chart; with nothing picked, Esc goes on to the pane.
    fireEvent.keyDown(plot, { key: 'Escape' });
    expect(picked()).toBeNull();
    expect(outer).not.toHaveBeenCalled();
    fireEvent.keyDown(plot, { key: 'Escape' });
    expect(outer).toHaveBeenCalledTimes(1);
    document.removeEventListener('keydown', outer);
    fireEvent.keyDown(plot, { key: 'ArrowLeft' });
    expect(caption()).toBe(SECOND);
    act(() => plot.blur());
    expect(picked()).toBeNull();
    expect(caption()).toMatch(/^3 readings since /);
  });

  it('reads a window with a single reading', async () => {
    serve(history(series('claude', reading('claude', -1, 60))));
    render(<FleetPoolsPane {...props} />);
    const plot = await screen.findByRole('slider', { name: 'claude stored readings' });
    const only = `Reading 1 of 1, ${readingTime(Date.parse(at(-1)))}: 60% used against 63.7% on the even line: 3.7 points under.`;
    expect(plot).toHaveAttribute('aria-valuemax', '1');
    expect(plot).toHaveAttribute('aria-valuetext', only);
    act(() => plot.focus());
    fireEvent.keyDown(plot, { key: 'ArrowLeft' });
    expect(plot.closest('figure')!.querySelector('figcaption')!.textContent).toBe(only);
  });
});
