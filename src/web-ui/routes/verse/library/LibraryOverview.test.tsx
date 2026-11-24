import { useState } from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { evictAll } from '../../../data/cache.js';
import { stubSurfaceFetch } from '../command/fetch-stub.test-support.js';
import { LibraryOverview } from './LibraryOverview.js';
const auth = vi.hoisted(() => ({ token: 'test-token' as string | null, remote: false }));
vi.mock('../../../data/auth-store.js', async original => ({ ...await original<object>(), getMutationToken: () => auth.token, getReadClientProof: () => 'test-read-proof' }));
vi.mock('../../../data/remote-mode.js', () => ({ isRemoteMobileMode: () => auth.remote }));
const asOf = '2026-11-17T12:00:00.000Z';
const items = ['file', 'media', 'memory', 'message', 'context'].map(kind => ({ id: kind, kind, title: `${kind} title`, source: `${kind}/source`, asOf, preview: `${kind} preview` }));
const snapshot = { v: 1, asOf, items, unavailable: [] };
const stub = (body: unknown = snapshot) => stubSurfaceFetch({ routes: { '/api/verse/fleet/library-files/items': body } });
function Subject() {
  const [search, onSearch] = useState('');
  return <LibraryOverview visible search={search} onSearch={onSearch} />;
}
beforeEach(() => { evictAll(); auth.token = 'test-token'; auth.remote = false; });
afterEach(() => vi.unstubAllGlobals());
it('renders every kind with source and as-of time; tabs and one search narrow the same items', async () => {
  const { fetchMock } = stub(); render(<Subject />);
  const list = await screen.findByRole('list', { name: 'Library items' });
  expect(fetchMock).toHaveBeenCalledWith('/api/verse/fleet/library-files/items', expect.objectContaining({ credentials: 'same-origin',
    headers: { 'x-ashlr-read-client': 'test-read-proof', 'x-ashlr-token': 'test-token' } }));
  expect(within(list).getAllByRole('listitem')).toHaveLength(5);
  for (const item of items) expect(list).toHaveTextContent(`${item.title}${item.preview}${item.source}`);
  expect(list.querySelector('time')).toHaveAttribute('datetime', asOf);
  for (const [label, kind] of [['Files', 'file'], ['Media', 'media'], ['Memory', 'memory'], ['Messages', 'message'], ['Context', 'context']]) {
    fireEvent.click(screen.getByRole('tab', { name: label }));
    expect(within(list).getAllByRole('listitem')).toHaveLength(1);
    expect(list).toHaveTextContent(`${kind} title`);
  }
  fireEvent.click(screen.getByRole('tab', { name: 'All' }));
  expect(screen.getAllByRole('searchbox')).toHaveLength(1);
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'MEMORY source' } });
  expect(within(list).getAllByRole('listitem')).toHaveLength(1);
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'no match' } });
  expect(screen.getByText('No Library items match.')).toBeInTheDocument();
});
it.each(['locked', 'remote'])('does not fetch protected media metadata when %s', async mode => {
  const { fetchMock } = stub(); auth.token = mode === 'locked' ? null : 'test-token'; auth.remote = mode === 'remote';
  render(<Subject />);
  expect(await screen.findByText(/Library could not refresh/)).toBeInTheDocument();
  expect(fetchMock).not.toHaveBeenCalled();
});
it('retries a failed read without reopening Library', async () => {
  let ready = false;
  stub(() => new Response(JSON.stringify(ready ? snapshot : {}))); render(<Subject />);
  const retry = await screen.findByRole('button', { name: 'Retry' });
  ready = true; fireEvent.click(retry);
  expect(await screen.findByRole('list', { name: 'Library items' })).toBeInTheDocument();
});
it('scrubs complete source text before rendering and treats markup as plain text', async () => {
  const secret = 'ghp_' + 'synthetic'.repeat(6);
  stub({ ...snapshot, items: [{ ...items[0], title: `<b>${secret}</b>`, source: secret, preview: `Saved ${secret}` }] });
  const { container } = render(<Subject />);
  expect(await screen.findByText('<b>[REDACTED]</b>')).toBeInTheDocument();
  expect(container.textContent).not.toContain(secret);
  expect(container.querySelector('b')).toBeNull();
});
it.each([
  { body: { ...snapshot, items: [] }, message: 'Your Library is empty.' },
  { body: { ...snapshot, items: [], unavailable: ['Messages'] }, message: 'Some sources are unavailable: Messages.' },
  { body: { v: 1, items: 'invalid' }, message: 'Library could not refresh.' },
])('distinguishes empty, partial and malformed responses: $message', async ({ body, message }) => {
  stub(body); render(<Subject />);
  expect(await screen.findByText(text => text.startsWith(message))).toBeInTheDocument();
  if (message !== 'Your Library is empty.') expect(screen.queryByText(/Your Library is empty/)).toBeNull();
});
