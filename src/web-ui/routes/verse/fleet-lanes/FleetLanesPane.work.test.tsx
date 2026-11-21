/** The Lanes board's work line: each lane's hours from the per-lane throughput report, and one bar of time held on every card. */
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { evictAll } from '../../../data/cache.js';
import { columnWhen, workBoard } from '../models/model-work-model.js';
import { WORK_NOW, workCounts, workGroup, workReport } from '../models/model-work.test-support.js';
import type { FleetRuns } from '../ops/ops-runs-model.js';
import { FleetLanesPane } from './FleetLanesPane.js';
import { laneReport } from './LaneWork.js';

const lane = (name: string, running: number, target: number): FleetRuns['lanes'][number] =>
  ({ lane: name, running, target, queued: 0, held: false, heldReason: null, tokensLastHour: null, merged24h: null, mergeRate24h: null });
const runs: FleetRuns = {
  v: 1, generatedAt: new Date(WORK_NOW).toISOString(), sources: { runsDir: 'healthy', workers: 'healthy', inbox: 'healthy', codex: 'healthy', merges: 'healthy' },
  lastTick: null, paused: null, memFreePct: null, diskFreeGb: null, switches: [], claudeLane: null,
  lanes: [lane('codex', 2, 3), lane('claude', 1, 1), lane('grok', 0, 0)],
  workers: [], leaders: [], orchestratorAgents: null, publishesLastHour: [], mergesLastHour: { count: 0, items: [] }, events: [], codexPersonal: null, inbox: [], drop: null,
};

const codex = workGroup('codex', { launched: 7, merged: 3, finished: 6, empty: 1 }, { 3: { launched: 2 }, 22: { launched: 4, merged: 1 }, 23: { launched: 1, merged: 2 } });
const claude = workGroup('claude', { launched: 1 }, { 23: { launched: 1 } });
// A lane the job record names that the board has no card for.
const devin = workGroup('devin', { launched: 2, merged: 1 }, { 22: { launched: 2, merged: 1 } });
const fleet = workGroup('fleet', {}, { 3: { launched: 2 }, 22: { launched: 6, merged: 2 }, 23: { launched: 2, merged: 2 } }).buckets;
const day = workReport([codex, claude, devin], { by: 'lane', buckets: fleet });
const week = workReport([workGroup('codex', { launched: 30, merged: 12, finished: 28, empty: 4 }, { 0: { launched: 21 }, 167: { launched: 9, merged: 12 } }, 168)], { by: 'lane', hours: 168 });
const TOTAL = 'Last 24 hours: 10 jobs launched, 4 PRs merged, 1 of 6 finished jobs empty, under 3 lane names.';

type Answer = unknown | (() => Response);
/** The runs snapshot, and the throughput read answered per window; every other read of the pane has not landed. */
function serve(work: Answer, weekly: Answer = week) {
  const answer = (body: Answer) => typeof body === 'function' ? (body as () => Response)() : Response.json(body);
  vi.stubGlobal('fetch', vi.fn(async (input: unknown) => {
    const url = String(input);
    if (url.includes('/fleet/runs/throughput')) return answer(url.includes('hours=168') ? weekly : work);
    if (/\/fleet\/runs(\?|$)/.test(url)) return Response.json(runs);
    return Response.json({}, { status: 404 });
  }));
}
const asked = () => vi.mocked(fetch).mock.calls.map(([url]) => String(url)).filter(url => url.includes('/runs/throughput'));

const card = (name: string) => screen.getAllByText(name, { selector: 'strong' }).map(el => el.closest<HTMLElement>('li[data-state]')).find(Boolean)!;
const line = (name: string) => card(name).querySelector<HTMLElement>('[data-work]')!;
const strip = (name: string) => line(name).querySelector<HTMLElement>('[data-work-strip]')!;
const column = (name: string, index: number) => strip(name).children[index] as HTMLElement;
const heldIn = (name: string) => [...strip(name).children].findIndex(child => child.hasAttribute('data-at'));
const when = (index: number) => columnWhen({ start: codex.buckets[index]!.start, hours: 1 });

async function board(work: Answer = day) {
  serve(work);
  render(<FleetLanesPane visible />);
  await screen.findByText('3 of 4 slots running.');
}

