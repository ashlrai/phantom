import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { evictAll } from '../../../data/cache.js';
import type { FleetRuns } from '../ops/ops-runs-model.js';
import type { PaneProps } from '../panes/pane-registry.js';
import { FleetDecisionsPane } from './FleetDecisionsPane.js';
import { fixture } from './fixtures.js';

const props = { visible: true, host: { openPane: vi.fn() } } as unknown as PaneProps;
beforeEach(() => evictAll());
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

const runs: FleetRuns = {
  v: 1, generatedAt: '2026-10-31T12:00:00Z', sources: { runsDir: 'healthy', workers: 'healthy', inbox: 'healthy', codex: 'healthy', merges: 'healthy' },
  lastTick: null, paused: null, memFreePct: null, diskFreeGb: null, switches: [], claudeLane: null,
  lanes: [], workers: [], claimed: [], leaders: [], orchestratorAgents: null, publishesLastHour: [],
  mergesLastHour: { count: 0, items: [] },
  events: [], codexPersonal: null, inbox: [], drop: null,
};

const fleet = () => {
  const data = fixture(), base = data.decisions[0];
  data.decisions = [
    { ...base, itemId: 'one', repo: 'ashlrai/phantom', title: 'Launch alpha', dispatched: true, at: '2026-10-31T12:00:00Z' },
    { ...base, itemId: 'two', repo: 'ashlrai/other', title: 'Launch beta', dispatched: true, at: '2026-10-31T14:00:00Z' },
    { ...base, itemId: 'three', repo: 'ashlrai/phantom', title: 'Skip gamma', dispatched: false, lane: null, seatId: null, skipReason: 'No seat', at: '2026-10-31T13:00:00Z' },
  ];
  data.held = [{ ...data.held[0], title: 'RQ-PHX-EXAMPLE' }];
  return data;
};

const renderPane = async () => {
  vi.stubGlobal('fetch', vi.fn(async (url: RequestInfo | URL) => Response.json(String(url).endsWith('/fleet/runs') ? runs : fleet())));
  render(<FleetDecisionsPane {...props} />);
  return screen.findByRole('searchbox', { name: 'Search decisions' });
};

const listItems = (name: string) => within(screen.getByRole('list', { name })).queryAllByRole('listitem');

it('narrows decisions and held items by repo and title, naming the query when empty', async () => {
  const search = await renderPane();
  expect(listItems('Decisions')).toHaveLength(3);
  expect(listItems('Held items')).toHaveLength(1);
  fireEvent.change(search, { target: { value: 'other' } });
  const decisions = within(screen.getByRole('list', { name: 'Decisions' }));
  expect(decisions.getAllByRole('listitem')).toHaveLength(1);
  expect(decisions.getByRole('listitem')).toHaveTextContent('Launch beta');
  expect(screen.getByText('1 of 3')).toBeInTheDocument();
  expect(listItems('Held items')).toHaveLength(0);
  expect(screen.getByText(/No held items match "other"\./)).toBeInTheDocument();
  fireEvent.change(search, { target: { value: 'rq-phx' } });
  const held = within(screen.getByRole('list', { name: 'Held items' }));
  expect(held.getAllByRole('listitem')).toHaveLength(1);
  expect(held.getByRole('listitem')).toHaveTextContent('RQ-PHX-EXAMPLE');
  expect(listItems('Decisions')).toHaveLength(0);
  expect(screen.getByText(/No decisions match "rq-phx"\./)).toBeInTheDocument();
});

it('restores every row on Clear search', async () => {
  const search = await renderPane();
  fireEvent.change(search, { target: { value: 'other' } });
  expect(listItems('Decisions')).toHaveLength(1);
  fireEvent.click(screen.getByRole('button', { name: 'Clear search' }));
  expect(search).toHaveValue('');
  expect(listItems('Decisions')).toHaveLength(3);
  expect(listItems('Held items')).toHaveLength(1);
  expect(screen.queryByText(/No held items match/)).not.toBeInTheDocument();
});

it('intersects the query with the radio filter and keeps both', async () => {
  const search = await renderPane();
  fireEvent.click(screen.getByRole('radio', { name: 'Skipped' }));
  fireEvent.change(search, { target: { value: 'phantom' } });
  const decisions = within(screen.getByRole('list', { name: 'Decisions' }));
  expect(decisions.getAllByRole('listitem')).toHaveLength(1);
  expect(decisions.getByRole('listitem')).toHaveTextContent('Skip gamma');
  expect(decisions.queryByText(/Launch alpha/)).not.toBeInTheDocument();
  expect(screen.getByRole('radio', { name: 'Skipped' })).toHaveAttribute('aria-checked', 'true');
  expect(screen.getByText('1 of 1')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('radio', { name: 'All' }));
  expect(search).toHaveValue('phantom');
  expect(within(screen.getByRole('list', { name: 'Decisions' })).getAllByRole('listitem')).toHaveLength(2);
});
