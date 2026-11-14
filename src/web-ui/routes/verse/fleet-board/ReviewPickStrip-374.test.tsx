/** RQ-PHX-REVIEWPICKSTRIP374 — strip renders from a mocked fetch. Fake ids only. */
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { evictAll } from '../../../data/cache.js';
import { ReviewPickStrip } from './ReviewPickStrip.js';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
afterEach(() => { cleanup(); evictAll(); vi.unstubAllGlobals(); });

const stub = (res: () => Response) => vi.stubGlobal('fetch', vi.fn(async () => res()));

const body = (picked: unknown, over: Record<string, unknown> = {}) => ({
  schema: 'fleet.review-pick.v1', as_of: '2026-11-14T18:00:00.000Z', repo: 'example/phantom',
  source: { prs: 'read', claims: {}, unavailable: [] },
  picked, reason: 'no unowned non-draft open PRs', skipped: [], unowned_candidates: 1, ...over,
});

const PICK = {
  repo: 'example/phantom', pr: 42, head: 'review/fake', head_sha: 'a'.repeat(40),
  title: 'Fake review task', owner: 'none', reason: 'no live claim names it',
};

it('renders the pick as a github pull link', async () => {
  stub(() => json(body(PICK)));
  render(<ReviewPickStrip />);
  await waitFor(() => expect(screen.getByRole('link')).toHaveAttribute('href', 'https://github.com/example/phantom/pull/42'));
  const line = screen.getByText(/Needs a reviewer:/);
  expect(line.textContent).toMatch(/^Needs a reviewer: example\/phantom#42 · aaaaaaa · Fake review task · as of \d{2}:\d{2}$/);
});

it('renders nothing on 404', async () => {
  const fetchMock = vi.fn(async () => json({}, 404));
  vi.stubGlobal('fetch', fetchMock);
  const { container } = render(<ReviewPickStrip />);
  await waitFor(() => expect(fetchMock).toHaveBeenCalled());
  await waitFor(() => expect(container.querySelector('section')).toBeNull());
  expect(screen.queryByText(/Needs a reviewer/)).toBeNull();
});

it('renders nothing on a malformed body', async () => {
  stub(() => json({ schema: 'other', picked: PICK }));
  const { container } = render(<ReviewPickStrip />);
  await waitFor(() => expect(container.querySelector('section')).toBeNull());
});

it('renders the reason when there is no pick', async () => {
  stub(() => json(body(null)));
  render(<ReviewPickStrip />);
  await waitFor(() => expect(screen.getByText(/no unowned non-draft open PRs/)).toBeInTheDocument());
  expect(screen.getByText(/Needs a reviewer: none/)).toBeInTheDocument();
});

it('names the unavailable sources with the reason', async () => {
  stub(() => json(body(null, {
    reason: 'ownership source unavailable',
    source: { prs: 'read', claims: {}, unavailable: ['coordination'] },
  })));
  render(<ReviewPickStrip />);
  await waitFor(() => expect(screen.getByText(/sources unavailable: coordination/)).toBeInTheDocument());
});
