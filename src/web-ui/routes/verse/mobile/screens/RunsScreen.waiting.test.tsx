import { screen, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { evictAll } from '../../../../data/cache.js';
import { resetBusMissingForTest } from '../bus-query.js';
import { renderMobile, stubFetch } from '../mobile.test-support.js';
import { RunsScreen } from './RunsScreen.js';

const base = {
  v: 1, generatedAt: '2026-11-01T00:00:00Z', lastTick: null, paused: false, claudeLane: null,
  workers: [], leaders: [], mergesLastHour: { count: 0, items: [] }, codexPersonal: null, inbox: [],
};
const lane = (name: string, queued: number, running: number, target: number, held = false) =>
  ({ lane: name, queued, running, target, held, heldReason: held ? 'usage limit' : null });

afterEach(() => { evictAll(); resetBusMissingForTest(); vi.unstubAllGlobals(); });

it('renders waiting lanes, a stall, held reason and drop files from the gateway response', async () => {
  stubFetch({ 'GET /api/verse/fleet/runs': { ...base, lanes: [lane('codex-personal', 8, 20, 20), lane('devin', 24, 2, 4), lane('claude', 1, 1, 1, true)],
    drop: { pending: [{ lane: 'devin', file: 'one' }, { lane: 'codex-personal', file: 'two' }], done: 0 } } });
  renderMobile(<RunsScreen />);
  const section = (await screen.findByRole('heading', { name: 'Waiting to launch' })).closest('section')!;
  expect(within(section).getByText('Launch stall: devin have open slots and queued work')).toBeInTheDocument();
  expect(within(section).getByText('codex-personal · 8 queued · running 20 of 20')).toBeInTheDocument();
  expect(within(section).getByText('devin · 24 queued · running 2 of 4')).toBeInTheDocument();
  expect(within(section).getByText('Held: usage limit')).toBeInTheDocument();
  expect(within(section).getByText('2 jobs in the drop folder')).toBeInTheDocument();
  expect(within(section).getByText('devin, codex-personal')).toBeInTheDocument();
});

it('renders the empty state when nothing is waiting', async () => {
  stubFetch({ 'GET /api/verse/fleet/runs': { ...base, lanes: [lane('codex', 0, 0, 1)], drop: { pending: [], done: 0 } } });
  renderMobile(<RunsScreen />);
  const section = (await screen.findByRole('heading', { name: 'Waiting to launch' })).closest('section')!;
  expect(within(section).getAllByText('Nothing waiting')).toHaveLength(2);
});

it('rejects malformed drop data instead of reporting an empty folder', async () => {
  stubFetch({ 'GET /api/verse/fleet/runs': { ...base, lanes: [], drop: { pending: [{ lane: 'devin', file: 42 }] } } });
  renderMobile(<RunsScreen />);
  expect(await screen.findByText('Couldn’t load live runs')).toBeInTheDocument();
  expect(screen.queryByText('Nothing waiting')).not.toBeInTheDocument();
});