beforeEach(() => { evictAll(); });
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('Lanes board work line', () => {
  it('draws each lane\'s day from the per-lane report and says what it holds', async () => {
    await board();
    expect(await screen.findByText(TOTAL)).toBeInTheDocument();
    expect(asked()).toEqual([expect.stringContaining('/api/verse/fleet/runs/throughput?hours=24&by=lane')]);
    expect(line('codex')).toHaveAttribute('data-work', 'worked');
    expect(within(line('codex')).getByText('7 jobs launched, 3 PRs merged, 1 of 6 finished jobs empty')).toBeInTheDocument();
    expect(within(card('codex')).getByRole('slider', { name: 'codex jobs launched over the last 24 hours, a bar per hour: most in one bar 4' })).toBeInTheDocument();
    expect(strip('codex').children).toHaveLength(24);
    // Bars are drawn against the busiest bar on the board (codex, 4 in one hour), so cards compare.
    expect(column('codex', 22).querySelector('i')).toHaveStyle({ height: '100%' });
    expect(column('claude', 23).querySelector('i')).toHaveStyle({ height: '25%' });
    expect(column('codex', 22)).toHaveAttribute('data-merged');
    expect(column('claude', 23)).not.toHaveAttribute('data-merged');
    // A lane the report has no group for did nothing that was recorded: an empty line, not a hatched one.
    expect(line('grok')).toHaveAttribute('data-work', 'idle');
    expect(within(line('grok')).getByText('no work recorded in the last 24 hours')).toBeInTheDocument();
    expect(strip('grok')).toHaveAttribute('role', 'img');
    // The fleet's sentence counts devin, so the lane with no card is named.
    const strangers = screen.getByRole('list', { name: 'Recorded under a lane with no card' });
    expect(within(strangers).getAllByRole('listitem').map(li => li.textContent)).toEqual(['devin2 jobs launched, 1 PR merged, none finished, and no card on this board']);
    expect(screen.getByText('phm throughput --by lane')).toBeInTheDocument();
  });

  it('holds one hour on every lane card, by pointer or from the keyboard', async () => {
    await board();
    await screen.findByText(TOTAL);
    fireEvent.mouseEnter(column('codex', 22));
    expect(heldIn('codex')).toBe(22);
    expect(heldIn('claude')).toBe(22);
    expect(within(line('codex')).getByText(`${when(22)}: 4 jobs launched, 1 PR merged`)).toBeInTheDocument();
    expect(within(line('claude')).getByText(`${when(22)}: 0 jobs launched, 0 PRs merged`)).toBeInTheDocument();
    // Above the cards: the report's own hour for the whole fleet, which holds devin's work too.
    expect(screen.getByText(`${when(22)}: 6 jobs launched, 2 PRs merged across the fleet.`)).toBeInTheDocument();
    expect(screen.queryByText(TOTAL)).toBeNull();
    fireEvent.mouseLeave(strip('codex'));
    expect(heldIn('claude')).toBe(-1);
    expect(screen.getByText(TOTAL)).toBeInTheDocument();

    act(() => { strip('claude').focus(); });
    expect(heldIn('codex')).toBe(23);
    fireEvent.keyDown(strip('claude'), { key: 'ArrowLeft' });
    expect(heldIn('codex')).toBe(22);
    expect(strip('claude')).toHaveAttribute('aria-valuetext', `${when(22)}: 0 jobs launched, 0 PRs merged`);
    fireEvent.keyDown(strip('claude'), { key: 'Home' });
    expect(heldIn('codex')).toBe(0);
    fireEvent.keyDown(strip('claude'), { key: 'Escape' });
    expect(heldIn('codex')).toBe(-1);
    expect(heldIn('claude')).toBe(-1);
  });

  it('switches to 7 days on its own read and lets go of the held hour', async () => {
    await board();
    await screen.findByText(TOTAL);
    fireEvent.mouseEnter(column('codex', 22));
    fireEvent.click(within(screen.getByRole('radiogroup', { name: 'Work window' })).getByRole('radio', { name: '7 days' }));
    expect(await screen.findByText('Last 7 days: 30 jobs launched, 12 PRs merged, 4 of 28 finished jobs empty, under 1 lane name.')).toBeInTheDocument();
    expect(asked().at(-1)).toContain('hours=168&by=lane');
    expect(heldIn('codex')).toBe(-1);
    expect(within(card('codex')).getByRole('slider', { name: 'codex jobs launched over the last 7 days, a bar per 7 hours: most in one bar 21' })).toBeInTheDocument();
    expect(within(line('claude')).getByText('no work recorded in the last 7 days')).toBeInTheDocument();
  });

  it.each([
    ['an answer that is not a report', { lanes: [] }],
    ['a report grouped by something else', workReport([codex])],
    ['a failed read', () => Response.json({ error: 'down' }, { status: 500 })],
  ] as [string, Answer][])('leaves every lane unknown, never idle, on %s', async (_name, work) => {
    await board(work);
    expect(await screen.findByText('Work in the last 24 hours is unknown: the per-lane throughput report could not be read.')).toHaveAttribute('data-unknown');
    // The pane's one live region stays its own read and the result of an action on a lane.
    expect(screen.queryByRole('status')).toBeNull();
    for (const name of ['codex', 'claude', 'grok']) {
      expect(line(name)).toHaveAttribute('data-work', 'unread');
      expect(within(line(name)).getByText('work unknown')).toBeInTheDocument();
      expect(strip(name).children).toHaveLength(0);
    }
    expect(screen.queryByText('phm throughput --by lane')).toBeNull();
    // The slots and readings the runs snapshot holds still draw.
    expect(within(card('codex')).getByText('2/3 · 0 queued')).toBeInTheDocument();
  });

  it('says the metrics file could not be read when the report says so', async () => {
    await board(workReport([], { by: 'lane', metrics: 'unreadable', totals: workCounts({ launched: null, merged: null, finished: null, empty: null }) }));
    expect(await screen.findByText('Work in the last 24 hours is unknown: the job metrics file could not be read.')).toBeInTheDocument();
    expect(line('codex')).toHaveAttribute('data-work', 'unread');
  });

  it('keeps the last bars and says so when a refresh fails', async () => {
    vi.useFakeTimers({ now: WORK_NOW });
    let down = false;
    serve(() => down ? Response.json({ error: 'down' }, { status: 500 }) : Response.json(day));
    render(<FleetLanesPane visible />);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(screen.getByText(TOTAL)).toBeInTheDocument();
    expect(screen.queryByText(/The hourly record could not refresh/)).toBeNull();
    down = true;
    await act(async () => { await vi.advanceTimersByTimeAsync(61_000); });
    expect(screen.getByText(/^The hourly record could not refresh\. Showing the reading from /)).toHaveAttribute('data-stale');
    expect(line('codex')).toHaveAttribute('data-work', 'worked');
    expect(strip('codex').children).toHaveLength(24);
  });
});

