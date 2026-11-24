/**
 * dock/ResourceBoardsNav.throughput.test.tsx — Throughput on the row of resource boards: last in the row under its
 * own divider, reachable with the row's keys, and carrying PRs merged in the last 24 hours (or a red main) from the
 * `phm throughput` report its board draws. An unread metrics file is unknown: the name stands alone, never "0 merged".
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ThroughputCounts, ThroughputReport } from '../../../../core/fleet/throughput.js';
import { evictAll } from '../../../data/cache.js';
import { registerPane, resetPaneRegistry } from '../panes/pane-registry.js';
import { ResourceBoardsNav } from './ResourceBoardsNav.js';
import { TasksGlyph } from './dock-icons.js';
import { getDockState, openDockPane, resetDockStore } from './dock-store.js';
import { throughputReading } from './resource-board-readings.js';
import { isResourceBoard, resourceBoards } from './resource-boards.js';

const NONE: ThroughputCounts = { launched: null, published: null, merged: null, finished: null, empty: null, empty_rate: null, median_publish_to_merge_s: null, merge_time_unknown: null };
const counted = (merged: number): ThroughputCounts => ({ launched: merged + 3, published: merged + 1, merged, finished: merged + 2, empty: 1, empty_rate: 0.1, median_publish_to_merge_s: merged ? 170 : null, merge_time_unknown: 0 });
const report = (extra: Partial<ThroughputReport> = {}): ThroughputReport => ({
  schema: 'throughput.v1', as_of: '2026-11-17T12:00:00.000Z', since: '2026-11-16T12:00:00.000Z', hours: 24, by: 'lane',
  metrics_path: '/fleet/jobs.jsonl', metrics: 'ok', malformed_lines: 0, main: 'green',
  headline: '42 merged in the last 24 hours, median 2m 50s', totals: counted(42), buckets: [], groups: [], ...extra,
});
const UNREADABLE = report({ metrics: 'unreadable', malformed_lines: null, totals: NONE, headline: 'Merged in the last 24 hours: unknown (cannot read the job metrics file)' });

let disposers: Array<() => void> = [];
function register(...entries: readonly string[]) {
  disposers.push(...entries.map((item) => {
    const [id, title] = item.split(':') as [string, string];
    return registerPane({ id, title, icon: TasksGlyph, component: () => null, needsSession: false });
  }));
}
/** Answers the throughput route with `body` (a failure when undefined); every other route is a server that is down. */
function serve(body: unknown) {
  const fetchMock = vi.fn(async (input: string) => String(input).includes('/api/verse/fleet/runs/throughput') && body !== undefined
    ? Response.json(body) : Response.json({ error: 'down' }, { status: 500 }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}
const asked = (fetchMock: { mock: { calls: unknown[][] } }): string[] => fetchMock.mock.calls.map(([url]) => String(url));
const button = (name: string | RegExp) => within(screen.getByRole('navigation', { name: 'Resource boards' })).getByRole('button', { name });

beforeEach(() => {
  evictAll();
  resetDockStore();
  resetPaneRegistry();
  disposers = [];
});
afterEach(() => {
  cleanup();
  for (const dispose of disposers) dispose();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('throughputReading', () => {
  it('gives PRs merged over the window, with the report headline as the detail', () => {
    expect(throughputReading(report())).toEqual({ text: '42 merged', tone: 'quiet', detail: '42 merged in the last 24 hours, median 2m 50s.' });
  });

  it('shows a measured zero, and nothing when the metrics file could not be read', () => {
    expect(throughputReading(report({ totals: counted(0), headline: '0 merged in the last 24 hours, median unknown' }))?.text).toBe('0 merged');
    expect(throughputReading(UNREADABLE)).toBeNull();
    // Counts beside an unreadable file are not vouched for.
    expect(throughputReading(report({ metrics: 'unreadable' }))).toBeNull();
  });

  it('puts a red main first, and treats an unknown main as no word about main', () => {
    expect(throughputReading(report({ main: 'red' }))).toEqual({ text: 'main red', tone: 'attention', detail: 'Main is red. 42 merged in the last 24 hours, median 2m 50s.' });
    expect(throughputReading({ ...UNREADABLE, main: 'red' })?.text).toBe('main red');
    expect(throughputReading(report({ main: 'unknown' }))?.text).toBe('42 merged');
  });
});

describe('Throughput on the row of resource boards', () => {
  it('is a resource board, last in the row, opening a group of its own', () => {
    expect(isResourceBoard('fleet-throughput')).toBe(true);
    const titles: Record<string, string> = { 'fleet-pools': 'Pools', 'fleet-supply': 'Supply', 'fleet-throughput': 'Throughput' };
    const boards = resourceBoards((id) => (titles[id] ? { title: titles[id]!, description: null } : null));
    expect(boards.map((board) => [board.title, board.group, board.startsGroup])).toEqual([['Pools', 'have', false], ['Supply', 'run', true], ['Throughput', 'out', true]]);
  });

  it('draws the merged count beside the name from the board\'s own 24 hour read, asked once', async () => {
    register('fleet-pools:Pools', 'fleet-throughput:Throughput');
    const fetchMock = serve(report());
    render(<ResourceBoardsNav current="fleet-pools" visible primary />);
    const throughput = await waitFor(() => button('Throughput 42 merged'));
    expect(within(throughput).getByText('42 merged')).toHaveAttribute('data-tone', 'quiet');
    expect(throughput.title).toMatch(/^42 merged in the last 24 hours, median 2m 50s\. What came out/);
    expect(throughput.closest('li')).toHaveAttribute('data-group-start');
    expect(asked(fetchMock).filter(url => url.includes('/throughput'))).toEqual(['/api/verse/fleet/runs/throughput?hours=24&by=lane']);
  });

  it('marks a red main in the attention tone', async () => {
    register('fleet-pools:Pools', 'fleet-throughput:Throughput');
    serve(report({ main: 'red' }));
    render(<ResourceBoardsNav current="fleet-pools" visible primary />);
    expect(within(await waitFor(() => button('Throughput main red'))).getByText('main red')).toHaveAttribute('data-tone', 'attention');
  });

  it.each([
    ['the metrics file could not be read', UNREADABLE],
    ['the server answered another shape', { error: 'unsupported' }],
    ['the read failed', undefined],
  ])('keeps a plain name when %s', async (_why, body) => {
    register('fleet-pools:Pools', 'fleet-throughput:Throughput');
    const fetchMock = serve(body);
    render(<ResourceBoardsNav current="fleet-pools" visible primary />);
    await waitFor(() => expect(asked(fetchMock).some(url => url.includes('/throughput'))).toBe(true));
    await Promise.resolve();
    await waitFor(() => expect(button(/^Throughput/)).toHaveTextContent(/^Throughput$/));
  });

  it('is not asked for by a row that does not list it', async () => {
    register('fleet-pools:Pools', 'fleet-usage:Usage');
    const fetchMock = serve(report());
    render(<ResourceBoardsNav current="fleet-pools" visible primary />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(asked(fetchMock).filter(url => url.includes('/throughput'))).toEqual([]);
  });

  it('is one End key away, and End puts it in the tab of the board on screen', async () => {
    register('fleet-pools:Pools', 'fleet-usage:Usage', 'fleet-throughput:Throughput');
    serve(report());
    act(() => { openDockPane('fleet-pools'); });
    render(<ResourceBoardsNav current="fleet-pools" visible primary />);
    act(() => { fireEvent.keyDown(button(/^Pools/), { key: 'End' }); });
    expect(getDockState().tabs).toEqual(['fleet-throughput']);
    expect(getDockState().active).toBe('fleet-throughput');
  });
});
