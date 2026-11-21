import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { evictAll } from '../../../data/cache.js';
import { resetLaneFocus, takeRequestedLane } from '../fleet-lanes/lane-focus-request.js';
import type { PaneProps } from '../panes/pane-registry.js';
import { FleetMergesPane } from './FleetMergesPane.js';
import { LaneThroughput, laneThroughput, laneThroughputHeadline } from './LaneThroughput.js';
import type { Lane } from './fleet-merges-model.js';

const lanes: Lane[] = [
  { lane: 'claude', merged24h: 30, mergeRate24h: 62.5 },
  { lane: 'codex-cmp', merged24h: 10, mergeRate24h: null },
  { lane: 'idle', merged24h: 0, mergeRate24h: 0 },
  { lane: 'dark', merged24h: null, mergeRate24h: null },
];

beforeEach(() => { evictAll(); resetLaneFocus(); });
afterEach(() => { cleanup(); resetLaneFocus(); vi.unstubAllGlobals(); });

it('scales each bar against the busiest lane and leaves an unknown lane without a number', () => {
  const view = laneThroughput(lanes);
  expect(view.rows.map(row => row.fillPct)).toEqual([100, expect.closeTo(33.33, 1), 0, null]);
  expect(view.rows.map(row => row.sharePct)).toEqual([75, 25, 0, null]);
  expect(view).toMatchObject({ total: 40, known: 3, unknown: 1 });
});

it('says how much merged and how many lanes are unknown, never counting unknown as zero', () => {
  expect(laneThroughputHeadline(laneThroughput(lanes))).toBe('40 merged across 3 lanes · 1 lane unknown.');
  expect(laneThroughputHeadline(laneThroughput([lanes[0]!]))).toBe('30 merged across 1 lane.');
  expect(laneThroughputHeadline(laneThroughput([lanes[2]!, lanes[3]!]))).toBe('Nothing merged across 1 lane · 1 lane unknown.');
  expect(laneThroughputHeadline(laneThroughput([lanes[3]!]))).toBe('Merges unknown for every lane.');
  // No lane merged anything: no bar is drawn full, and no share is invented.
  expect(laneThroughput([lanes[2]!]).rows[0]).toMatchObject({ fillPct: 0, sharePct: null });
});

it('draws one labelled bar per lane with its count and merge rate in words', () => {
  render(<LaneThroughput lanes={lanes} onOpenLane={() => {}} />);
  expect(screen.getByText('40 merged across 3 lanes · 1 lane unknown.')).toBeInTheDocument();
  const rows = within(screen.getByRole('list', { name: 'Lane throughput' })).getAllByRole('listitem');
  expect(rows[0]).toHaveTextContent('claude 30 merged · 62.5% merge rate');
  expect(rows[1]).toHaveTextContent('codex-cmp 10 merged · merge rate unknown');
  expect(rows[2]).toHaveTextContent('idle 0 merged · —');
  expect(rows[3]).toHaveTextContent('dark merges unknown · merge rate unknown');
  expect(screen.getByRole('img', { name: 'claude: 30 merged in 24 hours, 75% of 40' }).firstElementChild).toHaveStyle({ width: '100%' });
  expect(screen.getByRole('img', { name: 'idle: 0 merged in 24 hours, 0% of 40' }).firstElementChild).toHaveStyle({ width: '0%' });
  // Unknown: a hatched track with no fill, so it cannot pass for a lane that merged nothing.
  const unknown = screen.getByRole('img', { name: 'dark: merges unknown' });
  expect(unknown).toHaveAttribute('data-unknown');
  expect(unknown).toBeEmptyDOMElement();
});

it('says so when no lane is reported', () => {
  render(<LaneThroughput lanes={[]} onOpenLane={() => {}} />);
  expect(screen.getByText('No lane throughput reported.')).toBeInTheDocument();
  expect(screen.queryByRole('list', { name: 'Lane throughput' })).not.toBeInTheDocument();
});

it('opens the selected lane in the Lanes pane', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({
    mergesLastHour: { count: 0, items: [] }, publishesLastHour: [],
    lanes: [{ lane: 'claude', merged24h: 3, mergeRate24h: 50 }], sources: { merges: 'healthy' },
  })));
  const host = { openPane: vi.fn() };
  render(<FleetMergesPane {...({ visible: true, host } as unknown as PaneProps)} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Open claude in Lanes' }));
  expect(host.openPane).toHaveBeenCalledWith('fleet-lanes');
  expect(takeRequestedLane()).toBe('claude');
});
