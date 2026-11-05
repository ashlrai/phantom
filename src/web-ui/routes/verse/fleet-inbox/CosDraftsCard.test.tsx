import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { clearMutationToken, setMutationToken } from '../../../data/auth-store.js';
import { evictAll } from '../../../data/cache.js';
import { CosDraftsCard } from './CosDraftsCard.js';

const id = `cos-${'1'.repeat(32)}`;
const digest = `sha256:${'b'.repeat(64)}`;
const text = 'Line one of the reply.\nLine two, a long tail '.concat('x'.repeat(600));
const draft = (over: Record<string, unknown> = {}) => ({
  id, channel: 'telegram', senderId: 'sender-1', text, digest, delivery: 'pending', draftedAt: '2026-11-01T00:00:00Z', ...over,
});
const list = (...drafts: unknown[]) => Response.json({ v: 1, drafts, malformed: 0 });

beforeEach(() => { evictAll(); setMutationToken('a'.repeat(64)); });
afterEach(() => { cleanup(); clearMutationToken(); vi.unstubAllGlobals(); });

const posts = (fetcher: ReturnType<typeof vi.fn>) => fetcher.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === 'POST');

it('renders the full text, channel and recipient', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => list(draft())));
  render(<CosDraftsCard visible />);
  const block = await screen.findByText((_, el) => el?.tagName === 'PRE' && el.textContent === text);
  expect(block).toBeInTheDocument();
  expect(screen.getByText('Telegram')).toBeInTheDocument();
  expect(screen.getByText('To sender-1')).toBeInTheDocument();
});

it('posts exactly the displayed id and digest once, even on a double click', async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let sent = false;
  const fetcher = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === 'POST') { await gate; sent = true; return Response.json({ id, delivery: 'sent' }); }
    return sent ? list(draft({ delivery: 'sent' })) : list(draft());
  });
  vi.stubGlobal('fetch', fetcher);
  render(<CosDraftsCard visible />);
  const button = await screen.findByRole('button', { name: /Approve and send/ });
  fireEvent.click(button);
  fireEvent.click(button);
  await waitFor(() => expect(button).toBeDisabled());
  release();
  expect(await screen.findByText('Sent on Telegram.')).toBeInTheDocument();
  const sentPosts = posts(fetcher);
  expect(sentPosts).toHaveLength(1);
  expect(sentPosts[0]![0]).toBe('/api/verse/cos/drafts/approve');
  expect(JSON.parse(String(sentPosts[0]![1].body))).toEqual({ id, digest });
  await waitFor(() => expect(screen.queryByRole('button', { name: /Approve and send/ })).toBeNull());
});

it('tells the operator to review again on a stale digest', async () => {
  vi.stubGlobal('fetch', vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => init?.method === 'POST'
    ? Response.json({ code: 'COS_DIGEST_STALE' }, { status: 409 }) : list(draft())));
  render(<CosDraftsCard visible />);
  fireEvent.click(await screen.findByRole('button', { name: /Approve and send/ }));
  expect(await screen.findByText('The draft changed; review it again.')).toBeInTheDocument();
});

it('reports an uncertain send without offering a retry', async () => {
  vi.stubGlobal('fetch', vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => init?.method === 'POST'
    ? Response.json({ id, delivery: 'uncertain' }, { status: 502 }) : list(draft())));
  render(<CosDraftsCard visible />);
  fireEvent.click(await screen.findByRole('button', { name: /Approve and send/ }));
  expect(await screen.findByText('Send failed; check the channel before retrying.')).toBeInTheDocument();
});

it('renders nothing when the route is not in this build', async () => {
  const fetcher = vi.fn(async () => Response.json({ error: 'not found' }, { status: 404 }));
  vi.stubGlobal('fetch', fetcher);
  const view = render(<CosDraftsCard visible />);
  await waitFor(() => expect(fetcher).toHaveBeenCalled());
  await new Promise(resolve => setTimeout(resolve, 20));
  expect(view.container).toBeEmptyDOMElement();
});

it('renders nothing with zero pending drafts', async () => {
  const fetcher = vi.fn(async () => list(draft({ delivery: 'sent' })));
  vi.stubGlobal('fetch', fetcher);
  const view = render(<CosDraftsCard visible />);
  await waitFor(() => expect(fetcher).toHaveBeenCalled());
  await new Promise(resolve => setTimeout(resolve, 20));
  expect(view.container).toBeEmptyDOMElement();
});

it('shows a check-the-channel note and no button for uncertain and sending rows', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => list(draft({ delivery: 'uncertain' }), draft({ id: `cos-${'2'.repeat(32)}`, delivery: 'sending' }))));
  render(<CosDraftsCard visible />);
  expect(await screen.findByText('Delivery is uncertain; check the channel.')).toBeInTheDocument();
  expect(screen.getByText(/check the channel before doing anything else/)).toBeInTheDocument();
  expect(screen.queryByRole('button')).toBeNull();
});
