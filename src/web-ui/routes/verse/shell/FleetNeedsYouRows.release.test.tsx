import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { evictAll, refetchQuery } from '../../../data/cache.js';
import { getDockState, resetDockStore } from '../dock/dock-store.js';
import { getVerseUiState, openVerseNeedsYou, resetVerseUi } from '../verse-ui-store.js';
import { FleetNeedsYouRows, type FleetNeedsYouReport } from './FleetNeedsYouRows.js';

const now = Date.parse('2026-10-31T12:00:00Z');
const fleet = {
  v: 1, generatedAt: '2026-10-31T12:00:00Z',
  sources: { runsDir: 'healthy', workers: 'healthy', inbox: 'healthy', codex: 'healthy', merges: 'healthy' },
  lastTick: '2026-10-31T11:59:00Z', paused: false, memFreePct: 50, diskFreeGb: 80,
  switches: ['HOLD'], claudeLane: null, lanes: [], workers: [], leaders: [], orchestratorAgents: 1,
  publishesLastHour: [], mergesLastHour: { count: 1, items: [] }, events: [], codexPersonal: null, inbox: [], drop: null,
};
const release = { v: 1, generatedAt: '2026-10-31T12:00:00Z', sourceState: 'healthy', repos: [{
  repo: 'example/repo', path: '/fake', notes: [], pr: {
    number: 42, title: 'release', url: 'https://github.com/example/repo/pull/42', version: '3.30.0',
    openedAt: '2026-10-28T12:00:00Z', updatedAt: '2026-10-31T12:00:00Z', mergeable: null,
    checks: [{ name: 'Dependency audit (root + Raycast)', state: 'fail', url: null }],
    failing: ['Dependency audit (root + Raycast)'], pending: 0, blocked: true, summary: 'blocked',
  },
}] };
function setup(releaseResponse: unknown, status = 200) {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    if (String(input) === '/api/verse/fleet/runs') return Response.json(fleet);
    if (String(input) === '/api/verse/release-pr') return status === 200 ? Response.json(releaseResponse) : new Response('', { status });
    return new Response('', { status: 404 });
  }));
  const reports: FleetNeedsYouReport[] = [];
  render(<FleetNeedsYouRows split="fleet" nowMs={now} onResult={report => reports.push(report)} />);
  return reports;
}
beforeEach(() => { localStorage.clear(); evictAll(); resetVerseUi(); resetDockStore(); });
afterEach(() => { cleanup(); evictAll(); vi.unstubAllGlobals(); });

it('reports the blocker, links to the PR, and opens Merges', async () => {
  const user = userEvent.setup();
  act(() => openVerseNeedsYou({ split: 'fleet' }));
  const reports = setup(release);
  const title = await screen.findByText('Release 3.30.0 is blocked');
  const row = title.closest('[data-severity]')!;
  expect(within(row as HTMLElement).getByText('Dependency audit (root + Raycast) failing · open 3 d')).toBeInTheDocument();
  expect(within(row as HTMLElement).getByRole('link', { name: 'Open release PR' })).toHaveAttribute('href', 'https://github.com/example/repo/pull/42');
  await waitFor(() => expect(reports.at(-1)?.items).toHaveLength(2));
  expect(reports.at(-1)?.answered).toBe(true);
  await user.click(within(row as HTMLElement).getByRole('button', { name: 'Open Merges' }));
  expect(getVerseUiState()).toMatchObject({ overlay: null, section: 'chat' });
  expect(getDockState()).toMatchObject({ open: true, active: 'fleet-merges' });
});

it('keeps fleet rows and coverage unchanged when the release route is absent', async () => {
  const reports = setup(null, 404);
  expect(await screen.findByText('Dispatch is paused by HOLD')).toBeInTheDocument();
  await waitFor(() => expect(reports.at(-1)).toMatchObject({ answered: true, items: [{ id: 'switches-on' }], silent: null }));
  expect(screen.queryByText(/Release .* is blocked/)).not.toBeInTheDocument();
});

it('does not expose an unsafe PR URL and retains the Fleet handoff', async () => {
  const user = userEvent.setup();
  setup({ ...release, repos: [{ ...release.repos[0], pr: { ...release.repos[0]!.pr, url: 'https://example.com/fake' } }] });
  await screen.findByText('Release 3.30.0 is blocked');
  expect(screen.queryByRole('link', { name: 'Open release PR' })).not.toBeInTheDocument();
  await user.click(screen.getAllByRole('button', { name: 'Open Fleet' }).at(-1)!);
  expect(getVerseUiState().section).toBe('fleet');
});

it('removes a stale release row after a failed refresh without changing fleet coverage', async () => {
  const reports = setup(release);
  await screen.findByText('Release 3.30.0 is blocked');
  await act(async () => { await refetchQuery('verse-release-pr', async () => { throw new Error('offline'); }, true); });
  expect(screen.queryByText('Release 3.30.0 is blocked')).not.toBeInTheDocument();
  expect(reports.at(-1)).toMatchObject({ answered: true, items: [{ id: 'switches-on' }], silent: null });
});
