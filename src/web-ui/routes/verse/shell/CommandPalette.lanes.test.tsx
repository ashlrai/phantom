import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { clearMutationToken, markCheckComplete, setMutationToken } from '../../../data/auth-store.js';
import { evictAll } from '../../../data/cache.js';
import { MockEventSource } from '../fixtures.test-support.js';
import { fleetRunsFixture } from '../fleet/fleet-runs-fixtures.test-support.js';
import { laneWriting } from '../fleet-lanes/LaneTargetStepper.js';
import { LANE_PAUSE_KEY } from '../fleet-lanes/lane-pause-model.js';
import { useVerseUi } from '../useVerseUi.js';
import { openVerseOverlay, resetVerseUi } from '../verse-ui-store.js';
import { CommandPalette } from './CommandPalette.js';
import { setShellNotifier } from './run-command.js';
import { activity, shellFetch } from './shell-fixtures.test-support.js';
import { resetActivityForTest } from './useActivity.js';

vi.mock('../voice/VoiceInput.js', () => ({ default: () => null }));
function Harness() {
  const ui = useVerseUi();
  return ui.overlay === 'palette' ? <CommandPalette /> : null;
}
let snapshot = { ...fleetRunsFixture(), claudeLane: null };
let fail = false;
const posts: unknown[] = [];
const notify = vi.fn();
beforeEach(() => {
  localStorage.clear(); evictAll(); resetVerseUi(); clearMutationToken();
  setMutationToken('plainly-fake-palette-token');
  setShellNotifier(notify); notify.mockClear(); posts.length = 0; fail = false;
  snapshot = { ...fleetRunsFixture(), claudeLane: null };
  const net = shellFetch(activity());
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).endsWith('/control/lanes')) {
      if (init?.method === 'POST') {
        posts.push(JSON.parse(String(init.body)));
        if (fail) return new Response(JSON.stringify({ error: 'Fake busy response' }), { status: 409 });
      }
      return new Response(JSON.stringify({ v: 1, generatedAt: '', sourceState: 'healthy', lanes: [] }));
    }
    if (String(input).startsWith('/api/verse/fleet/runs')) return new Response(JSON.stringify(snapshot));
    return net.fetch(input, init);
  }));
  resetActivityForTest(path => net.fetch(path).then((r: Response) => r.json()));
  MockEventSource.reset(); vi.stubGlobal('EventSource', MockEventSource); markCheckComplete(true);
});
afterEach(async () => {
  await waitFor(() => expect(laneWriting()).toBe(false));
  act(() => markCheckComplete(false)); clearMutationToken(); setShellNotifier(null);
  resetActivityForTest(); vi.unstubAllGlobals();
});
async function pickLane() {
  const user = userEvent.setup({ delay: null });
  render(<Harness />);
  act(() => openVerseOverlay('palette'));
  await user.type(await screen.findByRole('combobox', { name: 'Search commands' }), 'lane');
  const option = await screen.findByRole('option', { name: /^Lane codex-personal:/ });
  await user.hover(option);
  await user.keyboard('{Enter}');
}
it('posts target zero from the keyboard and remembers the previous target', async () => {
  await pickLane();
  await waitFor(() => expect(notify).toHaveBeenCalledWith(expect.stringContaining('target 0 saved'), 'success'));
  expect(posts).toEqual([{ lane: 'codex-personal', target: 0 }]);
  expect(JSON.parse(localStorage.getItem(LANE_PAUSE_KEY)!)).toEqual({ 'codex-personal': 4 });
});
it('resumes a held lane to its remembered target without clearing the hold', async () => {
  snapshot.lanes[0] = { ...snapshot.lanes[0]!, target: 0, held: true };
  localStorage.setItem(LANE_PAUSE_KEY, JSON.stringify({ 'codex-personal': 24, other: 2 }));
  await pickLane();
  await waitFor(() => expect(notify).toHaveBeenCalledWith(expect.stringContaining('held, resume target only'), 'success'));
  expect(posts).toEqual([{ lane: 'codex-personal', target: 24 }]);
  expect(JSON.parse(localStorage.getItem(LANE_PAUSE_KEY)!)).toEqual({ other: 2 });
});
it('reports a failed write without changing the pause record', async () => {
  fail = true;
  await pickLane();
  await waitFor(() => expect(notify).toHaveBeenCalledWith(expect.any(String), 'danger'));
  expect(localStorage.getItem(LANE_PAUSE_KEY)).toBeNull();
});
it('preserves the mutation hold requirement', async () => {
  clearMutationToken();
  await pickLane();
  await waitFor(() => expect(notify).toHaveBeenCalledWith(expect.any(String), 'danger'));
  expect(posts).toEqual([]);
});
