import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { evictAll } from '../../../data/cache.js';
import { JobDetailSheet } from './JobDetailSheet.js';

const job = 'RQ-PHX-EXAMPLE01';
const repo = 'repo';
const detail = { schema: 'fleet.job.v1', job, state: 'published', lane: 'test',
  publish: { prUrl: 'https://github.com/example/repo/pull/123' }, log: { source: 'live', tail: [] },
  sources: { launch: 'healthy', base: 'healthy', meta: 'healthy', publish: 'healthy', log: 'healthy' } };
const backlog = { v: 1, source: 'ok', items: [{ number: 123, job, headRef: 'work/example', mergeStateStatus: 'DIRTY', suggestedAction: 'recut', classification: { reason: 'merge-conflict' } }] };
const route = '/api/verse/github/fleet-backlog?repo=example%2Frepo';

beforeEach(() => { evictAll(); });
afterEach(() => { vi.unstubAllGlobals(); evictAll(); });

it('shows the PR state and recut guidance, sharing the read between open sheets', async () => {
  const fetcher = vi.fn(async (path: string) => Response.json(path === route ? backlog : detail));
  vi.stubGlobal('fetch', fetcher);
  const first = render(<JobDetailSheet job={job} repo={repo} onClose={vi.fn()} />);
  expect(await screen.findByText('PR #123 · DIRTY · recut — conflicts with master')).toBeInTheDocument();
  expect(screen.getByText('Queue a recut from the Outcomes pane')).toBeInTheDocument();
  const second = render(<JobDetailSheet job={job} repo={repo} onClose={vi.fn()} />);
  expect(await screen.findAllByText('PR #123 · DIRTY · recut — conflicts with master')).toHaveLength(2);
  expect(fetcher.mock.calls.filter(([path]) => path === route)).toHaveLength(1);
  first.unmount(); second.unmount();
});

it('shows no extra PR state for a 404', async () => {
  const fetcher = vi.fn(async (path: string) => path === route ? new Response(null, { status: 404 }) : Response.json(detail));
  vi.stubGlobal('fetch', fetcher);
  render(<JobDetailSheet job={job} repo={repo} onClose={vi.fn()} />);
  expect(await screen.findByRole('link', { name: `PR for job ${job}` })).toBeInTheDocument();
  await waitFor(() => expect(fetcher.mock.calls.some(([path]) => path === route)).toBe(true));
  expect(screen.queryByText(/PR #123 ·/)).not.toBeInTheDocument();
  expect(screen.queryByText('Queue a recut from the Outcomes pane')).not.toBeInTheDocument();
});

it('does not request the backlog without a resolvable repository', async () => {
  const fetcher = vi.fn(async (_path: string) => Response.json({ ...detail, publish: null }));
  vi.stubGlobal('fetch', fetcher);
  render(<JobDetailSheet job={job} repo="repo" onClose={vi.fn()} />);
  await screen.findByText('Changed files');
  expect(fetcher.mock.calls.every(([path]) => !String(path).startsWith('/api/verse/github/fleet-backlog'))).toBe(true);
});
