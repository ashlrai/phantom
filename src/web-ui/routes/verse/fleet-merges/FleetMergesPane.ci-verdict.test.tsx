import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { evictAll, refetchQuery } from '../../../data/cache.js';
import type { PaneProps } from '../panes/pane-registry.js';
import { FleetMergesPane } from './FleetMergesPane.js';

const ciUrl = '/api/verse/fleet/ci-runs?hours=24';
const prs = [42, 43, 44, 45, 46].map(number => ({ number, title: `PR ${number}`, author: 'mason', head: `branch-${number}`, updatedAt: null, files: [], overlaps: [] }));
const runs = prs.slice(0, 4).map(({ number }, index) => ({
  runId: number, workflow: 'CI', event: 'pull_request', headBranch: `branch-${number}`, prNumber: number,
  conclusion: ['success', 'failure', 'failure', null][index], status: index === 3 ? 'queued' : 'completed',
  failureClass: index === 1 ? 'bind-artifact' : index === 2 ? 'code' : null,
  createdAt: '2026-11-01T01:00:00Z', url: `https://github.com/acme/widgets/actions/runs/${number}`,
}));
const facts = { v: 1, repo: 'acme/widgets', available: true, recent: runs };
const outside = { sourceState: 'healthy', repos: [{ repo: 'acme/widgets', prs }, { repo: 'other/widgets', prs: [prs[0]] }] };
const merges = { mergesLastHour: { count: 0, items: [] }, publishesLastHour: [], lanes: [], sources: { merges: 'healthy' } };

function stubFetch(ciResponse: () => Promise<Response> = async () => Response.json(facts)) {
  return vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url === ciUrl) return ciResponse();
    return Response.json(url === '/api/verse/fleet/live/outside-prs' ? outside : merges);
  }));
}

beforeEach(() => evictAll());
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

it('shows linked verdicts and counts for matching open PRs only', async () => {
  stubFetch();
  render(<FleetMergesPane {...{ visible: true } as PaneProps} />);
  expect(await screen.findByText('1 green, 1 artifact reds, 1 code reds')).toBeInTheDocument();
  const list = within(screen.getByRole('list', { name: 'Outside PRs' }));
  for (const [label, id] of [['CI green', 42], ['CI red: rebase artifact, not code', 43], ['CI red: code', 44], ['CI running', 45]] as const) {
    const link = list.getByRole('link', { name: label });
    expect(link).toHaveAttribute('href', `https://github.com/acme/widgets/actions/runs/${id}`);
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  }
  expect(within(list.getByText('other/widgets #42').closest('li')!).queryByText('CI green')).not.toBeInTheDocument();
  expect(within(list.getByText('acme/widgets #46').closest('li')!).queryByText(/CI /)).not.toBeInTheDocument();
});

it.each(['404', 'network', 'unavailable'] as const)('hides CI facts on %s', async mode => {
  stubFetch(async () => {
    if (mode === 'network') throw new Error('offline');
    return mode === '404' ? Response.json({}, { status: 404 }) : Response.json({ ...facts, available: false });
  });
  render(<FleetMergesPane {...{ visible: true } as PaneProps} />);
  await screen.findByText('acme/widgets #42');
  await waitFor(() => expect(vi.mocked(fetch)).toHaveBeenCalledWith(ciUrl, expect.anything()));
  expect(screen.queryByText(/CI (green|red|running)/)).not.toBeInTheDocument();
  expect(screen.queryByText(/artifact reds/)).not.toBeInTheDocument();
});

it('hides previously cached verdicts if a refresh fails', async () => {
  stubFetch();
  render(<FleetMergesPane {...{ visible: true } as PaneProps} />);
  await screen.findByText('CI green');
  await act(async () => { await refetchQuery('verse-fleet-ci-runs-24h', async () => { throw new Error('offline'); }, true); });
  expect(screen.queryByText('CI green')).not.toBeInTheDocument();
  expect(screen.queryByText(/artifact reds/)).not.toBeInTheDocument();
});

it('polls CI every five minutes while visible', async () => {
  vi.useFakeTimers();
  stubFetch();
  const view = render(<FleetMergesPane {...{ visible: true } as PaneProps} />);
  await act(async () => { await vi.advanceTimersByTimeAsync(299_999); });
  expect(vi.mocked(fetch).mock.calls.filter(([url]) => url === ciUrl)).toHaveLength(1);
  await act(async () => { await vi.advanceTimersByTimeAsync(1); });
  expect(vi.mocked(fetch).mock.calls.filter(([url]) => url === ciUrl)).toHaveLength(2);
  view.rerender(<FleetMergesPane {...{ visible: false } as PaneProps} />);
  await act(async () => { await vi.advanceTimersByTimeAsync(300_000); });
  expect(vi.mocked(fetch).mock.calls.filter(([url]) => url === ciUrl)).toHaveLength(2);
}, 20_000);
