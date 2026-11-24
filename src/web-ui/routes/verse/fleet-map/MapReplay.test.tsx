import { useState } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { buildFleetLiveMap, type FleetLiveMap } from '../../../../core/fleet/live-map.js';
import { fleetOrgMap } from '../../../../core/fleet/org-map.js';
import { fleetOrgTree } from '../../../../core/fleet/org-tree.js';
import { buildMapReplay } from '../../../../core/fleet/map-replay-build.js';
import type { MapReplay } from '../../../../core/fleet/map-replay.js';
import type { WorklogEntry } from '../../../../core/fleet/worklog.js';
import type { FleetSessionsV1 } from '../../../../core/fleet/runs-sessions.js';
import { evictAll } from '../../../data/cache.js';
import { MapPane } from './MapPane.js';
import { narrowMapReplay } from './map-model.js';
import { frameSummary, ReplayBar, REPLAY_PLAY_MS } from './ReplayBar.js';
import './fleet-map.pane.js';

const T = (hh: number, mm: number) => Date.UTC(2026, 10, 18, hh, mm, 0);
const NOW = T(12, 0), AT = new Date(NOW).toISOString();
const entry = (job: string, kind: WorklogEntry['kind'], at: number): WorklogEntry => ({ job, repo: 'phantom', lane: 'claude', model: null, kind, at: new Date(at).toISOString(),
  mergedAt: null, openToMergeSeconds: null, url: null, goal: null, detail: null });
const talk = { cursor: 1, receivedAt: T(11, 32), envelope: { id: 'm1', from: 'claude', to: 'RQ-BBB', priority: 'P2' as const, ttl: 3_600_000, body: { text: 'start the work' } } };

/** Live: one job, RQ-A. Replay: RQ-BBB runs from 11:05 and gets a message at 11:32. */
function live(): FleetLiveMap {
  const map = fleetOrgMap(null, { now: NOW, minutes: 15, sessions: { generatedAt: AT, sourceState: 'healthy', truncated: false, recent: [], sessions: [
    { job: 'RQ-A', lane: 'claude', repo: 'phantom', model: 'fixture-model', status: 'running', elapsedSeconds: 60, startedAt: '2026-11-18T11:59:00Z', live: 'yes' }] } as unknown as FleetSessionsV1 });
  return buildFleetLiveMap({ now: NOW, org: { ...map, tree: fleetOrgTree(map) } });
}
const replayOf = (entries: WorklogEntry[] | null, source: 'available' | 'unavailable' = 'available'): MapReplay =>
  JSON.parse(JSON.stringify(buildMapReplay({ entries, bus: { source, rows: source === 'available' ? [talk] : [], skipped: 0 }, since: T(11, 0), now: NOW, stepMs: 900_000 })));

function serve(replay: MapReplay | null) {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    return Response.json(url.includes('/map-replay') ? replay ?? { schema: 'other' } : url.includes('/live-map') ? live() : { schema: 'other' });
  }));
}
beforeEach(() => evictAll());
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); });

const slider = () => screen.findByRole('slider', { name: 'Replay time' }) as Promise<HTMLInputElement>;
const job = (name: string) => screen.queryByRole('button', { name: new RegExp(`^Open job ${name}:`) });

it('scrubbing draws that moment instead of live state, and Back to live returns', async () => {
  serve(replayOf([entry('RQ-BBB', 'launch', T(11, 5))]));
  const { container } = render(<MapPane visible host={{ openPane: vi.fn() } as never} />);
  const bar = await slider();
  // Live by default: the slider is at the far right, and there is no Back to live button.
  expect(bar.value).toBe('4');
  expect(bar.getAttribute('aria-valuetext')).toBe('Now (live)');
  expect(screen.queryByRole('button', { name: 'Back to live' })).toBeNull();
  expect(await screen.findByRole('button', { name: /^Open job RQ-A:/ })).toBeTruthy();
  fireEvent.change(bar, { target: { value: '2' } });
  expect(bar.getAttribute('aria-valuetext')).toBe('11:45 UTC, 1 jobs running');
  expect(job('RQ-A')).toBeNull();
  expect(job('RQ-BBB')).toBeTruthy();
  expect(screen.getByText(/Showing 11:45 UTC: 1 running, 0 launched, 0 PRs opened, 0 merged, 1 message line\./)).toBeTruthy();
  expect(container.querySelectorAll('path[data-pulse="true"]')).toHaveLength(0);
  fireEvent.click(screen.getByRole('button', { name: 'Back to live' }));
  expect(bar.value).toBe('4');
  expect(screen.queryByRole('button', { name: 'Back to live' })).toBeNull();
  expect(job('RQ-A')).toBeTruthy();
  expect(job('RQ-BBB')).toBeNull();
});

