import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { evictAll } from '../../../data/cache.js';
import { clearMutationToken, setMutationToken } from '../../../data/auth-store.js';
import { UnifiedInboxCard } from './UnifiedInboxCard.js';
import { TEAMMATE_REPLY_PATH, teammateReplyOutcome, teammateRowid } from './teammate-reply-model.js';

const base = { severity: 'info', blocking: false, since: new Date(Date.now() - 600_000).toISOString(), expiresAt: null, act: ['phm fleet teammate-texts'] };
const teammate = { ...base, id: 'imessage:teammate-42', source: 'imessage', kind: 'teammate-text', title: 'fake teammate text' };
const needsYou = { ...base, id: 'needs-you:n-1', source: 'needs-you', kind: 'needs-you', title: 'fake needs-you line' };
const healthy = { state: 'healthy', pending: 0 };
const inbox = () => Response.json({
  schema: 'comms.unified-inbox.v1', generatedAt: new Date().toISOString(), total: 2, omitted: 0,
  sources: { 'needs-you': healthy, imessage: healthy, drafts: healthy, bus: healthy }, items: [teammate, needsYou],
});

function stub(replyStatus: number, replyBody: unknown) {
  const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) =>
    String(url).startsWith(TEAMMATE_REPLY_PATH) && init?.method === 'POST' ? Response.json(replyBody, { status: replyStatus }) : inbox());
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}
const inboxFetches = (m: ReturnType<typeof stub>) => m.mock.calls.filter(([u]) => String(u).startsWith('/api/verse/comms/inbox')).length;

beforeEach(() => { evictAll(); setMutationToken('a'.repeat(64)); });
afterEach(() => { cleanup(); clearMutationToken(); vi.unstubAllGlobals(); });

it('renders the input and Send for a teammate row only', async () => {
  stub(200, {});
  render(<UnifiedInboxCard visible />);
  await screen.findByText('fake teammate text');
  expect(screen.getAllByLabelText('Reply to this teammate')).toHaveLength(1);
  expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
  expect(screen.getAllByText('phm fleet teammate-texts')).toHaveLength(2); // CopyPill kept on both rows
});

it('posts { rowid, text } and on 200 clears the input and refetches', async () => {
  const fetchMock = stub(200, { v: 1, status: 'sent', rowid: 42 });
  render(<UnifiedInboxCard visible />);
  const input = await screen.findByLabelText('Reply to this teammate');
  const before = inboxFetches(fetchMock);
  fireEvent.change(input, { target: { value: 'on it' } });
  fireEvent.click(screen.getByRole('button', { name: 'Send' }));
  expect(await screen.findByText('Sent.')).toBeInTheDocument();
  const post = fetchMock.mock.calls.find(([, init]) => init?.method === 'POST');
  expect(String(post?.[0])).toBe(TEAMMATE_REPLY_PATH);
  expect(JSON.parse(String(post?.[1]?.body))).toEqual({ rowid: 42, text: 'on it' });
  expect(input).toHaveValue('');
  await waitFor(() => expect(inboxFetches(fetchMock)).toBeGreaterThan(before));
});

it('on 202 keeps the text and says the status is unknown', async () => {
  stub(202, { v: 1, status: 'uncertain' });
  render(<UnifiedInboxCard visible />);
  const input = await screen.findByLabelText('Reply to this teammate');
  fireEvent.change(input, { target: { value: 'on it' } });
  fireEvent.click(screen.getByRole('button', { name: 'Send' }));
  expect(await screen.findByText('Sent status unknown; check Messages before sending again.')).toBeInTheDocument();
  expect(input).toHaveValue('on it');
});

it('on 403 keeps the text and says the teammate is not allowed', async () => {
  stub(403, { v: 1, status: 'refused' });
  render(<UnifiedInboxCard visible />);
  const input = await screen.findByLabelText('Reply to this teammate');
  fireEvent.change(input, { target: { value: 'on it' } });
  fireEvent.click(screen.getByRole('button', { name: 'Send' }));
  expect(await screen.findByText('Not sent: this teammate is not allowed by your comms settings.')).toBeInTheDocument();
  expect(input).toHaveValue('on it');
});

it('teammateRowid and teammateReplyOutcome narrow strictly', () => {
  expect(teammateRowid({ id: 'imessage:teammate-42', kind: 'teammate-text' })).toBe(42);
  expect(teammateRowid({ id: 'imessage:teammate-42', kind: 'needs-you' })).toBeNull();
  expect(teammateRowid({ id: 'imessage:teammate-0', kind: 'teammate-text' })).toBeNull();
  expect(teammateRowid({ id: 'imessage:teammate-4x', kind: 'teammate-text' })).toBeNull();
  expect(teammateReplyOutcome(404, null)).toBe('That text was already answered.');
  expect(teammateReplyOutcome(500, null)).toBe('Could not send. Try again.');
});
