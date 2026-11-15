import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { evictAll } from '../../../data/cache.js';
import { clearMutationToken, setMutationToken } from '../../../data/auth-store.js';
import { UnifiedInboxCard } from './UnifiedInboxCard.js';
import { NEEDS_YOU_RESOLVE_PATH } from './needs-you-resolve.js';

const healthy = { state: 'healthy', pending: 0 };
function stub(status = 200) {
  const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url) === NEEDS_YOU_RESOLVE_PATH && init?.method === 'POST') return Response.json({ status: 'resolved' }, { status });
    return Response.json({ schema: 'comms.unified-inbox.v1', generatedAt: new Date().toISOString(), total: 1, omitted: 0,
      sources: { 'needs-you': healthy, imessage: healthy, drafts: healthy, bus: healthy },
      items: [{ id: 'needs-you:n-1', source: 'needs-you', kind: 'needs-you', title: 'Waiting item', severity: 'info', blocking: false, since: null, expiresAt: null, act: [] }] });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}
const inboxFetches = (mock: ReturnType<typeof stub>) => mock.mock.calls.filter(([url]) => String(url).startsWith('/api/verse/comms/inbox')).length;
beforeEach(() => { evictAll(); setMutationToken('a'.repeat(64)); });
afterEach(() => { cleanup(); clearMutationToken(); vi.unstubAllGlobals(); });

it.each(['', 'on it'])('posts the ledger id and optional reply %s', async reply => {
  const mock = stub();
  render(<UnifiedInboxCard visible />);
  const input = await screen.findByLabelText('Reply for this Needs-you item');
  fireEvent.change(input, { target: { value: reply } });
  fireEvent.click(screen.getByRole('button', { name: 'Resolve' }));
  expect(await screen.findByText('Resolved.')).toBeInTheDocument();
  const post = mock.mock.calls.find(([, init]) => init?.method === 'POST');
  expect(String(post?.[0])).toBe(NEEDS_YOU_RESOLVE_PATH);
  expect(JSON.parse(String(post?.[1]?.body))).toEqual(reply ? { itemId: 'n-1', reply } : { itemId: 'n-1' });
  expect(input).toHaveValue('');
});

it('keeps the reply and refetches on conflict', async () => {
  const mock = stub(409);
  render(<UnifiedInboxCard visible />);
  const input = await screen.findByLabelText('Reply for this Needs-you item');
  const before = inboxFetches(mock);
  fireEvent.change(input, { target: { value: 'keep me' } });
  fireEvent.click(screen.getByRole('button', { name: 'Resolve' }));
  expect(await screen.findByText('Already resolved.')).toBeInTheDocument();
  expect(input).toHaveValue('keep me');
  await waitFor(() => expect(inboxFetches(mock)).toBeGreaterThan(before));
});

it('does not post without a token', async () => {
  clearMutationToken();
  const mock = stub();
  render(<UnifiedInboxCard visible />);
  await screen.findByLabelText('Reply for this Needs-you item');
  fireEvent.click(screen.getByRole('button', { name: 'Resolve' }));
  expect(await screen.findByText('Unlock to resolve.')).toBeInTheDocument();
  expect(mock.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
});