it('draws the message line in its own frame', async () => {
  serve(replayOf([entry('RQ-BBB', 'launch', T(11, 5))]));
  const { container } = render(<MapPane visible host={{ openPane: vi.fn() } as never} />);
  const bar = await slider();
  // The 11:32 message is in the 11:45 frame (11:30 to 11:45).
  fireEvent.change(bar, { target: { value: '2' } });
  expect(screen.getByText(/1 message line/)).toBeTruthy();
  expect(container.querySelectorAll('path[data-kind="messaged-in-last-15-min"]')).toHaveLength(1);
});

it('a time nobody recorded is a gap in the slider, not an empty fleet', async () => {
  serve(replayOf(null, 'unavailable'));
  render(<MapPane visible host={{ openPane: vi.fn() } as never} />);
  const bar = await slider();
  const cells = screen.getAllByRole('listitem').filter(item => item.hasAttribute('data-state'));
  expect(cells.map(cell => cell.getAttribute('data-state'))).toEqual(['unknown', 'unknown', 'unknown', 'unknown']);
  fireEvent.change(bar, { target: { value: '1' } });
  expect(bar.getAttribute('aria-valuetext')).toBe('11:30 UTC, history unknown');
  expect(screen.getByText(/history unknown, nothing was recorded for this time/)).toBeTruthy();
  expect(screen.queryByText(/Nothing to map yet/)).toBeNull();
  expect(job('RQ-A')).toBeNull();
  expect(screen.getByRole('list', { name: 'Unknown' }).textContent).toContain('Jobs unknown: nothing recorded for this time.');
});

it('shows no slider when the replay is unavailable', async () => {
  serve(null);
  render(<MapPane visible host={{ openPane: vi.fn() } as never} />);
  expect(await screen.findByRole('button', { name: /^Open job RQ-A:/ })).toBeTruthy();
  expect(screen.queryByRole('slider')).toBeNull();
  expect(narrowMapReplay({ schema: 'other' })).toBeNull();
});

it('narrows a replay read: bad frames dropped, unknown parts stay null', () => {
  const raw = JSON.parse(JSON.stringify(replayOf(null, 'unavailable')));
  raw.frames.push({ at: 'never' }, 7);
  const replay = narrowMapReplay(raw)!;
  expect(replay.frames).toHaveLength(4);
  expect(replay.frames[0]).toMatchObject({ state: 'unknown', running: null, messages: null });
  expect(frameSummary(replay.frames[0]!)).toBe('11:15 UTC: history unknown, nothing was recorded for this time.');
});

it('Play steps through the frames and ends on live; Pause stops', () => {
  vi.useFakeTimers();
  const replay = narrowMapReplay(replayOf([entry('RQ-BBB', 'launch', T(11, 5))]))!;
  function Harness() {
    const [index, setIndex] = useState<number | null>(null), [playing, setPlaying] = useState(false);
    return <ReplayBar replay={replay} index={index} playing={playing} onIndex={setIndex} onPlaying={setPlaying} />;
  }
  render(<Harness />);
  const bar = screen.getByRole('slider', { name: 'Replay time' }) as HTMLInputElement;
  fireEvent.click(screen.getByRole('button', { name: 'Play' }));
  expect(bar.value).toBe('0');
  act(() => { vi.advanceTimersByTime(REPLAY_PLAY_MS); });
  expect(bar.value).toBe('1');
  fireEvent.click(screen.getByRole('button', { name: 'Pause' }));
  act(() => { vi.advanceTimersByTime(REPLAY_PLAY_MS * 5); });
  expect(bar.value).toBe('1');
  fireEvent.click(screen.getByRole('button', { name: 'Play' }));
  for (let tick = 0; tick < 3; tick++) act(() => { vi.advanceTimersByTime(REPLAY_PLAY_MS); });
  expect(bar.value).toBe('4');
  expect(screen.queryByRole('button', { name: 'Back to live' })).toBeNull();
  expect(screen.getByRole('button', { name: 'Play' })).toBeTruthy();
});
