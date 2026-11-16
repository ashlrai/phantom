import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { UpdateNowButton } from './UpdateNowButton.js';
import { clearMutationToken, setMutationToken } from '../../../data/auth-store.js';
import { evictAll } from '../../../data/cache.js';
import type { UpdateServerStatus } from './update-status-queries.js';

const show = vi.hoisted(() => vi.fn());
vi.mock('../../../components/primitives/Toast.js', () => ({ useToast: () => ({ show }) }));

const UPDATE_AVAILABLE: UpdateServerStatus = {
  v: 1, sourceState: 'healthy', installedVersion: null, headSha: null, headAt: null,
  originSha: null, branch: 'master', behind: 3, ahead: 0, dirty: false,
  lastFetchAt: null, processStartedAt: null, uptimeSeconds: null, canFastForward: true,
};

const SELF_UPDATE_PATH = '/api/verse/ops/self-update';
const FLEET_LIVE_PATH = '/api/verse/fleet/live';

/** The smallest FleetLiveSnapshotV1 that narrow.fleetLive accepts. */
function fleetLiveBody(building: number | null) {
  return {
    v: 1, generatedAt: '2026-11-10T00:00:00.000Z', state: 'running', stateReason: null, lastActivityAt: null,
    summary: {
      building, queued: 0, parked: 0, waitingVerify: 0, mergedToday: 0, revertsToday: 0,
      merged7d: 0, postMergeGreenPct7d: null, cycleTimeP50Ms7d: null,
    },
    lanes: [], runs: [], funnel: null, repos: [],
  };
}

const urlOf = (input: RequestInfo | URL): string =>
  typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;

/**
 * fetch stub: answers the fleet-live read the keep-note consumes and the
 * self-update POST the button issues; anything else is a 404 so an
 * unexpected request cannot pass silently.
 */
function serve(building: number | null) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit): Promise<Response> => {
    const url = urlOf(input);
    if (url === FLEET_LIVE_PATH) return Response.json(fleetLiveBody(building));
    if (url === SELF_UPDATE_PATH) {
      return Response.json({ outcome: 'already-current', restart: { required: false, mode: 'manual' } });
    }
    return Response.json({ error: 'not found' }, { status: 404 });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

beforeEach(() => {
  evictAll();
  setMutationToken('fake-mutation-token');
  vi.spyOn(window, 'confirm').mockReturnValue(true);
});
afterEach(() => {
  clearMutationToken();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it('names the running fleet jobs that keep running during the update', async () => {
  const fetchMock = serve(3);
  render(<UpdateNowButton status={UPDATE_AVAILABLE} onDone={vi.fn()} />);
  expect(await screen.findByText('3 fleet jobs keep running during the update')).toBeInTheDocument();
  expect(fetchMock).toHaveBeenCalledWith(FLEET_LIVE_PATH, expect.objectContaining({ method: 'GET' }));
});

it('says "Fleet jobs keep running" without a number when the count is unknown', async () => {
  serve(null);
  render(<UpdateNowButton status={UPDATE_AVAILABLE} onDone={vi.fn()} />);
  const note = await screen.findByText('Fleet jobs keep running');
  expect(note).toHaveTextContent(/^Fleet jobs keep running$/);
  expect(screen.queryByText(/\d+ fleet jobs?/)).toBeNull();
});

it('keeps the no-number note when the fleet read itself is unavailable', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error: 'not found' }, { status: 404 })));
  render(<UpdateNowButton status={UPDATE_AVAILABLE} onDone={vi.fn()} />);
  expect(await screen.findByText('Fleet jobs keep running')).toBeInTheDocument();
});

it('clicking update requests only the self-update route — never a fleet stop, pause or drain', async () => {
  const fetchMock = serve(2);
  render(<UpdateNowButton status={UPDATE_AVAILABLE} onDone={vi.fn()} />);
  await screen.findByText('2 fleet jobs keep running during the update');
  const readsBeforeClick = fetchMock.mock.calls.length;
  await userEvent.click(screen.getByRole('button', { name: 'Update now' }));
  await waitFor(() => {
    expect(fetchMock.mock.calls.slice(readsBeforeClick).map(([input]) => urlOf(input))).toContain(SELF_UPDATE_PATH);
  });
  const afterClick = fetchMock.mock.calls.slice(readsBeforeClick);
  // Every request the click issues, in full: the self-update POST and nothing
  // else — in particular none of the fleet control, authority, daemon or
  // stray-stop routes that could stop, pause or drain running jobs.
  expect(afterClick.map(([input]) => urlOf(input))).toEqual([SELF_UPDATE_PATH]);
  expect(afterClick[0]?.[1]?.method).toBe('POST');
  expect(afterClick.some(([input]) => /stop|pause|drain/i.test(urlOf(input)))).toBe(false);
});
