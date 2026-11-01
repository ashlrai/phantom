import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { markCheckComplete } from '../../../data/auth-store.js';
import * as cache from '../../../data/cache.js';
import { VerseControlLockedError } from '../autonomy/control-queries.js';
import { MockEventSource } from '../fixtures.test-support.js';
import { fleetRunsFixture } from '../fleet/fleet-runs-fixtures.test-support.js';
import { postReleaseHold } from '../fleet-lanes/lane-hold-release.js';
import { laneWriting } from '../fleet-lanes/LaneTargetStepper.js';
import { laneTargetsQuery } from '../ops/lane-targets-queries.js';
import { opsRunsQuery } from '../ops/ops-runs-queries.js';
import { useVerseUi } from '../useVerseUi.js';
import { openVerseOverlay, resetVerseUi } from '../verse-ui-store.js';
import { CommandPalette } from './CommandPalette.js';
import { paletteLanes, releaseItemTitle } from './palette-lanes.js';
import { buildPaletteItems, paletteView } from './palette-model.js';
import { setShellNotifier } from './run-command.js';
import { activity, shellFetch } from './shell-fixtures.test-support.js';
import { resetActivityForTest } from './useActivity.js';

vi.mock('../voice/VoiceInput.js', () => ({ default: () => null }));
vi.mock('../fleet-lanes/lane-hold-release.js', () => ({ postReleaseHold: vi.fn() }));

function heldRuns() {
  const runs = fleetRunsFixture();
  runs.lanes[0] = { ...runs.lanes[0]!, held: true, heldReason: 'usage_limit' };
  return { ...runs, claudeLane: null };
}

function Harness() {
  const ui = useVerseUi();
  return ui.overlay === 'palette' ? <CommandPalette /> : null;
}

const notify = vi.fn();
beforeEach(() => {
  localStorage.clear(); cache.evictAll(); resetVerseUi();
  setShellNotifier(notify); notify.mockClear();
  const net = shellFetch(activity());
  vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) =>
    String(input).startsWith('/api/verse/fleet/runs')
      ? Promise.resolve(new Response(JSON.stringify(heldRuns())))
      : net.fetch(input, init)));
  resetActivityForTest(path => net.fetch(path).then((r: Response) => r.json()));
  MockEventSource.reset(); vi.stubGlobal('EventSource', MockEventSource); markCheckComplete(true);
});
afterEach(async () => {
  await waitFor(() => expect(laneWriting()).toBe(false));
  act(() => markCheckComplete(false)); setShellNotifier(null);
  resetActivityForTest(); vi.unstubAllGlobals();
});

async function activateRelease() {
  const user = userEvent.setup({ delay: null });
  render(<Harness />);
  act(() => openVerseOverlay('palette'));
  await user.type(await screen.findByRole('combobox', { name: 'Search commands' }), 'release');
  const option = await screen.findByRole('option', { name: 'Release hold on codex-personal · usage_limit' });
  await waitFor(() => expect(option).toHaveAttribute('aria-selected', 'true'));
  const refetch = vi.spyOn(cache, 'refetchQuery').mockResolvedValue();
  await user.keyboard('{Enter}');
  expect(screen.queryByRole('dialog', { name: 'Command palette' })).not.toBeInTheDocument();
  return refetch;
}

it('offers and matches one release action only for a held lane', () => {
  const lanes = paletteLanes(heldRuns(), {});
  const items = buildPaletteItems({ lanes, needsYou: [], running: [], sessions: [], seats: [], projects: [], recentActions: [], platform: 'mac' });
  const releases = items.filter(item => item.payload.kind === 'lane-release');
  expect(releases).toHaveLength(1);
  expect(releases[0]).toMatchObject({ key: 'lane-release:codex-personal', group: 'lanes', title: 'Release hold on codex-personal · usage_limit' });
  expect(items.filter(item => item.payload.kind === 'lane')).toHaveLength(2);
  const view = paletteView(items, 'release', [], 'mac');
  expect(view.flat[view.best]).toEqual(releases[0]);
  const emptyReason = { ...heldRuns(), lanes: [{ ...heldRuns().lanes[0]!, heldReason: '' }] };
  expect(paletteLanes(emptyReason, {})[0]?.heldReason).toBeNull();
  expect(releaseItemTitle(paletteLanes(emptyReason, {})[0]!)).toBe('Release hold on codex-personal · held');
});

it('releases the selected lane and refreshes both snapshots', async () => {
  vi.mocked(postReleaseHold).mockResolvedValue({
    v: 1, generatedAt: '', sourceState: 'healthy', lanes: [{
      lane: 'codex-personal', target: 4, floor: 0, ceiling: 10, held: false,
      heldReason: null, heldUntil: null, lastChange: null, changedBy: null,
    }],
  });
  const refetch = await activateRelease();
  await waitFor(() => expect(notify).toHaveBeenCalledWith('Released codex-personal.', 'success'));
  expect(postReleaseHold).toHaveBeenCalledExactlyOnceWith('codex-personal', 'Phantom palette');
  expect(refetch.mock.calls.map(call => call[0])).toEqual([laneTargetsQuery.key, opsRunsQuery.key]);
});

it('reports a locked control without refreshing', async () => {
  const error = new VerseControlLockedError();
  vi.mocked(postReleaseHold).mockRejectedValue(error);
  const refetch = await activateRelease();
  await waitFor(() => expect(notify).toHaveBeenCalledWith(error.message, 'danger'));
  expect(postReleaseHold).toHaveBeenCalledExactlyOnceWith('codex-personal', 'Phantom palette');
  expect(refetch).not.toHaveBeenCalled();
});

it.each([
  [{}, 'The server returned an invalid lane response.'],
  [{ v: 1, generatedAt: '', sourceState: 'healthy', lanes: [] }, 'The server did not confirm the lane release.'],
  [{ v: 1, generatedAt: '', sourceState: 'healthy', lanes: [{ lane: 'codex-personal', target: 4, floor: 0, ceiling: 10, held: true, heldReason: 'usage_limit', heldUntil: null, lastChange: null, changedBy: null }] }, 'The server did not confirm the lane release.'],
])('rejects an unconfirmed release response', async (response, message) => {
  vi.mocked(postReleaseHold).mockResolvedValue(response);
  const refetch = await activateRelease();
  await waitFor(() => expect(notify).toHaveBeenCalledWith(message, 'danger'));
  expect(refetch).not.toHaveBeenCalled();
});
