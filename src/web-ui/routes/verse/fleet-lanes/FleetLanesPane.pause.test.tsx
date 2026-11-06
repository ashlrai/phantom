import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { clearMutationToken, setMutationToken } from '../../../data/auth-store.js';
import { evictAll } from '../../../data/cache.js';
import { fleetRunsFixture, withLane } from '../fleet/fleet-runs-fixtures.test-support.js';
import { FleetLanesPane } from './FleetLanesPane.js';
import { LANE_PAUSE_KEY } from './lane-pause-model.js';

const lane = 'codex-personal';
const targetRow = { lane, target: 24, floor: 0, ceiling: 30, held: false, heldReason: null, heldUntil: null, lastChange: null, changedBy: null };
const json = (value: unknown, status = 200) => Response.json(value, { status });
function setup(failure?: { status: number; body: object }, initial = targetRow) {
  let targets = { v: 1, generatedAt: '2026-10-31T12:00:00Z', sourceState: 'healthy', lanes: [initial] };
  let runs = withLane(fleetRunsFixture({ claudeLane: null }), { lane, target: initial.target });
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST') {
      if (failure) return json(failure.body, failure.status);
      const body = JSON.parse(String(init.body)) as { target: number };
      targets = { ...targets, lanes: [{ ...targets.lanes[0], target: body.target }] };
      runs = withLane(runs, { lane, target: body.target });
      return json(targets);
    }
    return json(url.endsWith('/control/lanes') ? targets : runs);
  });
  vi.stubGlobal('fetch', fetcher);
  render(<FleetLanesPane visible />);
  return fetcher;
}
function postBodies(fetcher: ReturnType<typeof setup>) {
  return fetcher.mock.calls.filter(([, init]) => init?.method === 'POST').map(([, init]) => JSON.parse(String(init?.body)));
}

beforeEach(() => { evictAll(); localStorage.clear(); setMutationToken('a'.repeat(64)); });
afterEach(() => { clearMutationToken(); vi.unstubAllGlobals(); });

it('pauses and resumes the remembered target', async () => {
  const fetcher = setup();
  const pause = await screen.findByRole('button', { name: `Pause ${lane}` });
  await vi.waitFor(() => expect(pause).toBeEnabled());
  fireEvent.click(pause);
  expect(await screen.findByText('Paused · was 24')).toBeInTheDocument();
  const resume = screen.getByRole('button', { name: `Resume ${lane}` });
  await vi.waitFor(() => expect(resume).toBeEnabled());
  fireEvent.click(resume);
  await vi.waitFor(() => expect(postBodies(fetcher)).toEqual([{ lane, target: 0 }, { lane, target: 24 }]));
  await vi.waitFor(() => expect(screen.queryByText('Paused · was 24')).not.toBeInTheDocument());
  expect(JSON.parse(localStorage.getItem(LANE_PAUSE_KEY)!)).toEqual({});
}, 15_000);

it.each([
  [409, { error: 'Busy now' }, 'Busy now'],
  [400, { error: 'Cannot pause' }, 'Cannot pause'],
  [422, { code: 'out-of-range', error: 'Target is outside lane bounds' }, 'Floor is 2; set the target instead.'],
])('shows a %i refusal without remembering a pause', async (status, body, message) => {
  setup({ status, body }, { ...targetRow, floor: 2 });
  const pause = await screen.findByRole('button', { name: `Pause ${lane}` });
  await vi.waitFor(() => expect(pause).toBeEnabled());
  fireEvent.click(pause);
  const row = screen.getByText(lane, { selector: 'strong' }).closest('li')!;
  expect(await within(row).findByRole('status')).toHaveTextContent(message);
  expect(within(row).queryByText(/Paused · was/)).toBeNull();
  expect(JSON.parse(localStorage.getItem(LANE_PAUSE_KEY)!)).toEqual({});
});

it('resumes an already-zero lane without saved memory at its floor', async () => {
  const fetcher = setup(undefined, { ...targetRow, target: 0, floor: 2 });
  const resume = await screen.findByRole('button', { name: `Resume ${lane}` });
  await vi.waitFor(() => expect(resume).toBeEnabled());
  fireEvent.click(resume);
  await vi.waitFor(() => expect(postBodies(fetcher)).toEqual([{ lane, target: 2 }]));
});
