import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { evictAll } from '../../../data/cache.js';
import { SectionVisibilityProvider } from '../shell/section-visibility.js';
import { fleetRunsFixture } from './fleet-runs-fixtures.test-support.js';
import { WorkersCard } from './WorkersCard.js';
import styles from './workers-card.module.css';

const now = Date.parse('2026-10-31T12:00:00Z');
const at = (minutes: number) => new Date(now - minutes * 60_000).toISOString();
const worker = { job: 'RQ-PHX-B', repo: 'example/repo', lane: 'work', tier: 'mid', ageSeconds: 60 };
const snapshot = {
  ...fleetRunsFixture(), claudeLane: null, lastTick: at(3), workers: [worker], publishesLastHour: [],
  claimed: [
    { job: 'RQ-PHX-A', lane: 'work', tier: 'mid', at: at(7) },
    { job: 'RQ-PHX-B', lane: 'work', tier: 'mid', at: at(1) },
  ],
};
beforeEach(() => { evictAll(); vi.spyOn(Date, 'now').mockReturnValue(now); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); evictAll(); });
function show(data: unknown) {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json(data)));
  render(<SectionVisibilityProvider visible><WorkersCard /></SectionVisibilityProvider>);
}

it('shows unstarted claims and warns while retaining the running worker', async () => {
  show(snapshot);
  const list = await screen.findByRole('list', { name: 'Claimed jobs' });
  expect(screen.getByText('Starting')).toBeInTheDocument();
  expect(within(list).getAllByRole('listitem')).toHaveLength(1);
  expect(within(list).getByText('RQ-PHX-A')).toBeInTheDocument();
  expect(within(list).getByText('work')).toBeInTheDocument();
  expect(within(list).getByText('mid')).toBeInTheDocument();
  expect(within(list).getByText('07:00')).toBeInTheDocument();
  expect(within(list).queryByText('RQ-PHX-B')).not.toBeInTheDocument();
  expect(screen.getByRole('status')).toHaveTextContent('Dispatch is not starting claimed jobs (oldest 7 min, last tick 3 min ago)');
  expect(screen.getByRole('button', { name: 'Job RQ-PHX-B' })).toBeInTheDocument();
});

it('shows fresh claims without a status line', async () => {
  show({ ...snapshot, claimed: [{ ...snapshot.claimed[0], at: at(1) }] });
  expect(await screen.findByRole('list', { name: 'Claimed jobs' })).toBeInTheDocument();
  expect(screen.queryByRole('status')).not.toBeInTheDocument();
});

it.each([undefined, []])('leaves the card unchanged when claims are %s', async claimed => {
  show({ ...snapshot, claimed });
  await screen.findByRole('button', { name: 'Job RQ-PHX-B' });
  expect(screen.queryByRole('list', { name: 'Claimed jobs' })).not.toBeInTheDocument();
  expect(screen.queryByText('Starting')).not.toBeInTheDocument();
  expect(screen.queryByRole('status')).not.toBeInTheDocument();
});

it('uses the danger tone for a claim older than fifteen minutes', async () => {
  show({ ...snapshot, claimed: [{ ...snapshot.claimed[0], at: at(16) }] });
  expect(await screen.findByRole('status')).toHaveClass(styles.rowStuck);
});

it('reports a stuck claim even when no workers are running', async () => {
  show({ ...snapshot, workers: [], switches: [], claimed: [snapshot.claimed[0]] });
  expect(await screen.findByRole('list', { name: 'Claimed jobs' })).toHaveTextContent('RQ-PHX-A');
  expect(screen.getByRole('status')).toHaveTextContent('oldest 7 min');
  expect(screen.getByText('No workers running. Leaders write jobs every 15 minutes.')).toBeInTheDocument();
});
