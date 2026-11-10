import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { evictAll } from '../../../data/cache.js';
import { clearMutationToken, setMutationToken } from '../../../data/auth-store.js';
import { UnifiedInboxCard } from './UnifiedInboxCard.js';
import { LINKEDIN_ANSWERED_PATH } from './linkedin-answered.js';

const healthy = { state: 'healthy', pending: 0 };
const row = (id: string, source: string, kind: string) => ({ id, source, kind, title: `Item ${id}`, severity: 'info', blocking: false, since: null, expiresAt: null, act: [] });
function stub(status = 200) {
  const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url) === LINKEDIN_ANSWERED_PATH && init?.method === 'POST') return Response.json({ v: 1, outcome: 'marked' }, { status });
    return Response.json({ schema: 'comms.unified-inbox.v1', generatedAt: new Date().toISOString(), total: 2, omitted: 0,
      sources: { 'needs-you': healthy, imessage: healthy, drafts: healthy, bus: healthy, linkedin: healthy },
      items: [row('linkedin:fake-msg-1', 'linkedin', 'linkedin-message'), row('bus:fake-work', 'bus', 'bus-work')] });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}
const inboxFetches = (mock: ReturnType<typeof stub>) => mock.mock.calls.filter(([url]) => String(url).startsWith('/api/verse/comms/inbox') && !String(url).includes('/linkedin/')).length;
beforeEach(() => { evictAll(); setMutationToken('a'.repeat(64)); });
afterEach(() => { cleanup(); clearMutationToken(); vi.unstubAllGlobals(); });

it('shows Mark answered only on the LinkedIn row and posts its id, then refetches', async () => {
  const mock = stub();
  render(<UnifiedInboxCard visible />);
  const button = await screen.findByRole('button', { name: 'Mark answered' });
  expect(screen.getAllByRole('button', { name: 'Mark answered' })).toHaveLength(1);
  const before = inboxFetches(mock);
  fireEvent.click(button);
  await waitFor(() => expect(mock.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(true));
  const post = mock.mock.calls.find(([, init]) => init?.method === 'POST');
  expect(String(post?.[0])).toBe(LINKEDIN_ANSWERED_PATH);
  expect(JSON.parse(String(post?.[1]?.body))).toEqual({ id: 'fake-msg-1' });
  await waitFor(() => expect(inboxFetches(mock)).toBeGreaterThan(before));
});

it('shows an inline error on failure', async () => {
  stub(503);
  render(<UnifiedInboxCard visible />);
  fireEvent.click(await screen.findByRole('button', { name: 'Mark answered' }));
  expect(await screen.findByText('Could not mark answered. Try again.')).toBeInTheDocument();
});

it('does not post without a token', async () => {
  clearMutationToken();
  const mock = stub();
  render(<UnifiedInboxCard visible />);
  fireEvent.click(await screen.findByRole('button', { name: 'Mark answered' }));
  expect(await screen.findByText('Unlock to mark answered.')).toBeInTheDocument();
  expect(mock.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
});
