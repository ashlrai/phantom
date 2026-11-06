import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { clearMutationToken, setMutationToken } from '../../../data/auth-store.js';
import { evictAll, refetchQuery } from '../../../data/cache.js';
import { fleetRunsFixture, withLane } from '../fleet/fleet-runs-fixtures.test-support.js';
import { laneTargetsQuery } from '../ops/lane-targets-queries.js';
import { FleetLanesPane } from './FleetLanesPane.js';
import { LaneHoldReleaseButton } from './LaneHoldReleaseButton.js';
import { setLaneWriting } from './LaneTargetStepper.js';
import { releaseLabel } from './lane-hold-release.js';

const lane = 'codex-personal';
const props = { lane, heldReason: 'autobackoff: usage', heldUntil: null };
const target = { lane, target: 2, floor: 0, ceiling: 10, held: true, heldReason: props.heldReason, heldUntil: null, lastChange: null, changedBy: null };
const targets = { v: 1, generatedAt: '2026-10-31T12:00:00Z', sourceState: 'healthy', lanes: [target] };
const runs = withLane(fleetRunsFixture({ claudeLane: null }), { lane, target: 2, held: true, heldReason: props.heldReason });

beforeEach(() => { evictAll(); clearMutationToken(); setLaneWriting(false); });
afterEach(() => { clearMutationToken(); vi.unstubAllGlobals(); setLaneWriting(false); });

it('renders manual holds as a disabled, muted span and no control without a reason', () => {
  const view = render(<LaneHoldReleaseButton {...props} heldReason="operator hold" />);
  expect(screen.getByText('Held by hand')).toHaveAttribute('aria-disabled', 'true');
  expect(screen.queryByRole('button')).toBeNull();
  view.rerender(<LaneHoldReleaseButton {...props} heldReason={null} />);
  expect(screen.queryByText('Held by hand')).toBeNull();
});

it('gates automatic releases on the mutation hold and shared write lock', () => {
  const view = render(<LaneHoldReleaseButton {...props} />);
  expect(screen.getByRole('button', { name: 'Release hold' })).toBeDisabled();
  view.unmount();
  setMutationToken('a'.repeat(64));
  setLaneWriting(true);
  const locked = render(<LaneHoldReleaseButton {...props} />);
  expect(screen.getByRole('button', { name: 'Release hold' })).toBeDisabled();
  locked.unmount();
  setLaneWriting(false);
  render(<LaneHoldReleaseButton {...props} />);
  expect(screen.getByRole('button', { name: 'Release hold' })).toBeEnabled();
});

it('shows the expiry from the shared target snapshot', async () => {
  setMutationToken('a'.repeat(64));
  const expiry = new Date(2099, 9, 31, 17, 5).toISOString();
  await refetchQuery(laneTargetsQuery.key, async () => ({ ...targets, lanes: [{ ...target, heldUntil: expiry }] }), true);
  render(<LaneHoldReleaseButton {...props} />);
  expect(screen.getByRole('button', { name: releaseLabel('autobackoff', expiry, Date.now()) })).toBeEnabled();
});

it('posts from the held lane row and refetches both snapshots', async () => {
  setMutationToken('a'.repeat(64));
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST') return Response.json({ ok: true });
    return Response.json(url.endsWith('/control/lanes') ? targets : runs);
  });
  vi.stubGlobal('fetch', fetcher);
  render(<FleetLanesPane visible />);
  const row = (await screen.findByText(lane, { selector: 'strong' })).closest('li')!;
  const release = within(row).getByRole('button', { name: 'Release hold' });
  expect(release).toBeEnabled();
  await vi.waitFor(() => expect(fetcher.mock.calls.filter(([url]) => url.endsWith('/control/lanes'))).toHaveLength(1));
  fireEvent.click(release);
  await vi.waitFor(() => expect(fetcher.mock.calls.filter(([url]) => url.endsWith('/fleet/runs'))).toHaveLength(2));
  await vi.waitFor(() => expect(fetcher.mock.calls.filter(([url]) => url.endsWith('/control/lanes'))).toHaveLength(2));
  const [url, init] = fetcher.mock.calls.find(([, request]) => request?.method === 'POST')!;
  expect(url).toBe('/api/verse/fleet/control/holds');
  expect(JSON.parse(String(init?.body))).toEqual({ lane, action: 'release', reason: 'reset detected' });
});

it('shows the update message when the server does not have the route', async () => {
  setMutationToken('a'.repeat(64));
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error: 'not found' }, { status: 404 })));
  render(<LaneHoldReleaseButton {...props} />);
  fireEvent.click(screen.getByRole('button', { name: 'Release hold' }));
  expect(await screen.findByRole('status')).toHaveTextContent('This Phantom server cannot release holds yet; update the app.');
});
