import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { toneColor } from '../../../components/charts/colors.js';
import { evictAll } from '../../../data/cache.js';
import { fleetRunsFixture } from '../fleet/fleet-runs-fixtures.test-support.js';
import { FleetTimelinePane } from './FleetTimelinePane.js';

const now = Date.parse('2026-10-31T12:45:00Z');
const bus = { v: 1, hops: [], hopsDropped: 0, lastHopAt: null, sources: { hops: 'healthy', events: 'healthy' },
  events: [{ at: '2026-10-31T12:20:00Z', kind: 'inbox', text: 'INBOX Mason, hello' }] };
const merge = { repo: 'example/repo', number: 42, title: 'bridge: RQ-PHX-EXAMPLE31', mergedAt: '2026-10-31T12:30:00Z' };

beforeEach(() => { evictAll(); localStorage.clear(); vi.spyOn(Date, 'now').mockReturnValue(now); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); localStorage.clear(); });

it('shows merges below Mason, opens the PR, and retains the lane when grouped', async () => {
  const snapshot = { ...fleetRunsFixture({ claudeLane: null }), mergesLastHour: { count: 2, items: [merge, { repo: 'example/repo', number: 43, title: 'pending time' }] } };
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => Response.json(String(input).includes('/live/bus') ? bus : snapshot)));
  const open = vi.spyOn(window, 'open').mockImplementation(() => null);
  const { container } = render(<FleetTimelinePane visible />);
  const button = await screen.findByRole('button', { name: 'Merges: #42 RQ-PHX-EXAMPLE31' });
  await screen.findByRole('button', { name: 'Mason: hello' });
  expect([...container.querySelectorAll('g[data-lane]')].slice(0, 2).map((lane) => lane.getAttribute('data-lane'))).toEqual(['mason', 'merges']);
  expect(container.querySelector('rect[data-status="merged"]')).toHaveAttribute('fill', toneColor('success'));
  expect(screen.getByText('1 merges without a time in this snapshot')).toBeInTheDocument();
  fireEvent.click(button);
  expect(open).toHaveBeenCalledWith('https://github.com/example/repo/pull/42', '_blank', 'noopener,noreferrer');
  fireEvent.click(screen.getByRole('button', { name: 'Group by lane' }));
  expect(screen.getByRole('button', { name: 'Merges: #42 RQ-PHX-EXAMPLE31' })).toBeInTheDocument();
});

it('explains an empty merge snapshot', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ ...fleetRunsFixture({ claudeLane: null }), mergesLastHour: { count: 0, items: [] } })));
  render(<FleetTimelinePane visible />);
  expect(await screen.findByText('No merges in this window')).toBeInTheDocument();
  expect(screen.queryByLabelText(/Merges:.*runs/)).not.toBeInTheDocument();
});
