import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { clearMutationToken, setMutationToken } from '../../../data/auth-store.js';
import { evictAll } from '../../../data/cache.js';
import { EmailDraftsCard } from './EmailDraftsCard.js';

const id = 'd-0123456789abcdef';
const digest = `sha256:${'c'.repeat(64)}`;
const draft = (over: Record<string, unknown> = {}) => ({
  id, to: 'someone@example.invalid', subject: 'Quarterly check-in', body: 'Hi there,\nLine two.', digest, createdAt: '2026-11-01T00:00:00.000Z', ...over,
});
const list = (...drafts: unknown[]) => Response.json({ v: 1, drafts });

beforeEach(() => { evictAll(); setMutationToken('a'.repeat(64)); });
afterEach(() => { cleanup(); clearMutationToken(); vi.unstubAllGlobals(); });

it('renders recipient, subject and body', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => list(draft())));
  render(<EmailDraftsCard visible />);
  expect(await screen.findByText('Email drafts')).toBeInTheDocument();
  expect(screen.getByText('To someone@example.invalid')).toBeInTheDocument();
  expect(screen.getByText('Quarterly check-in')).toBeInTheDocument();
  expect(screen.getByText((_, el) => el?.tagName === 'PRE' && el.textContent === 'Hi there,\nLine two.')).toBeInTheDocument();
});

it('approve posts the id and full digest and says it does not send', async () => {
  let done = false;
  const fetcher = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === 'POST') { done = true; return Response.json({ v: 1, status: 'approved', id }); }
    return done ? list() : list(draft());
  });
  vi.stubGlobal('fetch', fetcher);
  render(<EmailDraftsCard visible />);
  fireEvent.click(await screen.findByRole('button', { name: /Approve email/ }));
  expect(await screen.findByText('Approved. Approval records your decision; it does not send.')).toBeInTheDocument();
  const posts = fetcher.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === 'POST');
  expect(posts).toHaveLength(1);
  expect(posts[0]![0]).toBe('/api/verse/comms/inbox/email-drafts/approve');
  expect(JSON.parse(String(posts[0]![1]!.body))).toEqual({ id, digest });
});

it('reject posts only the id', async () => {
  const fetcher = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) =>
    init?.method === 'POST' ? Response.json({ v: 1, status: 'rejected', id }) : list(draft()));
  vi.stubGlobal('fetch', fetcher);
  render(<EmailDraftsCard visible />);
  fireEvent.click(await screen.findByRole('button', { name: /Reject email/ }));
  expect(await screen.findByText('Rejected.')).toBeInTheDocument();
  const post = fetcher.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === 'POST')!;
  expect(post[0]).toBe('/api/verse/comms/inbox/email-drafts/reject');
  expect(JSON.parse(String(post[1]!.body))).toEqual({ id });
});

it('a 409 stale shows the review-again sentence', async () => {
  vi.stubGlobal('fetch', vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => init?.method === 'POST'
    ? Response.json({ v: 1, status: 'stale', code: 'stale' }, { status: 409 }) : list(draft())));
  render(<EmailDraftsCard visible />);
  fireEvent.click(await screen.findByRole('button', { name: /Approve email/ }));
  expect(await screen.findByText('The draft changed; review it again.')).toBeInTheDocument();
});

it('cannot approve a truncated draft', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => list(draft({ truncated: true }))));
  render(<EmailDraftsCard visible />);
  expect(await screen.findByRole('button', { name: /Approve email/ })).toBeDisabled();
});

it('renders nothing for an empty list and drops malformed rows', async () => {
  const fetcher = vi.fn(async () => list(draft({ id: 'nope' }), { junk: true }));
  vi.stubGlobal('fetch', fetcher);
  const view = render(<EmailDraftsCard visible />);
  await waitFor(() => expect(fetcher).toHaveBeenCalled());
  await new Promise(resolve => setTimeout(resolve, 20));
  expect(view.container).toBeEmptyDOMElement();
});
