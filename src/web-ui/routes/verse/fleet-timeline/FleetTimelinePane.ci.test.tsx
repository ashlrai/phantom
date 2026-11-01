import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { toneColor } from '../../../components/charts/colors.js';
import { evictAll } from '../../../data/cache.js';
import { fleetRunsFixture } from '../fleet/fleet-runs-fixtures.test-support.js';
import { FleetTimelinePane } from './FleetTimelinePane.js';

const now = Date.parse('2026-11-01T02:00:00Z');
const facts = {
  v: 1, generatedAt: '2026-11-01T02:00:00Z', repo: 'example/repo', windowHours: 1, available: true, reason: null,
  total: 2, byEvent: { pull_request: 1, push: 0, schedule: 1, merge_group: 0, workflow_dispatch: 0, other: 0 },
  byWorkflow: [{ name: 'Checks', total: 2, failed: 1 }], failures: { total: 1, bindArtifact: 1, code: 0, unclassified: 0 },
  daily: { runId: 2, conclusion: 'success', createdAt: '2026-11-01T01:55:00Z', failedJobs: [], url: 'https://github.com/example/repo/actions/runs/2' },
  recent: [
    { runId: 1, workflow: 'Checks', event: 'pull_request', headBranch: 'fake', prNumber: 12, conclusion: 'failure', status: 'completed', failureClass: 'bind-artifact', createdAt: '2026-11-01T01:54:00Z', url: 'https://github.com/example/repo/actions/runs/1' },
    { runId: 2, workflow: 'Checks', event: 'schedule', headBranch: 'main', prNumber: null, conclusion: 'success', status: 'completed', failureClass: null, createdAt: '2026-11-01T01:55:00Z', url: 'https://github.com/example/repo/actions/runs/2' },
  ],
};
function serve(ciStatus = 200) {
  const snapshot = { ...fleetRunsFixture({ claudeLane: null }), mergesLastHour: { count: 1, items: [{ repo: 'example/repo', number: 42, title: 'merge', mergedAt: '2026-11-01T01:53:00Z' }] } };
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => String(input).includes('/ci-runs?')
    ? Response.json(ciStatus === 200 ? facts : {}, { status: ciStatus })
    : String(input).includes('/live/bus') ? Response.json({}, { status: 404 }) : Response.json(snapshot)));
}
beforeEach(() => { evictAll(); localStorage.clear(); vi.spyOn(Date, 'now').mockReturnValue(now); });
afterEach(() => { cleanup(); localStorage.clear(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it('renders the CI lane after merges with colors, headline, navigation and grouped layout', async () => {
  serve();
  const open = vi.spyOn(window, 'open').mockImplementation(() => null);
  const { container } = render(<FleetTimelinePane visible />);
  const failed = await screen.findByRole('button', { name: 'CI: CI #1 · Checks · pull_request · PR #12 · bind artifact' });
  expect(screen.getByRole('button', { name: 'CI: Nightly · CI #2 · Checks · schedule' })).toBeInTheDocument();
  expect([...container.querySelectorAll('g[data-lane]')].slice(0, 2).map((lane) => lane.getAttribute('data-lane'))).toEqual(['merges', 'ci']);
  expect(container.querySelector('rect[data-status="failed"]')).toHaveAttribute('fill', toneColor('danger'));
  expect(container.querySelector('rect[data-status="done"]')).toHaveAttribute('fill', toneColor('success'));
  expect(screen.getByTitle('2 runs · 1 failed (1 branch-behind, 0 code) · nightly green')).toBeInTheDocument();
  fireEvent.click(failed);
  expect(open).toHaveBeenCalledWith('https://github.com/example/repo/actions/runs/1', '_blank', 'noopener,noreferrer');
  fireEvent.click(screen.getByRole('button', { name: 'Group by lane' }));
  expect(screen.getByRole('button', { name: 'CI: Nightly · CI #2 · Checks · schedule' })).toBeInTheDocument();
});

it('keeps the timeline unchanged when the route is missing', async () => {
  serve(404); render(<FleetTimelinePane visible />);
  await waitFor(() => expect(fetch).toHaveBeenCalledWith(expect.stringContaining('/ci-runs?hours='), expect.anything()));
  expect(screen.queryByRole('button', { name: 'Show CI' })).not.toBeInTheDocument();
  expect(screen.queryByLabelText(/^CI:/)).not.toBeInTheDocument();
});

it('persists the CI visibility preference', async () => {
  serve(); const view = render(<FleetTimelinePane visible />);
  await screen.findByRole('button', { name: 'CI: Nightly · CI #2 · Checks · schedule' });
  fireEvent.click(screen.getByRole('button', { name: 'Show CI' }));
  expect(localStorage.getItem('phantom.timeline.show-ci.v1')).toBe('false');
  expect(screen.queryByLabelText(/^CI:/)).not.toBeInTheDocument();
  view.unmount(); render(<FleetTimelinePane visible />);
  expect(await screen.findByRole('button', { name: 'Show CI' })).toHaveAttribute('aria-pressed', 'false');
  expect(screen.queryByLabelText(/^CI:/)).not.toBeInTheDocument();
});
