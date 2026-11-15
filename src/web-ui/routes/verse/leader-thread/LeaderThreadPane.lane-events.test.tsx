import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { evictAll, refetchQuery } from '../../../data/cache.js';
import { stubSurfaceFetch } from '../command/fetch-stub.test-support.js';
import { msg } from '../leader/thread-fixtures.test-support.js';
import { laneTargetsQuery } from '../ops/lane-targets-queries.js';
import { LeaderThreadPane } from './LeaderThreadPane.js';

const now = Date.now();
let held = false;
const laneRow = () => ({ lane: 'codex-personal', target: 3, floor: 0, ceiling: 8, held,
  heldReason: held ? 'usage_limit' : null, heldUntil: held ? '2026-11-07T20:16:00.000Z' : null,
  lastChange: null, changedBy: null });
const routes = {
  '/api/verse/leader/thread': { messages: [
    msg({ id: 'first', at: new Date(now - 30_000).toISOString(), text: 'First line' }),
  ] },
  '/api/verse/fleet/runs': { inbox: [] },
  '/api/verse/leader/directives': { directives: [] },
  '/api/verse/fleet/control/lanes': () => Response.json({ v: 1, generatedAt: new Date().toISOString(), sourceState: 'healthy', lanes: [laneRow()] }),
};

beforeEach(() => { held = false; evictAll(); localStorage.clear(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers(); });

const log = () => screen.getByRole('log', { name: 'Conversation with the Leader' });
const refetchTargets = () => act(async () => { await refetchQuery(laneTargetsQuery.key, () => laneTargetsQuery.fetch(), true); });

/** Render, let the lane-targets baseline land, then flip the stub. */
async function mount() {
  const net = stubSurfaceFetch({ routes });
  const view = render(<LeaderThreadPane visible />);
  await within(log()).findByText('First line');
  await waitFor(() => expect(net.fetchMock.mock.calls.some(([url]) => String(url) === '/api/verse/fleet/control/lanes')).toBe(true));
  await act(async () => {});
  return view;
}

it('shows a system line when a lane flips from running to held', async () => {
  await mount();
  expect(within(log()).queryByText(/codex-personal held/)).toBeNull();
  held = true;
  await refetchTargets();
  expect(await within(log()).findByText(/codex-personal held: usage_limit, until Nov 7 15:16/)).toBeInTheDocument();
});

it('keeps the held line once across a reload and later refreshes', async () => {
  const view = await mount();
  held = true;
  await refetchTargets();
  await within(log()).findByText(/codex-personal held: usage_limit/);
  view.unmount();
  render(<LeaderThreadPane visible />);
  expect(await within(log()).findAllByText(/codex-personal held: usage_limit/)).toHaveLength(1);
  await refetchTargets();
  expect(within(log()).getAllByText(/codex-personal held: usage_limit/)).toHaveLength(1);
});

it('shows the resumed line when the hold lifts', async () => {
  await mount();
  held = true;
  await refetchTargets();
  await within(log()).findByText(/codex-personal held: usage_limit/);
  held = false;
  await refetchTargets();
  expect(await within(log()).findByText('codex-personal is running again')).toBeInTheDocument();
  expect(within(log()).getAllByText(/codex-personal held: usage_limit/)).toHaveLength(1);
});