describe('laneReport', () => {
  it('takes only a per-lane throughput.v1 report as a reading', () => {
    expect(laneReport(day)).toBe(day);
    expect(laneReport(workReport([codex]))).toBeNull();
    expect(laneReport({ schema: 'throughput.v1', by: 'lane' })).toBeNull();
    expect(laneReport(null)).toBeNull();
    expect(laneReport(undefined)).toBeNull();
  });
});

describe('workBoard by lane', () => {
  it('words the board for lanes and keeps the model wording as the default', () => {
    const lost = workGroup('unknown', { launched: 2, merged: 1 });
    const byLane = workBoard({ report: workReport([codex, lost], { by: 'lane' }), failed: false, hours: 24, ids: ['codex'], by: 'lane' });
    expect(byLane).toMatchObject({ by: 'lane', line: 'Last 24 hours: 9 jobs launched, 4 PRs merged, 1 of 6 finished jobs empty, under 1 lane name.',
      unnamed: 'No lane is named for 2 of 9 launches and 1 of 4 merged PRs, so no row counts them.' });
    expect(workBoard({ report: null, failed: true, hours: 24, ids: ['codex'], by: 'lane' }).line).toBe('Work in the last 24 hours is unknown: the per-lane throughput report could not be read.');
    expect(workBoard({ report: workReport([codex]), failed: false, hours: 24, ids: ['codex'] })).toMatchObject({ by: 'model', line: expect.stringContaining('under 1 model name.') });
  });
});
