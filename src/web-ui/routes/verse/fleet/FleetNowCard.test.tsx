import { render, screen, within } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import type { CompactLeaderBrief } from '../../../../core/fleet/leader-compact-brief.js';
import { FleetNowCard, fleetNowQuery, poolWords } from './FleetNowCard.js';

const state = vi.hoisted(() => ({ data: undefined as unknown, status: 'success' }));
vi.mock('../../../data/hooks.js', () => ({ useQuery: () => state, useRefetch: () => vi.fn() }));
const get = vi.hoisted(() => vi.fn());
vi.mock('../../../data/client.js', () => ({ apiGet: get }));
const pool = { pool: 'work', usedPct: 30, hoursToReset: 2, burnPerHour: 1, safeBurn: 5, verdict: 'ok' };
const brief: CompactLeaderBrief = {
  schema: 'leader.compact-brief.v1', at: '2026-11-21T12:00:00Z', state: 'ready', sources: { ledger: 'healthy' },
  windowHours: 2, emptyWindowHours: 24, lanes: [{ lane: 'work', running: 1, queued: 0, target: 2, held: false, emptyRate: null }],
  pools: Array.from({ length: 12 }, (_, i) => ({ ...pool, pool: `pool ${i}`, verdict: i === 1 ? 'over' : 'ok', burnPerHour: i === 2 ? 0 : 1 })),
  families: [{ family: 'work', launches: 20, prs: 15, merges: 12, empty: 5 }],
  attention: [{ id: 'slow', lane: 'work', status: 'stuck', elapsed: 20 }], liveAt: null,
  main: [{ repo: 'phantom', state: 'green', stale: false }], medianOpenToMergeSeconds: null, stopped: [], omitted: 0,
};
it('uses plain verdicts and keeps twelve pools within six rows', () => {
  state.data = brief;
  render(<FleetNowCard />);
  const list = screen.getByRole('list', { name: 'Fleet summary' });
  expect(within(list).getAllByRole('listitem')).toHaveLength(6);
  expect(list).toHaveTextContent('12 PRs merged in 2 h, 1 lane busy, main green');
  for (const words of ['on pace', 'spending too fast', 'unused', '9 more pools', 'Worst job family: work', 'slow (stuck)']) expect(list).toHaveTextContent(words);
  expect(poolWords({ ...pool, verdict: 'unknown', burnPerHour: 0 })).toBe('pace unknown');
});
it.each([undefined, { state: 'no data' }, { ...brief, state: 'no data' }])('shows a friendly empty state', data => {
  state.data = data;
  render(<FleetNowCard />);
  expect(screen.getByText('No fleet data yet')).toBeTruthy();
});
it('keeps missing and stale facts unknown and labels a failed refresh', () => {
  state.data = { ...brief, lanes: [], omitted: 1, main: [{ repo: 'phantom', state: 'green', stale: true }] };
  state.status = 'error';
  render(<FleetNowCard />);
  expect(screen.getByRole('list')).toHaveTextContent('unknown PRs merged in 2 h, busy lanes unknown, main unknown');
  expect(screen.getByRole('list')).toHaveTextContent('Could not refresh; showing the last reading.');
  state.status = 'success';
});
it('reads only the compact brief route', async () => {
  await fleetNowQuery.fetch(new AbortController().signal);
  expect(get.mock.lastCall?.[0]).toBe('/api/verse/fleet/runs/leader-brief');
});
