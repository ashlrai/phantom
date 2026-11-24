/**
 * The rail's resource rows draw the shared WindowBar, not a battery: what is USED of the binding window, the
 * reserve and the time gone where the row knows them, a hatched bar for no current reading, a hairline in the
 * collapsed rail, and a readiness dot (never a bar) for local models, which are not metered.
 */
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useQuery } from '../../../data/hooks.js';
import { capacity, LOCAL_SEAT_V2, nativeSeat, seatWindow } from '../seat-fixtures.test-support.js';
import { useCapacityData } from '../usage/CapacityStrip.js';
import { buildCapacityRows, type CapacityRow } from '../usage/capacity-strip-model.js';
import { barRows, ResourcesBar } from './ResourcesBar.js';
import { reloadResourcesUiForTest, RESOURCES_STORAGE_KEY } from './resources-store.js';

vi.mock('../usage/CapacityStrip.js', async (original) => ({
  ...await original<typeof import('../usage/CapacityStrip.js')>(),
  useCapacityData: vi.fn(),
}));
vi.mock('../../../data/hooks.js', async (original) => ({
  ...await original<typeof import('../../../data/hooks.js')>(),
  useQuery: vi.fn(() => ({ data: undefined })),
}));
vi.mock('../shell/section-visibility.js', async (original) => ({
  ...await original<typeof import('../shell/section-visibility.js')>(),
  usePollWhileVisible: vi.fn(),
}));

const NOW = Date.now();
const DAY = 86_400_000;
const RESET = new Date(NOW + 2 * DAY).toISOString();
const weekly = (at: string) => ({ kind: 'weekly-deadline' as const, at, description: null, source: 'claude-native-usage-report', plan: 'max' as const });

function claudeSeat(observedAgoMs = 60_000) {
  const week = seatWindow({ id: 'seven_day', usedPercent: 62, resetsAt: RESET, resetProvenance: weekly(RESET) });
  return nativeSeat(capacity({ planType: 'max', windows: [week], binding: week, usability: 'ready', observedAt: new Date(NOW - observedAgoMs).toISOString() }), { id: 'claude-week', label: 'Claude week' });
}

function mount(seats: Parameters<typeof buildCapacityRows>[0], expanded: boolean) {
  vi.mocked(useCapacityData).mockReturnValue({ seats: [...seats], health: null, budget: null, loading: false, refreshing: false, readFailed: false, rosterUnavailable: false, pendingSeatIds: [] });
  const view = render(<ResourcesBar expanded={expanded} now={NOW} />);
  const evidence = within(view.container).queryByRole('button', { name: /Usage sources and budgets/ });
  if (evidence?.getAttribute('aria-expanded') === 'false') fireEvent.click(evidence);
  return view;
}

const parts = (meter: HTMLElement) => [...meter.children].map(part => [part.getAttribute('data-part'), (part as HTMLElement).style.width || (part as HTMLElement).style.left]);

beforeEach(() => { localStorage.removeItem(RESOURCES_STORAGE_KEY); reloadResourcesUiForTest(); });
afterEach(() => { cleanup(); vi.mocked(useQuery).mockReturnValue({ data: undefined } as never); });

describe('rail account rows on the shared bar', () => {
  it('draws what is used and marks the time gone where the seat reports the window start', () => {
    mount([claudeSeat()], true);
    const row = screen.getByRole('button', { name: /^Claude week:/ });
    const meter = within(row).getByRole('meter', { name: 'Claude week used' });
    expect(meter).toHaveAttribute('data-size', 'bar');
    expect(meter).toHaveAttribute('data-ending', 'open');
    expect(meter).toHaveAttribute('aria-valuenow', '62');
    expect(parts(meter)).toEqual([['used', '62%'], ['elapsed', '71.4%']]);
    expect(meter.getAttribute('aria-valuetext')).toBe('38% left, 71% of the window gone · use is 9 points behind an even spend');
    // The same words are a line of the hover card, named by the window they describe.
    fireEvent.focus(row);
    expect(screen.getByRole('tooltip')).toHaveTextContent('Weekly window: 71% of the window gone · use is 9 points behind an even spend');
  });

  it('draws a hairline with no time mark in the collapsed rail', () => {
    mount([claudeSeat()], false);
    const meter = within(screen.getByRole('button', { name: /^Claude week:/ })).getByRole('meter', { name: 'Claude week used' });
    expect(meter).toHaveAttribute('data-size', 'edge');
    expect(parts(meter)).toEqual([['used', '62%']]);
  });

  it('gives local models a readiness dot and no bar: they are not metered', () => {
    mount([LOCAL_SEAT_V2], true);
    const row = screen.getByRole('button', { name: /^Qwen3 Coder \(local\):|^Local/ });
    expect(within(row).queryByRole('meter')).toBeNull();
    const dot = row.querySelector('[data-ready]')!;
    expect(dot).toHaveAttribute('aria-hidden', 'true');
    expect(dot.getAttribute('data-ready')).toBe(row.getAttribute('data-level'));
  });
});

describe('barRows window facts', () => {
  const rowOf = (over: Partial<CapacityRow> = {}): CapacityRow => ({ ...buildCapacityRows([claudeSeat()], { now: NOW })[0]!, ...over });
  const reserve = (percent: number | null) => ({ percent, label: percent === null ? 'Autonomy off — all yours' : `Reserved for you ${percent}%`, autonomy: 'eligible', autonomyWord: 'Eligible', why: '' }) as CapacityRow['reserve'];

  it('keeps the reserve and the time gone of the binding window from a current reading', () => {
    const [row] = barRows([rowOf({ reserve: reserve(40) })], { healthRead: true, now: NOW });
    expect(row!.window).toEqual({ kept: 40, elapsed: 71.4, pace: '71% of the window gone · use is 9 points behind an even spend' });
    expect(row!.detail).toContain('Weekly window: 71% of the window gone · use is 9 points behind an even spend');
  });

  it('carries no window facts when neither a reserve nor a start is known, and no reserve when autonomy is off or it is zero', () => {
    const noStart = rowOf();
    const [plain] = barRows([{ ...noStart, windows: noStart.windows.map(({ period: _period, ...w }) => w) }], { healthRead: true, now: NOW });
    expect(plain!.window).toBeUndefined();
    expect(plain!.detail.some(line => /of the window gone/.test(line))).toBe(false);
    for (const percent of [null, 0]) {
      const [row] = barRows([rowOf({ reserve: reserve(percent) })], { healthRead: true, now: NOW });
      expect(row!.window).toMatchObject({ kept: null, elapsed: 71.4 });
    }
  });

  it('reads no time against a reading that is no longer current', () => {
    const stale = buildCapacityRows([claudeSeat(3 * DAY)], { now: NOW })[0]!;
    const [row] = barRows([{ ...stale, reserve: null }], { healthRead: true, now: NOW, maxAgeMs: 60_000 });
    expect(row!.window?.elapsed ?? null).toBeNull();
    expect(row!.detail.some(line => /of the window gone/.test(line))).toBe(false);
  });
});
